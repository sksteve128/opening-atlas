import { Chess } from 'chess.js'
import { frequency, isMyTurn, nextFen, total, type ExplorerData } from './core'
import { assessDecision } from './sharpness'
import { generateVariation, lineFen, type Generation, type LineMove, type Recommendation, type Sources, type Variation } from './learning'
import { reusableAnalysis, type Evaluation } from './engine'

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const scoreFor = (fen: string, cp: number, side: Generation['side']) => cp * (isMyTurn(fen, side) ? 1 : -1)
const legalUci = (fen: string) => new Chess(fen).moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || ''))
const gameCount = (move: { white: number; draws: number; black: number }) => move.white + move.draws + move.black
const pieceValue: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 }
function material(fen: string, side: Generation['side']) {
  return new Chess(fen).board().flat().reduce((sum, piece) => sum + (piece ? pieceValue[piece.type] * (piece.color === side[0] ? 1 : -1) : 0), 0)
}
function weighted(values: { value: number; weight: number }[]) {
  const sum = values.reduce((result, item) => result + item.weight, 0)
  return sum ? values.reduce((result, item) => result + item.value * item.weight, 0) / sum : undefined
}
function factors(info: Recommendation, relevance?: number) {
  // ponytail: missing measurements drop out; this normalized heuristic is not a calibrated win probability.
  const factors: [number, number | undefined][] = [
    [0.25, info.objectiveCp === undefined ? undefined : clamp((info.objectiveCp + 100) / 400)],
    [0.15, relevance],
    [0.15, info.humanExpectedCp === undefined ? undefined : clamp((info.humanExpectedCp + 100) / 400)],
    [0.1, info.userDifficulty === undefined ? undefined : 1 - info.userDifficulty / 100],
    [0.1, info.opponentDifficulty === undefined ? undefined : info.opponentDifficulty / 100],
    [0.1, info.objectiveStabilityCp === undefined ? undefined : clamp((info.objectiveStabilityCp + 100) / 400)],
    [0.05, info.practicalChoices === undefined ? undefined : clamp(info.practicalChoices / 4)],
    [0.05, info.tacticalFragility === undefined ? undefined : 1 - info.tacticalFragility / 100],
    [0.025, info.humanCoverage === undefined ? undefined : info.humanCoverage],
    [0.025, info.depth === undefined ? undefined : clamp(info.depth / 24)],
  ]
  return factors
}

