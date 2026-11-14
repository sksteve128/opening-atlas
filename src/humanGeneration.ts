import { createExploration } from './exploreVariations'
import { aggressiveCandidate } from './aggressiveGeneration'
import { selectCastlingMove, castlingSummary } from './castlingPreference'
import { Chess } from 'chess.js'
import { identity, isMyTurn, nextFen, total, type ExplorerData } from './core'
import { reusableAnalysis, type SearchInfo, type Evaluation } from './engine'
import { continuationsAt, lineFen, tablebaseOutcome, tablebaseSupported, type Generation, type HumanEvidence, type LineMove, type Sources, type Variation } from './learning'
import { styledCandidate } from './generationStyle'
import { estimateFastSharpness } from './sharpness'

const legal = (fen: string) => new Chess(fen).moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''))
const count = (m: { white: number; draws: number; black: number }) => m.white + m.draws + m.black
export function humanDistribution(fen: string, data?: ExplorerData, minPosition = 20, minMove = 5) {
  const valid = (m: { white: number; draws: number; black: number }) => [m.white, m.draws, m.black].every(n => Number.isSafeInteger(n) && n >= 0)
  if (!data || data.source === 'book' || !valid(data) || total(data) < Math.max(1, minPosition)) return undefined
  const allowed = new Set(legal(fen)), seen = new Set<string>()
  const moves = data.moves.filter(m => {
    if (!valid(m) || seen.has(m.uci) || !allowed.has(m.uci)) return false
    seen.add(m.uci)
    return count(m) >= Math.max(1, minMove)
  })
  const games = moves.reduce((sum, m) => sum + count(m), 0)
  if (!games || games > total(data)) return undefined
  return { moves: moves.map(m => ({ ...m, probability: count(m) / games, mass: count(m) / total(data) })), games, omittedMass: 1 - games / total(data) }
}
export function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => { state += 0x6D2B79F5; let t = Math.imul(state ^ state >>> 15, 1 | state); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}

// ponytail: mixed-radix ranks spread jobs through common human branches without
// changing Stockfish's choices or the underlying probability evidence.
export function batchOpponentChoice<T extends { probability: number }>(moves: T[], options: Generation, place: number): T | undefined {
  if (options.batchIndex === undefined || moves.length < 2) return undefined
  const choices = [...moves].sort((a, b) => b.probability - a.probability).slice(0, 6)
  return choices[Math.floor((options.batchIndex + ((options.batchAttempt || 1) - 1) * 7) / place) % choices.length]
}
export function sampleHuman<T extends { probability: number }>(moves: T[], random: () => number) {
  if (!moves.length) throw new Error('No eligible human moves')
  let value = random()
  for (const move of moves) { value -= move.probability; if (value < 0) return move }
  return moves[moves.length - 1]
}
// Stockfish's own WDL model, from the side-to-move perspective. No cp-to-win-probability conversion.
export function expectedScore(entry: Evaluation, mine: boolean) {
  const wdl = entry.wdl
  if (!wdl || wdl.some(n => !Number.isFinite(n) || n < 0) || wdl.reduce((a, b) => a + b, 0) !== 1000) return undefined
  const value = (wdl[0] + wdl[1] / 2) / 1000
  return mine ? value : 1 - value
}
export function expectedBounds(branches: { mass: number; utility: number }[]) {
  const coverage = branches.reduce((n, b) => n + b.mass, 0)
  const lower = branches.reduce((n, b) => n + b.mass * b.utility, 0)
  return { coverage, lower, upper: lower + Math.max(0, 1 - coverage), utility: coverage ? lower / coverage : undefined }
}

const pieceValue = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 }
function material(game: Chess, color: 'w' | 'b') {
  return game.board().flat().reduce((sum, piece) => sum + (piece ? pieceValue[piece.type] * (piece.color === color ? 1 : -1) : 0), 0)
}

