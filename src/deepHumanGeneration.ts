// Explicit exhaustive generation retained for deep analysis and regression coverage.
// Routine generation uses generateHumanRepertoire, which never expands every candidate's replies.
import { Chess } from 'chess.js'
import { identity, isMyTurn, nextFen, type ExplorerData } from './core'
import { reusableAnalysis, type Evaluation } from './engine'
import { continuationsAt, lineFen, type Generation, type HumanEvidence, type LineMove, type Sources, type Variation } from './learning'
import { assessDecision } from './sharpness'
import { humanDistribution, seededRandom, sampleHuman, expectedScore, expectedBounds } from './humanGeneration'
const legal = (fen: string) => new Chess(fen).moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''))
const count = (m: { white: number; draws: number; black: number }) => m.white + m.draws + m.black

export async function generateDeepHumanRepertoire(options: Generation, lines: Variation[], sources: Sources, signal?: AbortSignal, progress?: (phase: string, draft?: Variation) => void): Promise<Variation> {
  const started = Date.now(), deadline = started + (options.maxMs ?? 180000)
  const discovery = options.discoveryDepth ?? Math.max(14, options.engineDepth - 2)
  const depth = Math.max(options.engineDepth + 2, options.verificationDepth ?? 24)
  const timeout = options.engineTimeoutMs ?? 30000
  const generationEnd = started + (options.maxMs ?? 180000) * 0.6
  let verifying = false, phase = 'candidates'
  const root = lineFen({ startFen: options.startFen, moves: options.prefix })
  if (options.rootFen && options.rootFen !== root) throw new Error('Displayed board and move history disagree.')
  const moves = [...options.prefix], game = new Chess(root)
  const seed = options.seed === undefined ? crypto.getRandomValues(new Uint32Array(1))[0] : options.seed >>> 0
  const random = seededRandom(seed)
  const evidence: HumanEvidence = { seed, policy: options.humanPolicy ?? 'expansion', minPositionGames: Math.max(1, options.minPositionGames ?? 20), minMoveGames: Math.max(1, options.minMoveGames ?? 5), status: 'GENERATING', stopReason: '', decisions: [] }
  const cache = new Map<string, Evaluation[]>(), humanCache = new Map<string, ExplorerData>()
  const check = () => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (Date.now() >= deadline) throw new Error('Generation time budget reached')
  }
  const human = async (fen: string) => {
    check()
    if (humanCache.has(fen)) { sources.onCacheHit?.('explorer'); return humanCache.get(fen) }
    try { const data = await sources.explorer(fen, options.filters, signal, options.database); check(); humanCache.set(fen, data); return data }
    catch (error) { if (signal?.aborted) throw error; return undefined }
  }
  const distribution = (fen: string, data?: ExplorerData) => humanDistribution(fen, data, evidence.minPositionGames, evidence.minMoveGames)
  const evaluate = async (fen: string, n: number, d = discovery, fresh = false, restrict?: string[]) => {
    const at = Date.now(), stage = phase
    try {
    check()
    const cached = !fresh && reusableAnalysis(cache, fen, n, d, restrict)
    if (cached) { sources.onCacheHit?.('engine'); return cached }
    const searchDeadline = verifying ? deadline : generationEnd
    if (Date.now() >= searchDeadline) throw new Error('Candidate budget reserved for verification')
    const result = await sources.analyze(fen, n, d, signal, Math.min(timeout, searchDeadline - Date.now()), fresh, restrict)
    check()
    const allowed = legal(fen).filter(m => !restrict || restrict.includes(m))
    const entries = result.filter(e => e.depth >= d && !e.search?.stoppedByBudget && Number.isFinite(e.cp) && allowed.includes(e.line[0])).sort((a, b) => b.cp - a.cp)
    if (entries.length !== Math.min(n, allowed.length) || new Set(entries.map(e => e.line[0])).size !== entries.length) throw new Error('Incomplete Stockfish analysis')
    cache.set(`${fen}|${n}|${d}|${restrict?.join(',') || ''}`, entries)
    return entries
    } finally { sources.onTiming?.(stage, Date.now() - at) }
  }
  const cpFor = (fen: string, e: Evaluation) => e.cp * (isMyTurn(fen, options.side) ? 1 : -1)
  const decision = (fen: string, entries: Evaluation[], d: number) => { const at = Date.now(); const result = assessDecision(fen, entries, undefined, { depth: d, budgetMs: 0, excellentCp: 30, playableCp: 70, seriousCp: 150 }); sources.onTiming?.('sharpness', Date.now() - at); return result }
  const id = crypto.randomUUID()
  let info: NonNullable<Variation['recommendation']> = { verification: 'pending', configuration: { candidateDepth: options.engineDepth, discoveryDepth: discovery, verificationDepth: depth, timeoutMs: timeout } }
  const snapshot = (): Variation => {
    const replay = new Chess(options.startFen)
    for (const m of moves) replay.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] })
    return { id, name: options.opening + ' — human continuation', opening: options.opening, startFen: options.startFen, moves: [...moves], pgn: replay.pgn(), side: options.side, database: options.database, filters: options.filters, created: started, stats: { firstTry: 0, errors: 0, reveals: 0, completions: 0, totalMs: 0 }, endPosition: identity(game.fen()), parentId: options.parentId, fallback: false, generationMode: options.playMode, advantageCp: options.advantageCp ?? 150, engineFallback: false, engineConfig: { depth: options.engineDepth, timeoutMs: timeout }, status: evidence.status === 'ADVANTAGE ACHIEVED' ? 'favorable' : info.verification === 'passed' ? 'instructional' : 'incomplete', termination: evidence.stopReason, human: { ...evidence, decisions: [...evidence.decisions] }, recommendation: { ...info } }
  }
  const firstData = await human(root)
  if (!distribution(root, firstData)) {
    evidence.status = 'HUMAN DATA UNAVAILABLE'
    evidence.stopReason = firstData?.unavailableReason || 'Insufficient human games at this position. Select Engine complete game for an explicit engine-only continuation.'
    info = { ...info, verification: 'failed', reason: evidence.status + ': ' + evidence.stopReason }
    return snapshot()
  }
  // Reserve the final third for independent deeper verification. Slow searches stop generation early.
  let reason = 'Move budget reached', stable = false, repaired = false
  const stability = async (fen: string, entries: Evaluation[]) => {
    phase = 'stability'
    const target = options.advantageCp ?? 150
    let minimum = cpFor(fen, entries[0]), choices = Infinity, difficulty = 0, fragility = 0
    const inspect = (position: string, values: Evaluation[]) => {
      const sharp = decision(position, values, depth)
      const acceptable = values.filter(e => cpFor(position, e) >= target).length
      choices = Math.min(choices, acceptable)
      if (!sharp) return false
      difficulty = Math.max(difficulty, sharp.score)
      fragility = Math.max(fragility, 100 * sharp.serious / sharp.evaluated)
      minimum = Math.min(minimum, cpFor(position, values[0]))
      return acceptable >= Math.min(2, legal(position).length) && sharp.score <= (options.stabilityPreference === 'balanced' ? 80 : 60) && !new Chess(position).isCheck()
    }
    let safe = minimum >= target && !new Chess(fen).isCheck()
    const pv = new Chess(fen)
    for (const uci of entries[0].line.slice(0, 4)) {
      try { const m = pv.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); if (m.captured || /[+#]/.test(m.san)) safe = false } catch { safe = false; break }
    }
    if (isMyTurn(fen, options.side)) {
      safe = inspect(fen, entries) && safe
      if (safe) {
        const after = nextFen(fen, entries[0].line[0])
        if (!new Chess(after).isGameOver()) {
          const defenses = await evaluate(after, 4, depth)
          info.opponentDifficulty = decision(after, defenses, depth)?.score
          for (const defense of defenses.slice(0, 2)) {
            const userFen = nextFen(after, defense.line[0])
            if (new Chess(userFen).isGameOver()) { safe = false; continue }
            safe = inspect(userFen, await evaluate(userFen, 4, depth)) && safe
          }
        }
      }
    }
    else {
      // Strongest defenses plus every legal forcing reply; bounded by the global budget.
      const forcing = (minimum >= target ? new Chess(fen).moves({ verbose: true }).filter(m => m.captured || /[+#]/.test(m.san)).map(m => m.from + m.to + (m.promotion || '')) : [])
      const replies = [...new Set([...entries.slice(0, minimum >= target ? 2 : 1).map(e => e.line[0]), ...forcing])]
      for (const reply of replies) {
        const after = nextFen(fen, reply)
        if (new Chess(after).isGameOver()) { safe = false; continue }
        safe = inspect(after, await evaluate(after, 4, depth)) && safe
      }
      info.opponentDifficulty = decision(fen, entries, depth)?.score
    }
    info.userDifficulty = difficulty
    info.practicalChoices = Number.isFinite(choices) ? choices : undefined
    info.tacticalFragility = fragility
    info.objectiveStabilityCp = minimum
    return safe
  }
  try {
    for (let ply = 0; ply < options.maxPlies && !game.isGameOver(); ply++) {
      check()
      if (Date.now() >= generationEnd) { reason = 'Generation budget reserved for final verification'; break }
      const fen = game.fen(), mine = isMyTurn(fen, options.side)
      progress?.(mine ? 'Comparing sound user moves…' : 'Sampling position-specific human replies…')
      const data = await human(fen), dist = distribution(fen, data)
      if (!dist) { reason = 'Human data ended: ' + (data?.unavailableReason || 'insufficient position or move samples'); break }
      let chosen: string, entry: Evaluation | undefined, sampled: LineMove['sampling']
      if (!mine) {
        const uncovered = new Set(continuationsAt(lines, fen, undefined, options.side).covered)
        const pool = dist.moves.filter(m => !uncovered.has(m.uci))
        const move = evidence.policy === 'expansion' && pool.length
          ? [...pool].sort((a, b) => b.probability - a.probability || a.uci.localeCompare(b.uci))[0]
          : sampleHuman(dist.moves, random)
        chosen = move.uci
        sampled = { probability: move.probability, omittedMass: dist.omittedMass, eligibleGames: dist.games, policy: evidence.policy }
      } else {
        phase = 'candidates'
        const entries = await evaluate(fen, 6, options.engineDepth)
        const candidates = entries.filter(e => entries[0].cp - e.cp <= options.tolerance && e.cp >= -300).slice(0, 3)
        if (!candidates.length) { reason = 'No objectively sound user move'; break }
        const ranked: { entry: Evaluation; bound: ReturnType<typeof expectedBounds>; ease?: number; stability: number; opponent?: number }[] = []
        for (const candidate of candidates) {
          const after = nextFen(fen, candidate.line[0])
          if (new Chess(after).isGameOver()) { ranked.push({ entry: candidate, bound: expectedBounds([]), ease: 0, stability: candidate.cp, opponent: 0 }); continue }
          const replies = distribution(after, await human(after))
          phase = 'human-reply evaluation'
          const defense = await evaluate(after, 4)
          const opponent = decision(after, defense, discovery)
          const branches: { mass: number; utility: number }[] = []
          let ease = 0, measured = 0
          for (const reply of [...(replies?.moves || [])].sort((a, b) => b.mass - a.mass).slice(0, 3)) {
            const leaf = nextFen(after, reply.uci)
            if (new Chess(leaf).isGameOver()) { branches.push({ mass: reply.mass, utility: new Chess(leaf).isCheckmate() ? 0 : 0.5 }); continue }
            const values = await evaluate(leaf, 4)
            const value = expectedScore(values[0], isMyTurn(leaf, options.side))
            if (value !== undefined) branches.push({ mass: reply.mass, utility: value })
            const sharp = decision(leaf, values, discovery)
            if (sharp) { ease += reply.mass * (1 - sharp.score / 100); measured += reply.mass }
          }
          ranked.push({ entry: candidate, bound: expectedBounds(branches), ease: measured ? ease / measured : undefined, stability: cpFor(after, defense[0]), opponent: opponent?.score })
        }
        // Conservative lower bound accounts for all unknown mass; heuristics are small tie-breakers, never probabilities.
        const hasEase = ranked.every(r => r.ease !== undefined), hasOpponent = ranked.every(r => r.opponent !== undefined)
        const score = (r: typeof ranked[number]) => r.bound.lower + (hasEase ? r.ease! * .02 : 0) + (hasOpponent ? r.opponent! * (options.sharpnessPreference === 'critical' ? .0002 : .0001) : 0) + Math.max(-1, Math.min(1, r.stability / 300)) * .01
        ranked.sort((a, b) => score(b) - score(a) || b.entry.cp - a.entry.cp || a.entry.line[0].localeCompare(b.entry.line[0]))
        entry = ranked[0].entry; chosen = entry.line[0]
        evidence.decisions.push({ fen, move: chosen, ...ranked[0].bound })
        info.humanCoverage = ranked[0].bound.coverage
        info.userDifficulty = decision(fen, entries, options.engineDepth)?.score
        info.opponentDifficulty = ranked[0].opponent
      }
      const played = game.move({ from: chosen.slice(0, 2), to: chosen.slice(2, 4), promotion: chosen[4] })
      const humanMove = dist.moves.find(m => m.uci === chosen)
      moves.push({ uci: chosen, san: played.san, source: mine ? 'engine' : data?.source === 'masters' ? 'masters' : 'lichess', explorerCache: sampled ? data?.cache : undefined, cp: entry?.cp, depth: entry?.depth, games: humanMove ? count(humanMove) : undefined, frequency: humanMove?.mass, sampling: sampled })
      progress?.('Human continuation generated; checking stopping point…', snapshot())
      if (!game.isGameOver()) {
        phase = 'endpoint searches'
        const endpoint = await evaluate(game.fen(), 4)
        if (cpFor(game.fen(), endpoint[0]) >= (options.advantageCp ?? 150)) {
          const deep = await evaluate(game.fen(), 4, depth, true)
          if (await stability(game.fen(), deep)) { reason = 'Advantage threshold passed deeper stability checks'; break }
        }
      }
    }
    if (game.isGameOver()) reason = 'Game ended'
  } catch (error) {
    if (signal?.aborted) throw error
    reason = 'Continuation stopped: ' + (error as Error).message
  }
  verifying = true; phase = 'final verification'
  try {
    if (moves.length === options.prefix.length) throw new Error('No fully scored continuation was generated')
    progress?.('Independently verifying user decisions…')
    let fen = root
    for (let index = options.prefix.length; index < moves.length; index++) {
      const move = moves[index]
      if (isMyTurn(fen, options.side)) {
        const best = (await evaluate(fen, 1, depth, true))[0]
        // The unrestricted best result already proves its own selected root move.
        const picked = best.line[0] === move.uci ? best : (await evaluate(fen, 1, depth, true, [move.uci]))[0]
        if (best.cp - picked.cp > options.tolerance || picked.cp < -300) {
          if (repaired || best.cp < -300) throw new Error('Earliest unsound user decision: ' + move.san)
          repaired = true
          evidence.repair = 'Replaced earliest unsound user decision ' + move.san + '; discarded dependent suffix.'
          game.load(fen)
          const replacement = game.move({ from: best.line[0].slice(0, 2), to: best.line[0].slice(2, 4), promotion: best.line[0][4] })
          moves.splice(index, moves.length - index, { uci: best.line[0], san: replacement.san, source: 'engine', cp: best.cp, depth: best.depth })
          const retained = new Set<string>()
          let retainedFen = root
          for (const m of moves.slice(options.prefix.length, index)) { retained.add(retainedFen); retainedFen = nextFen(retainedFen, m.uci) }
          evidence.decisions = evidence.decisions.filter(d => retained.has(d.fen))
          reason = evidence.repair
          break
        }
        move.cp = picked.cp; move.depth = picked.depth
      }
      fen = nextFen(fen, move.uci)
    }
    progress?.('Checking final sharpness and stability…')
    if (game.isGameOver()) {
      info.objectiveCp = game.isCheckmate() ? isMyTurn(game.fen(), options.side) ? -100000 : 100000 : 0
      stable = info.objectiveCp > 0
    } else {
      const end = await evaluate(game.fen(), 4, depth, true)
      info.objectiveCp = cpFor(game.fen(), end[0])
      stable = await stability(game.fen(), end)
    }
    if (info.objectiveCp! < -300) throw new Error('Final position is objectively poor; no sound repair established.')
    info.verification = 'passed'; info.depth = depth
    evidence.status = stable ? 'ADVANTAGE ACHIEVED' : Math.abs(info.objectiveCp!) <= 50 ? 'SOUND HUMAN CONTINUATION' : 'PLAYABLE — NO ADVANTAGE ESTABLISHED'
  } catch (error) {
    if (signal?.aborted) throw error
    info.verification = 'failed'
    evidence.status = 'VERIFICATION FAILED'
    reason += '. ' + (error as Error).message
  }
  evidence.stopReason = reason
  info.reason = evidence.status + '. ' + reason + '. Difficulty is a heuristic, not an error probability.'
  info.ranking = 'Bounded WDL expectation: up to three replies per candidate; unknown probability mass has [0, 1] utility bounds. Only fully scored candidates compete.'
  return snapshot()
}