export async function generateVerifiedVariation(options: Generation, lines: Variation[], sources: Sources, signal?: AbortSignal, onProgress?: (phase: string, draft?: Variation) => void): Promise<Variation> {
  const started = Date.now(), deadline = started + (options.maxMs ?? 180000)
  const candidateDepth = Math.max(18, options.engineDepth)
  const discoveryDepth = Math.min(candidateDepth, Math.max(14, options.discoveryDepth ?? Math.max(18, candidateDepth - 2)))
  const verificationDepth = Math.max(candidateDepth + 2, options.verificationDepth ?? 24)
  const timeout = options.engineTimeoutMs ?? 25000
  const configuration = { candidateDepth, discoveryDepth, verificationDepth, timeoutMs: timeout }
  const dataCache = new Map<string, ExplorerData>()
  const evalCache = new Map<string, Evaluation[]>()
  const verificationCache = new Map<string, Evaluation[]>()
  const check = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); if (Date.now() >= deadline) throw new Error('Generation time budget reached before verification.') }
  const human = async (fen: string) => {
    if (dataCache.has(fen)) { sources.onCacheHit?.('explorer'); return dataCache.get(fen) }
    try { const data = await sources.explorer(fen, options.filters, signal, options.database); dataCache.set(fen, data); return data }
    catch (error) { if (signal?.aborted) throw error; return undefined }
  }
  const evaluate = async (fen: string, count: number, depth: number, moves?: string[], refresh = false, budget = timeout) => {
    check()
    const key = `${fen}|${count}|${depth}|${moves?.join(',') || ''}`
    const cached = !refresh && reusableAnalysis(evalCache, fen, count, depth, moves)
    if (cached) { sources.onCacheHit?.('engine'); return cached }
    const result = await sources.analyze(fen, count, depth, signal, Math.min(timeout, budget, Math.max(1, deadline - Date.now())), refresh, moves)
    const legal = new Set(legalUci(fen))
    const verified = result.filter(entry => entry.depth >= depth && !entry.search?.stoppedByBudget && legal.has(entry.line[0]))
    if (!verified.length) throw new Error(`Stockfish did not reach the required depth at ${fen}.`)
    evalCache.set(key, verified)
    return verified
  }
  const root = options.rootFen || lineFen({ startFen: options.startFen, moves: options.prefix })
  if (root !== lineFen({ startFen: options.startFen, moves: options.prefix })) throw new Error('Displayed board and move history disagree; generation stopped.')
  let prelude: LineMove[] = []
  let choiceFen = root
  onProgress?.('Finding candidate lines…')
  if (!isMyTurn(root, options.side)) {
    const data = await human(root)
    const common = data && data.source !== 'book' && total(data) >= 20 ? [...data.moves].filter(move => gameCount(move) >= 5 && legalUci(root).includes(move.uci)).sort((a, b) => gameCount(b) - gameCount(a))[0] : undefined
    if (!common && options.engineFallback === false) throw new Error('Human game data unavailable at this position; engine fallback is off.')
    const chosen = common?.uci || (await evaluate(root, 1, candidateDepth))[0].line[0]
    const played = new Chess(root).move({ from: chosen.slice(0, 2), to: chosen.slice(2, 4), promotion: chosen[4] })
    prelude = [{ uci: chosen, san: played.san, source: common ? data!.source === 'masters' ? 'masters' : 'lichess' : 'engine', games: common ? gameCount(common) : undefined, frequency: common && data ? frequency(common, data) : undefined }]
    choiceFen = nextFen(root, chosen)
  }
  const openingData = await human(choiceFen)
  if (options.engineFallback === false && (!openingData || openingData.source === 'book' || total(openingData) < 20)) throw new Error('Human game data unavailable at this position; engine fallback is off.')
  const rootAnalysis = await evaluate(choiceFen, 6, candidateDepth)
  const best = Math.max(...rootAnalysis.map(entry => entry.cp))
  const excluded = new Set(options.excludeRootMoves)
  const candidates = rootAnalysis.filter(entry => !excluded.has(entry.line[0]) && best - entry.cp <= options.tolerance).sort((a, b) => b.cp - a.cp).slice(0, 3)
  if (!candidates.length) throw new Error('No uncovered, objectively sound candidate was found.')
  const candidateStop = started + (options.maxMs ?? 180000) * 0.55
  const examined: { line: Variation; info: Recommendation; relevance?: number }[] = []
  for (const [candidateIndex, candidate] of candidates.entries()) {
    check()
    if (examined.length && Date.now() >= candidateStop) break
    const played = new Chess(choiceFen).move({ from: candidate.line[0].slice(0, 2), to: candidate.line[0].slice(2, 4), promotion: candidate.line[0][4] })
    const humanMove = openingData?.source !== 'book' ? openingData?.moves.find(move => move.uci === candidate.line[0]) : undefined
    const first: LineMove = { uci: candidate.line[0], san: played.san, source: 'engine', cp: candidate.cp, depth: candidate.depth, games: humanMove ? gameCount(humanMove) : undefined, frequency: humanMove && openingData ? frequency(humanMove, openingData) : undefined, alternatives: candidates.filter(entry => entry !== candidate).map(entry => entry.line[0]) }
    const prefix = [...options.prefix, ...prelude, first]
    const after = nextFen(choiceFen, first.uci)
    onProgress?.(`Analyzing candidate ${candidateIndex + 1} / ${candidates.length}…`)
    let line: Variation
    let scoringExpired = false
    let scoringComplete = true
    const continuationPlies = Math.max(0, Math.min(options.maxPlies - prelude.length - 1, 4))
    try {
      // Reserve part of each candidate's share for mandatory scoring. A search
      // that reaches its rollout deadline must not consume the verification reserve.
      line = await generateVariation({ ...options, engineDepth: discoveryDepth, prefix, rootFen: after, maxPlies: continuationPlies, maxMs: Math.max(1, Math.min(deadline - Date.now(), (candidateStop - Date.now()) / (candidates.length - candidateIndex) * 0.9)), mode: 'main', excludeRootMoves: [] }, lines, { ...sources, explorer: async (fen) => (await human(fen)) || { white: 0, draws: 0, black: 0, moves: [], source: 'book' }, analyze: (fen, count, depth, _signal, _timeout, refresh, moves) => evaluate(fen, count, Math.max(depth, discoveryDepth), moves, refresh, _timeout) }, signal, partial => { if (candidateIndex === 0) onProgress?.(`Building candidate ${candidateIndex + 1} / ${candidates.length}…`, { ...partial, recommendation: { verification: 'pending', configuration } }) })
    } catch (error) { if (signal?.aborted) throw error; continue }
    if (prelude.some(move => move.source === 'engine') || !openingData || openingData.source === 'book') line = { ...line, fallback: true }
    scoringComplete = line.moves.length >= prefix.length + continuationPlies || new Chess(lineFen(line)).isGameOver() || line.status === 'favorable'
    const info: Recommendation = { verification: 'pending', configuration, objectiveCp: candidate.cp, depth: candidate.depth, sampledPlies: line.moves.length - options.prefix.length - prelude.length }
    onProgress?.(`Scoring candidate ${candidateIndex + 1} / ${candidates.length}…`)
    const difficulty: { user: { value: number; weight: number }[]; opponent: { value: number; weight: number }[]; fragility: { value: number; weight: number }[] } = { user: [], opponent: [], fragility: [] }
    let fen = choiceFen, sacrificeCp = 0, materialBeforeUserMove: number | undefined
    for (const [index, move] of line.moves.slice(options.prefix.length + prelude.length, options.prefix.length + prelude.length + 5).entries()) {
      if (Date.now() >= candidateStop) { scoringExpired = true; break }
      try {
        const entries = index === 0 ? rootAnalysis : await evaluate(fen, 4, discoveryDepth)
        const decision = assessDecision(fen, entries, !isMyTurn(fen, options.side) ? await human(fen) : undefined, { depth: index === 0 ? candidateDepth : discoveryDepth, budgetMs: 0, excellentCp: 30, playableCp: 70, seriousCp: 150 })
        if (!decision) scoringComplete = false
        if (decision) {
          const mine = isMyTurn(fen, options.side)
          difficulty[mine ? 'user' : 'opponent'].push({ value: decision.score, weight: 0.8 ** index })
          if (mine) {
            info.practicalChoices = Math.min(info.practicalChoices ?? Infinity, decision.acceptable)
            difficulty.fragility.push({ value: 100 * decision.serious / decision.evaluated, weight: 0.8 ** index })
            info.criticalPoints ??= 0
            if (decision.acceptable <= 1 || decision.serious > 0) info.criticalPoints = (info.criticalPoints || 0) + 1
          }
        }
      } catch (error) { if (signal?.aborted) throw error; scoringComplete = false }
      const next = nextFen(fen, move.uci)
      if (isMyTurn(fen, options.side)) materialBeforeUserMove = material(fen, options.side)
      else if (materialBeforeUserMove !== undefined) sacrificeCp = Math.max(sacrificeCp, materialBeforeUserMove - material(next, options.side))
      fen = next
    }
    info.userDifficulty = weighted(difficulty.user)
    info.opponentDifficulty = weighted(difficulty.opponent)
    info.tacticalFragility = weighted(difficulty.fragility)
    if (info.userDifficulty !== undefined && info.opponentDifficulty !== undefined) info.asymmetry = Math.round(info.opponentDifficulty - info.userDifficulty)
    if (candidate.line[1] && legalUci(after).includes(candidate.line[1])) sacrificeCp = Math.max(sacrificeCp, material(choiceFen, options.side) - material(nextFen(after, candidate.line[1]), options.side))
    if (sacrificeCp >= 100) info.sacrificeCp = sacrificeCp
    onProgress?.(`Checking human replies ${candidateIndex + 1} / ${candidates.length}…`)
    const responseData = await human(after)
    const common = responseData && responseData.source !== 'book' && total(responseData) >= 20 ? [...responseData.moves].filter(move => gameCount(move) >= 5 && legalUci(after).includes(move.uci)).sort((a, b) => gameCount(b) - gameCount(a)).slice(0, 3) : []
    const outcomes: { value: number; weight: number }[] = []
    for (const reply of common) {
      if (Date.now() >= candidateStop) { scoringExpired = true; break }
      try { const result = await evaluate(nextFen(after, reply.uci), 1, candidateDepth); outcomes.push({ value: scoreFor(nextFen(after, reply.uci), result[0].cp, options.side), weight: gameCount(reply) }) }
      catch (error) { if (signal?.aborted) throw error; scoringComplete = false }
    }
    info.humanExpectedCp = weighted(outcomes)
    if (responseData && responseData.source !== 'book' && total(responseData)) info.humanCoverage = outcomes.reduce((sum, item) => sum + item.weight, 0) / total(responseData)
    onProgress?.(`Checking stability ${candidateIndex + 1} / ${candidates.length}…`)
    try {
      if (Date.now() >= candidateStop) { scoringExpired = true; throw new Error('Candidate analysis budget reached') }
      const endpoint = lineFen(line)
      const endAnalysis = await evaluate(endpoint, 4, candidateDepth)
      info.objectiveStabilityCp = Math.min(candidate.cp, scoreFor(endpoint, endAnalysis[0].cp, options.side))
      const decisionFen = isMyTurn(endpoint, options.side) ? endpoint : nextFen(endpoint, endAnalysis[0].line[0])
      if (!new Chess(decisionFen).isGameOver()) {
        const decision = assessDecision(decisionFen, await evaluate(decisionFen, 4, candidateDepth), undefined, { depth: candidateDepth, budgetMs: 0, excellentCp: 30, playableCp: 70, seriousCp: 150 })
        if (decision) info.practicalChoices = Math.min(info.practicalChoices ?? Infinity, decision.acceptable)
        else scoringComplete = false
      }
    } catch (error) { if (signal?.aborted) throw error; scoringComplete = false }
    info.scoring = scoringExpired ? 'budget-exhausted' : scoringComplete ? 'complete' : 'partial'
    examined.push({ line, info, relevance: humanMove && openingData ? frequency(humanMove, openingData) : undefined })
  }
  if (!examined.length) throw new Error('No candidate continuation could be analyzed.')
  // Rank only completed scoring passes; if all are partial, compare the same
  // measured factors for every candidate. Missing evidence never changes weights.
  const complete = examined.filter(entry => entry.info.scoring === 'complete')
  const partial = examined.filter(entry => entry.info.scoring !== 'budget-exhausted')
  const longest = Math.max(...partial.map(entry => entry.info.sampledPlies || 0))
  const rankable = complete.length ? complete : partial.filter(entry => entry.info.sampledPlies === longest)
  if (!rankable.length) {
    const line = examined[0].line
    return { ...line, status: 'incomplete', recommendation: { ...examined[0].info, verification: 'failed', reason: 'Scoring budget exhausted; no comparable candidate could be ranked.' } }
  }
  const measurements = rankable.map(entry => factors(entry.info, entry.relevance))
  const shared = measurements[0].map((_, index) => index).filter(index => measurements.every(values => values[index][1] !== undefined))
  for (const [index, entry] of rankable.entries()) {
    const values = shared.map(factor => measurements[index][factor] as [number, number])
    entry.info.score = values.length ? Math.round(100 * values.reduce((sum, [weight, value]) => sum + weight * value, 0) / values.reduce((sum, [weight]) => sum + weight, 0)) : undefined
    entry.info.ranking = complete.length ? 'Complete scoring; shared measured factors only.' : 'Partial scoring; compared equal-length samples using only factors measured for every candidate.'
  }
  rankable.sort((a, b) => (b.info.score ?? -1) - (a.info.score ?? -1))
  let bestFailed: Variation | undefined
  for (const [index, entry] of rankable.entries()) {
    check()
    onProgress?.(`Verifying candidate ${index + 1} / ${rankable.length}…`)
    let fen = root, depthReached = Infinity, failed = '', verifiedMinimumCp = Infinity
    const newMoves = entry.line.moves.slice(options.prefix.length)
    for (const [ply, move] of newMoves.entries()) {
      if (!legalUci(fen).includes(move.uci)) { failed = `Illegal move ${move.uci}`; break }
      if (isMyTurn(fen, options.side)) {
        const actual = new Chess(fen).move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] })
        const next = nextFen(fen, move.uci)
        const nextReply = newMoves[ply + 1]
        const sacrifice = nextReply && material(fen, options.side) - material(nextFen(next, nextReply.uci), options.side) >= 100
        const critical = ply <= prelude.length || !!actual.captured || actual.san.includes('+') || !!sacrifice
        const depth = critical ? verificationDepth : Math.min(verificationDepth, candidateDepth + 2)
        try {
          const verificationKey = `${fen}|${depth}`
          const bestLine = verificationCache.get(verificationKey) || await evaluate(fen, 1, depth, undefined, true)
          verificationCache.set(verificationKey, bestLine)
          const pickedLine = await evaluate(fen, 1, depth, [move.uci], true)
          const best = bestLine[0], picked = pickedLine.find(item => item.line[0] === move.uci)
          if (!picked) { failed = `No deeper result for ${move.san}`; break }
          depthReached = Math.min(depthReached, best.depth, picked.depth)
          verifiedMinimumCp = Math.min(verifiedMinimumCp, picked.cp)
          if (best.cp - picked.cp > options.tolerance || picked.cp < -300 && best.cp > -300) { failed = `${move.san} lost too much evaluation at depth ${picked.depth}`; break }
        } catch (error) { if (signal?.aborted) throw error; failed = `Deeper analysis unavailable for ${move.san}`; break }
      }
      fen = nextFen(fen, move.uci)
    }
    if (!failed) {
      try {
        const finalGame = new Chess(fen)
        if (finalGame.isGameOver()) entry.info.objectiveCp = finalGame.isCheckmate() ? isMyTurn(fen, options.side) ? -100000 : 100000 : 0
        else {
          const end = (await evaluate(fen, 4, verificationDepth, undefined, true))[0]
          depthReached = Math.min(depthReached, end.depth)
          entry.info.objectiveCp = scoreFor(fen, end.cp, options.side)
          entry.info.objectiveStabilityCp = Math.min(verifiedMinimumCp, entry.info.objectiveCp)
          const decisionFen = isMyTurn(fen, options.side) ? fen : nextFen(fen, end.line[0])
          if (!new Chess(decisionFen).isGameOver()) {
            const decision = assessDecision(decisionFen, await evaluate(decisionFen, 4, candidateDepth), undefined, { depth: candidateDepth, budgetMs: 0, excellentCp: 30, playableCp: 70, seriousCp: 150 })
            if (decision) entry.info.practicalChoices = Math.min(entry.info.practicalChoices ?? Infinity, decision.acceptable)
          }
        }
        if (entry.info.objectiveCp < -300) failed = 'Final position is objectively poor after deeper defense.'
      } catch (error) { if (signal?.aborted) throw error; failed = 'Final position could not be verified at deeper depth.' }
    }
    entry.info.depth = Number.isFinite(depthReached) ? depthReached : undefined
    entry.info.verification = failed ? 'failed' : 'passed'
    entry.info.reason = failed || (entry.info.humanExpectedCp === undefined ? 'Engine-only recommendation. Human practical advantage not established.' : entry.info.practicalChoices !== undefined && entry.info.practicalChoices <= 1 ? 'Sound at deeper depth, but the sampled continuation requires precise play.' : entry.info.asymmetry !== undefined && entry.info.asymmetry > 0 ? 'Sound at deeper depth; opponents face more difficult decisions in the sampled continuation.' : 'Sound at deeper depth with measured human continuations.')
    entry.info.alternatives = examined.filter(other => other !== entry).map(other => ({ firstMove: other.line.moves[options.prefix.length + prelude.length]?.san || '?', score: other.info.score, scoring: other.info.scoring, sampledPlies: other.info.sampledPlies, objectiveCp: other.info.objectiveCp, verified: other.info.verification === 'passed' }))
    const result = { ...entry.line, recommendation: entry.info, status: failed || entry.info.practicalChoices !== undefined && entry.info.practicalChoices <= 1 && entry.line.status === 'favorable' ? 'incomplete' as const : entry.line.status, termination: failed ? `Verification failed: ${failed}` : entry.line.termination }
    if (!failed) return result
    bestFailed ||= result
  }
  return bestFailed!
}