export function verificationReasons(fen: string, entries: Evaluation[], previousCp?: number) {
  const game = new Chess(fen), color = game.turn(), reasons: string[] = []
  if (game.isCheck()) reasons.push('king in check')
  if (previousCp !== undefined && Math.abs(entries[0].cp - previousCp) >= 100) reasons.push('large evaluation swing')
  if (entries.some(entry => entry.mate !== undefined)) reasons.push('mate sequence')
  const king = game.board().flat().find(piece => piece?.type === 'k' && piece.color === color)!
  const enemyQueen = game.board().flat().some(piece => piece?.type === 'q' && piece.color !== color)
  const shield = game.board().flat().filter(piece => piece?.type === 'p' && piece.color === color && Math.abs(piece.square.charCodeAt(0) - king.square.charCodeAt(0)) <= 1 && Number(piece.square[1]) - Number(king.square[1]) === (color === 'w' ? 1 : -1)).length
  if (enemyQueen && shield === 0) reasons.push('exposed king')
  const before = material(game, color)
  let forcing = 0
  for (const uci of entries[0].line.slice(0, 4)) {
    try {
      const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
      if (move.captured || /[+#]/.test(move.san)) forcing++
      if (game.turn() === color && before - material(game, color) >= 100) reasons.push('material sacrifice')
    } catch { reasons.push('incomplete principal variation'); break }
  }
  if (forcing >= 2) reasons.push('tactical sequence')
  return [...new Set(reasons)]
}

export async function generateHumanRepertoire(options: Generation, lines: Variation[], sources: Sources, signal?: AbortSignal, progress?: (phase: string, draft?: Variation) => void): Promise<Variation> {
  const started = Date.now(), budgetMs = Math.max(1, options.maxMs ?? 180000), deadline = started + budgetMs
  const budget = AbortSignal.timeout(Math.floor(budgetMs)), active = signal ? AbortSignal.any([signal, budget]) : budget
  const routine = Math.max(16, Math.min(18, options.engineDepth))
  const deep = Math.max(routine + 2, options.verificationDepth ?? 20), timeout = options.engineTimeoutMs ?? 30000
  const reserve = Math.min(timeout, budgetMs * .2)
  const root = lineFen({ startFen: options.startFen, moves: options.prefix })
  if (options.rootFen && options.rootFen !== root) throw new Error('Displayed board and move history disagree.')
  const game = new Chess(root), moves = [...options.prefix], id = options.resume?.id ?? crypto.randomUUID()
  const seed = options.seed === undefined ? crypto.getRandomValues(new Uint32Array(1))[0] : options.seed >>> 0, random = seededRandom(seed)
  const explore = createExploration(options, lines, seed)
  const evidence: HumanEvidence = { seed, policy: options.humanPolicy ?? 'simulation', minPositionGames: Math.max(1, options.minPositionGames ?? 20), minMoveGames: Math.max(1, options.minMoveGames ?? 5), status: 'GENERATING', stopReason: '', decisions: [] }
  const performance = { phases: { candidates: 0, human: 0, sharpness: 0, stability: 0, adaptive: 0, verification: 0 }, searches: 0, engineCacheHits: 0, sharpnessCacheHits: 0, searchDetails: [] as (SearchInfo & { phase: string })[] }
  type Phase = keyof typeof performance.phases
  const info: NonNullable<Variation['recommendation']> = { verification: 'pending', verificationScope: 'adaptive', verifiedMoves: 0, preliminary: true, configuration: { candidateDepth: routine, verificationDepth: deep, timeoutMs: timeout }, performance }
  const failedSearches = new Map<string, Error>()
  const cache = new Map<string, Evaluation[]>(), humanCache = new Map<string, ExplorerData>()
  let preliminaryMoves = !!(options.resume && options.prefix.length && options.resume.recommendation?.verification !== 'passed')
  let verificationIncomplete = false
  let fallback = false, previousCp: number | undefined, nextAdvantageCheck = 0, advantageIncomplete = false, batchPlace = 1
  let tablebase: Variation['tablebase']
  let lastUser: { fen: string; entry: Evaluation } | undefined
  const check = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); if (budget.aborted || Date.now() >= deadline) throw new Error('Computation budget exhausted') }
  const cpFor = (fen: string, entry: Evaluation) => entry.cp * (isMyTurn(fen, options.side) ? 1 : -1)
  const evaluate = async (fen: string, n: number, depth: number, phase: Phase, restrict?: string[]) => {
    check()
    const at = Date.now(), stabilityRemaining = deadline - Date.now()
    if (phase === 'stability' && stabilityRemaining <= 0) throw new Error('Bounded stability budget exhausted')
    const key = `${fen}|${n}|${depth}|${restrict?.join(',') || ''}`
    if (failedSearches.has(key)) throw failedSearches.get(key)!
    const allowed = legal(fen).filter(move => !restrict || restrict.includes(move))
    const validate = (result: Evaluation[], discovery = false) => {
      const entries = result.filter(e => (e.depth >= depth || discovery && e.search?.multiPVComplete && e.depth > 0) && Number.isFinite(e.cp) && allowed.includes(e.line[0])).sort((a, b) => b.cp - a.cp)
      if (entries.length !== Math.min(n, allowed.length) || new Set(entries.map(e => e.depth)).size !== 1 || new Set(entries.map(e => e.line[0])).size !== entries.length) throw new Error('Incomplete Stockfish analysis')
      return entries
    }
    try {
      const saved = reusableAnalysis(cache, fen, n, depth, restrict) || (!restrict && sources.cached?.(fen, n, depth))
      if (saved) {
        try { if (phase !== 'candidates' && saved.some(e => e.search?.stoppedByBudget)) throw new Error('Fresh verification required'); const entries = validate(saved); performance.engineCacheHits++; sources.onCacheHit?.('engine'); return entries }
        catch { /* Incompatible or incomplete cache entries require a fresh bounded search. */ }
      }
      performance.searches++
      const remaining = deadline - Date.now()
      const turnsLeft = Math.max(1, Math.ceil((options.maxPlies - (moves.length - options.prefix.length)) / 2))
      // Routine searches share remaining time; required checks may use the configured timeout.
      const allowance = phase === 'candidates' ? Math.max(1, (remaining - reserve) / turnsLeft) : remaining
      const result = await sources.analyze(fen, n, depth, active, Math.max(1, Math.min(timeout, allowance, phase === 'stability' ? stabilityRemaining : Infinity, remaining)), false, restrict)
      if (result[0]?.search) performance.searchDetails.push({ ...result[0].search, phase })
      if (phase !== 'candidates' && result.some(e => e.depth < depth || e.search?.stoppedByBudget)) throw new Error(`Verification budget expired: requested depth ${depth}, achieved ${result[0]?.depth ?? 0}`)
      const validated = validate(result, phase === 'candidates')
      cache.set(`${fen}|${n}|${Math.min(...result.map(e => e.depth))}|${restrict?.join(',') || ''}`, validated)
      check()
      return validated
    } catch (error) {
      const failure = /Search budget expired/.test((error as Error).message) ? new Error(`${phase === 'candidates' ? 'Routine search' : 'Verification'} budget expired: no complete analysis`) : error as Error
      if (phase !== 'candidates') verificationIncomplete = true
      failedSearches.set(key, failure); throw failure
    }
    finally { performance.phases[phase] += Date.now() - at }
  }
  const sharpness = (fen: string, entries: Evaluation[]) => {
    const at = Date.now(), color = new Chess(fen).turn() === 'w' ? 'white' : 'black'
    const cached = sources.fastSharpness?.(fen)
    const saved = cached?.fen === fen && !cached[`${color}Projected`] && (cached[color]?.depth ?? 0) >= (entries.length ? Math.min(...entries.map(entry => entry.depth)) : 0) ? cached[color] : undefined
    if (saved) performance.sharpnessCacheHits++
    const estimate = saved || estimateFastSharpness(fen, entries)
    performance.phases.sharpness += Date.now() - at
    return estimate
  }
  const human = async (fen: string) => {
    check()
    if (humanCache.has(fen)) { sources.onCacheHit?.('explorer'); return humanCache.get(fen) }
    const at = Date.now()
    try { const data = await sources.explorer(fen, options.filters, active, options.database); check(); humanCache.set(fen, data); return data }
    catch (error) { check(); if (signal?.aborted) throw error; return undefined }
    finally { performance.phases.human += Date.now() - at }
  }
  const snapshot = (): Variation => {
    const replay = new Chess(options.startFen)
    for (const m of moves) replay.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] })
    return { ...options.resume, ...explore.metadata, ...castlingSummary(options, moves), aggressive: options.aggressive, style: options.style ?? 'best', styleToleranceCp: options.styleToleranceCp ?? 30, tablebase, id, name: options.resume?.name ?? options.opening + ' — human continuation', opening: options.opening, startFen: options.startFen, moves: [...moves], pgn: replay.pgn(), side: options.side, database: options.database, filters: options.filters, created: options.resume?.created ?? started, stats: options.resume?.stats ?? { firstTry: 0, errors: 0, reveals: 0, completions: 0, totalMs: 0 }, endPosition: identity(game.fen()), parentId: options.parentId, fallback, generationMode: options.playMode, advantageCp: options.advantageCp ?? 150, engineFallback: !!options.engineFallback, engineConfig: { depth: routine, timeoutMs: timeout }, status: tablebase ? 'instructional' : info.stopKind === 'advantage' && info.verification === 'passed' ? 'favorable' : info.stopKind === 'terminal' && info.verification === 'passed' ? 'complete' : info.stopKind === 'length' && info.verification === 'passed' ? 'instructional' : 'incomplete', termination: evidence.stopReason, human: { ...evidence, decisions: [...evidence.decisions] }, recommendation: { ...info, performance: { ...performance, phases: { ...performance.phases } } } }
  }
  const stableAdvantage = async (fen: string) => {
    progress?.('Confirming advantage and bounded stability…')
    const target = options.advantageCp ?? 150, entries = await evaluate(fen, 3, deep, 'stability')
    info.objectiveCp = cpFor(fen, entries[0]); info.depth = deep
    if (info.objectiveCp < target) return false
    let minimum = info.objectiveCp, choices: number | undefined, stable = true
    const inspect = (position: string, values: Evaluation[]) => {
      const estimate = sharpness(position, values)
      const acceptable = values.filter(e => cpFor(position, e) >= target).length
      choices = Math.min(choices ?? Infinity, acceptable)
      minimum = Math.min(minimum, cpFor(position, values[0]))
      info.userDifficulty = estimate?.score
      return !!estimate && acceptable >= Math.min(2, legal(position).length) && estimate.score <= (options.stabilityPreference === 'balanced' ? 80 : 60) && !verificationReasons(position, values).length
    }
    let opponentFen = fen, defenses = entries
    if (isMyTurn(fen, options.side)) {
      stable = inspect(fen, entries)
      opponentFen = nextFen(fen, entries[0].line[0])
      if (new Chess(opponentFen).isGameOver()) return false
      defenses = await evaluate(opponentFen, 3, deep, 'stability')
    }
    info.opponentDifficulty = sharpness(opponentFen, defenses)?.score
    // ponytail: two strongest defenses bound routine stability; explicit deep re-verification remains available.
    for (const defense of defenses.slice(0, 2)) {
      const after = nextFen(opponentFen, defense.line[0])
      if (new Chess(after).isGameOver()) { stable = false; continue }
      stable = inspect(after, await evaluate(after, 3, deep, 'stability')) && stable
    }
    info.practicalChoices = choices; info.objectiveStabilityCp = minimum
    return stable && minimum >= target
  }
  const verifyMove = async (fen: string, entry: Evaluation, reasons: string[]) => {
    if (!reasons.length) return entry
    progress?.('Deep verification: ' + reasons.join(', ') + '…')
    info.criticalPoints = (info.criticalPoints ?? 0) + 1
    const best = (await evaluate(fen, 1, deep, 'adaptive'))[0]
    const picked = best.line[0] === entry.line[0] ? best : (await evaluate(fen, 1, deep, 'adaptive', [entry.line[0]]))[0]
    if (picked.cp < -300 || best.cp - picked.cp > (reasons.includes('style alternative') ? Math.min(options.tolerance, options.styleToleranceCp ?? 30) : options.tolerance)) {
      if (best.cp < -300) throw new Error('No objectively sound user move after deep verification')
      evidence.repair = 'Replaced earliest unsound user decision before generating its dependent suffix.'
      return best
    }
    return picked
  }
  const verifyEarlier = async (currentCp: number) => {
    if (!lastUser || currentCp >= lastUser.entry.cp - 100) return
    const checked = await verifyMove(lastUser.fen, lastUser.entry, ['inconsistent evaluations'])
    if (checked.line[0] !== lastUser.entry.line[0]) {
      evidence.repair = undefined
      info.verification = 'failed'; info.verifiedMoves = Math.max(0, (info.verifiedMoves ?? 0) - 1); lastUser = undefined
      throw new Error('An earlier user decision failed deeper verification; dependent moves remain unverified')
    }
    lastUser.entry = checked
  }
  info.stopKind = 'length' 
  try {
    for (let ply = 0; ply < options.maxPlies && !game.isGameOver(); ply++) {
      check()
      if (deadline - Date.now() <= reserve && moves.length > options.prefix.length) { info.stopKind = 'budget'; break }
      const fen = game.fen(), mine = isMyTurn(fen, options.side)
      if (sources.tablebase && tablebaseSupported(fen)) {
        try {
          tablebase = tablebaseOutcome(fen, await sources.tablebase(fen, AbortSignal.any([active, AbortSignal.timeout(1500)])), options.side)
          check()
          if (tablebase) { info.stopKind = 'terminal'; evidence.status = 'TABLEBASE RESULT'; evidence.stopReason = `${tablebase.label}${tablebase.winner ? ` — ${tablebase.winner === 'white' ? 'White' : 'Black'} wins` : ' — theoretical draw'}.`; info.reason = evidence.stopReason; return snapshot() }
        } catch { check() }
      }
      let exploration: LineMove['exploration'], castling: LineMove['castling'], aggressive: LineMove['aggressive']
      let chosen: string, entry: Evaluation | undefined, data: ExplorerData | undefined, sampled: LineMove['sampling']
      if (mine) {
        progress?.('Selecting a sound Stockfish move…')
        const entries = await evaluate(fen, 3, routine, 'candidates')
        await verifyEarlier(entries[0].cp)
        const candidates = entries.filter(e => entries[0].cp - e.cp <= options.tolerance && e.cp >= -300)
        if (!candidates.length) throw new Error('No objectively sound user move')
        const estimate = sharpness(fen, entries)
        info.userDifficulty = estimate?.score; info.practicalChoices = estimate?.acceptable
        info.evaluationSensitivityCp = entries.every(e => e.mate === undefined) ? entries[0].cp - entries.at(-1)!.cp : undefined
        info.tacticalFragility = estimate ? 100 * estimate.serious / estimate.evaluated : undefined
        const choice = styledCandidate(fen, candidates, options.style === 'aggressive' && options.aggressive ? 'best' : options.style ?? 'best', options.styleToleranceCp ?? 30, legal(fen))
        const selected = choice?.entry ?? candidates[0]
        const reasons = verificationReasons(fen, entries, previousCp)
        entry = await verifyMove(fen, selected, selected !== candidates[0] ? [...reasons, 'style alternative'] : reasons)
        if (options.style === 'aggressive' && options.aggressive) {
          const at = Date.now()
          const result = await aggressiveCandidate(fen, entry, options, sources, legal(fen), deadline, active)
          performance.searches += result.decision.searches; performance.phases.adaptive += Date.now() - at
          entry = result.entry; aggressive = result.decision
        }
        const castle = await selectCastlingMove(fen, entry, options, (position, count, depth, _signal, _timeout, _refresh, restrict) => evaluate(position,count,depth,'adaptive',restrict), signal, entries, undefined, moves)
        const explored = castle.decision?.accepted ? {entry:castle.entry,exploration:undefined} : await explore.select(fen,castle.entry,moves,{...sources,analyze:(position,count,depth,_signal,_timeout,_refresh,restrict)=>evaluate(position,count,depth,'adaptive',restrict)},active,entries)
        entry = explored.entry; exploration = explored.exploration; castling = castle.decision
        if (aggressive && aggressive.selected !== entry.line[0]) { aggressive.selected = entry.line[0]; aggressive.rejected = true; aggressive.reason = 'Move selection chose another verified move' }
        previousCp = entry.cp; chosen = entry.line[0]
        lastUser = { fen, entry }
        if (entry.depth >= routine && !entry.search?.stoppedByBudget) info.verifiedMoves = (info.verifiedMoves ?? 0) + 1
        else preliminaryMoves = true
      } else {
        const replyEntries = reusableAnalysis(cache, fen, 3, 8) || sources.cached?.(fen, 3, 8) || []
        info.opponentDifficulty = sharpness(fen, replyEntries)?.score
        progress?.('Sampling a human opponent move…')
        data = await human(fen)
        const dist = humanDistribution(fen, data, evidence.minPositionGames, evidence.minMoveGames)
        if (!dist) {
          if (!options.engineFallback) { info.stopKind = 'human-data'; evidence.stopReason = 'Human data ended: ' + (data?.unavailableReason || 'insufficient position or move samples'); break }
          progress?.('Human data unavailable; using selected engine fallback…')
          entry = (await evaluate(fen, 1, routine, 'candidates'))[0]; chosen = entry.line[0]; fallback = true
        } else {
          const covered = new Set(continuationsAt(lines, fen, undefined, options.side).covered)
          const uncovered = dist.moves.filter(move => !covered.has(move.uci))
          const pool = evidence.policy === 'expansion' && uncovered.length ? uncovered : dist.moves
          const mass = pool.reduce((sum, move) => sum + move.probability, 0)
          const normalized = pool.map(move => ({ ...move, probability: move.probability / mass }))
          const move = batchOpponentChoice(normalized, options, batchPlace) || sampleHuman(normalized, random)
          if (options.batchIndex !== undefined && normalized.length > 1) batchPlace *= Math.min(6, normalized.length)
          chosen = move.uci
          sampled = { probability: move.probability, omittedMass: 1 - (1 - dist.omittedMass) * mass, eligibleGames: pool.reduce((sum, move) => sum + count(move), 0), policy: evidence.policy }
        }
      }
      const played = game.move({ from: chosen.slice(0, 2), to: chosen.slice(2, 4), promotion: chosen[4] })
      const humanMove = sampled && data?.moves.find(move => move.uci === chosen)
      moves.push({ exploration, castling, aggressive, uci: chosen, san: played.san, source: mine || !sampled ? 'engine' : data?.source === 'masters' ? 'masters' : 'lichess', explorerCache: sampled ? data?.cache : undefined, cp: entry?.cp, depth: entry?.depth, games: humanMove ? count(humanMove) : undefined, frequency: humanMove && data ? count(humanMove) / total(data) : undefined, sampling: sampled })
      progress?.('Continuation generated…', snapshot())
      if (mine && entry && entry.cp >= (options.advantageCp ?? 150) && moves.length >= nextAdvantageCheck && deadline - Date.now() > reserve && !game.isGameOver()) {
        nextAdvantageCheck = moves.length + 4
        try {
          const stable = await stableAdvantage(game.fen()); advantageIncomplete = false
          if (stable) { info.stopKind = 'advantage'; break }
        } catch (error) { check(); advantageIncomplete = true; evidence.stopReason = 'Advantage verification incomplete: ' + (error as Error).message }
      }
    }
    if (game.isGameOver()) info.stopKind = 'terminal'
  } catch (error) {
    if (signal?.aborted) throw error
    const message = budget.aborted || Date.now() >= deadline ? 'Computation budget exhausted' : (error as Error).message
    info.stopKind = budget.aborted || Date.now() >= deadline ? 'budget' : /timed out|Routine search budget expired/i.test(message) ? 'engine-timeout' : 'verification'
    evidence.stopReason = message
  }
  if (!game.isGameOver() && sources.tablebase && tablebaseSupported(game.fen())) {
    try {
      tablebase = tablebaseOutcome(game.fen(), await sources.tablebase(game.fen(), AbortSignal.any([active, AbortSignal.timeout(1500)])), options.side)
      if (tablebase) { info.stopKind = 'terminal'; evidence.status = 'TABLEBASE RESULT'; evidence.stopReason = `${tablebase.label}${tablebase.winner ? ` — ${tablebase.winner === 'white' ? 'White' : 'Black'} wins` : ' — theoretical draw'}.`; info.reason = evidence.stopReason; return snapshot() }
    } catch { /* Retain the previous stopping and verification policy. */ }
  }
  try {
    check()
    if (moves.length === options.prefix.length) throw new Error('No continuation was generated')
    progress?.('Checking the final position…')
    if (game.isGameOver()) info.objectiveCp = game.isCheckmate() ? isMyTurn(game.fen(), options.side) ? -100000 : 100000 : 0
    else {
      let end = (await evaluate(game.fen(), 1, routine, 'verification'))[0]
      if (moves.at(-1)?.sampling && verificationReasons(game.fen(), [end]).length) end = (await evaluate(game.fen(), 1, deep, 'adaptive'))[0]
      await verifyEarlier(cpFor(game.fen(), end))
      info.objectiveCp = cpFor(game.fen(), end); info.depth = end.depth
      if (info.objectiveCp >= (options.advantageCp ?? 150) && info.stopKind !== 'advantage') {
        const stable = await stableAdvantage(game.fen()); advantageIncomplete = false
        if (stable) info.stopKind = 'advantage'
      }
    }
    if (info.objectiveCp < -300) { info.verification = 'failed'; throw new Error('Final position is objectively poor') }
    if (preliminaryMoves || verificationIncomplete || info.stopKind === 'verification' || info.stopKind === 'engine-timeout' || advantageIncomplete) throw new Error('Required verification incomplete')
    info.verification = 'passed'
  } catch (error) {
    if (signal?.aborted) throw error
    info.verification = info.verification === 'failed' ? 'failed' : 'pending'
    evidence.stopReason += (evidence.stopReason ? '. ' : '') + (budget.aborted || Date.now() >= deadline ? 'Computation budget exhausted' : (error as Error).message)
    if (budget.aborted || Date.now() >= deadline) info.stopKind = 'budget'
    else if (/timed out/i.test((error as Error).message) && info.stopKind === 'length') info.stopKind = 'engine-timeout'
  }
  const statuses = { length: 'SOUND HUMAN CONTINUATION', budget: 'COMPUTATION BUDGET EXHAUSTED', 'human-data': 'HUMAN DATA EXHAUSTED', advantage: 'ADVANTAGE ACHIEVED', terminal: 'GAME ENDED', 'engine-timeout': 'INCOMPLETE GENERATION', verification: 'VERIFICATION INCOMPLETE' }
  evidence.status = moves.length === options.prefix.length && info.stopKind === 'human-data' ? 'HUMAN DATA UNAVAILABLE' : statuses[info.stopKind!]
  if (info.verification !== 'passed' && ['length', 'advantage', 'terminal'].includes(info.stopKind!)) evidence.status = 'VERIFICATION INCOMPLETE'
  evidence.stopReason ||= ({ length: 'Configured generation length reached', budget: 'Computation budget exhausted', 'human-data': 'Human data exhausted', advantage: 'Advantage confirmed by deeper bounded stability checks', terminal: 'Game ended', 'engine-timeout': 'Engine timed out', verification: 'Required verification incomplete' })[info.stopKind!]
  info.preliminary = info.verification !== 'passed'
  info.reason = `${evidence.status}. ${evidence.stopReason}. Difficulty estimates are preliminary and describe evaluated moves only.`
  info.ranking = options.style && options.style !== 'best' ? `Top-three Stockfish candidates; ${options.style} heuristic only among moves within ${options.styleToleranceCp ?? 30} cp. Alternatives receive deeper verification; human replies remain probability sampled.` : 'Strongest evaluated Stockfish candidate; weighted human replies. Routine decisions use complete MultiPV; tactical risks and advantages require deeper checks.'
  return snapshot()
}