export async function reverifyVariation(line: Variation, sources: Sources, signal?: AbortSignal, progress?: (phase: string) => void, depth = 24, timeoutMs = 30000, budgetMs = 180000, tolerance = 35): Promise<Variation> {
  const deadline = Date.now() + budgetMs
  let incomplete = false
  let fen = line.startFen, reached = Infinity, failed = '', firstCp: number | undefined
  const search = async (position: string, moves?: string[]) => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (Date.now() >= deadline) throw new Error('Verification time budget reached')
    const result = await sources.analyze(position, 1, depth, signal, Math.min(timeoutMs, Math.max(1, deadline - Date.now())), true, moves)
    const best = result.find(entry => entry.depth >= depth && !entry.search?.stoppedByBudget && legalUci(position).includes(entry.line[0]))
    if (!best) throw new Error('Required engine depth was not reached')
    reached = Math.min(reached, best.depth)
    return best
  }
  for (const [index, move] of line.moves.entries()) {
    if (!legalUci(fen).includes(move.uci)) { failed = `Illegal move ${move.uci}`; break }
    if (isMyTurn(fen, line.side)) {
      progress?.(`Verifying move ${index + 1} / ${line.moves.length}…`)
      try {
        const best = await search(fen), played = best.line[0] === move.uci ? best : await search(fen, [move.uci])
        if (played.line[0] !== move.uci || best.cp - played.cp > tolerance) { failed = `${move.san} lost too much evaluation at depth ${played.depth}`; break }
        firstCp ??= played.cp
      } catch (error) { if (signal?.aborted) throw error; incomplete = true; failed = `Could not verify ${move.san}: ${(error as Error).message}`; break }
    }
    fen = nextFen(fen, move.uci)
  }
  let objectiveCp: number | undefined
  if (!failed) {
    progress?.('Checking final position…')
    try {
      const final = new Chess(fen)
      objectiveCp = final.isGameOver() ? final.isCheckmate() ? isMyTurn(fen, line.side) ? -100000 : 100000 : 0 : scoreFor(fen, (await search(fen)).cp, line.side)
      if (objectiveCp < -300) failed = 'Final position is objectively poor after deeper defense.'
    } catch (error) { if (signal?.aborted) throw error; incomplete = true; failed = `Final position could not be verified: ${(error as Error).message}` }
  }
  const recommendation: Recommendation = { policy: line.recommendation?.policy, evaluationPly: failed ? undefined : line.moves.length, verificationScope: 'deep', preliminary: !!failed, verification: failed ? incomplete ? 'pending' : 'failed' : 'passed', depth: Number.isFinite(reached) ? reached : undefined, objectiveCp, objectiveStabilityCp: objectiveCp === undefined ? undefined : Math.min(firstCp ?? objectiveCp, objectiveCp), configuration: { candidateDepth: line.engineConfig?.depth ?? depth, verificationDepth: depth, timeoutMs }, reason: failed || 'Engine-only reverified line. Human practical advantage not established.' }
  return { ...line, recommendation, status: failed ? 'incomplete' : line.status, termination: failed ? `Verification ${incomplete ? 'incomplete' : 'failed'}: ${failed}` : line.termination }
}
