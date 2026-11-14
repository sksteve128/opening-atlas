import type { Tablebase } from './learning'
import { Chess, type Color, type Square } from 'chess.js'
import { analyze, type Evaluation } from './engine'
import { assessDecision } from './sharpness'
import { humanPrediction, type HumanPrediction, type HumanModelProvider } from './humanModel'

export type PlannerOptions = { side: Color; horizon: 1 | 2 | 3 | 5; depth: number; tolerance: number; budgetMs: number; rating: number; response: 'strong' | 'human'; rootMove?: string; history?: { startFen: string; moves: string[] } }
export type Evidence = { legal: number; evaluated: number; depth: number; acceptable: number; score?: number; spread?: number; gap?: number; forcing: number; modelMass?: number; mistakeMass?: number; expectedLoss?: number; mateRiskMass?: number; modelError?: string }
export type Plan = { id: string; label: string; root: Evaluation; loss: number | null; refuted: boolean; preliminary: boolean; stage?: 'candidate'; fens: string[]; moves: string[]; sans: string[]; steps: number[]; evidence: Partial<Record<Color, Evidence>>; response: string; error?: string; leadIn: number; tablebase?: string }
export type PlannerResult = { fen: string; plans: Plan[]; elapsedMs: number; searches: number; duplicates: number; error?: string; timings?: { rootMs: number; opponentMs: number; continuationMs: number; classificationMs: number; groupingMs: number; queueMs: number; uniquePositions: number; achievedDepths: number[] } }
export type PlannerSources = { analyze: typeof analyze; human?: HumanModelProvider; tablebase?: (fen: string, signal?: AbortSignal) => Promise<Tablebase> }
const uci = (move: { from: string; to: string; promotion?: string }) => move.from + move.to + (move.promotion || '')
export function playUci(game: Chess, move: string) { return game.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] }) }
export function objectiveLoss(best: Evaluation, candidate: Evaluation): number | null {
  if (best.mate !== undefined || candidate.mate !== undefined) return null
  return Math.max(0, best.cp - candidate.cp)
}
export function soundCandidate(best: Evaluation, candidate: Evaluation, tolerance: number) {
  if (best.mate !== undefined || candidate.mate !== undefined) {
    if (best.mate === undefined) return candidate.mate! > 0
    if (best.mate > 0) return candidate.mate !== undefined && candidate.mate > 0
    return candidate.mate === undefined || candidate.mate > 0 || Math.abs(candidate.mate) >= Math.abs(best.mate)
  }
  return objectiveLoss(best, candidate)! <= tolerance
}
export function decisionEvidence(fen: string, entries: Evaluation[], prediction?: HumanPrediction): Evidence {
  const game = new Chess(fen), legal = game.moves({ verbose: true }), best = entries[0]
  const decision = assessDecision(fen, entries, undefined, { depth: Math.max(1, ...entries.map(e => e.depth)), budgetMs: 1, excellentCp: 30, playableCp: 70, seriousCp: 150, minimumCandidates: 1 })
  const result: Evidence = { legal: legal.length, evaluated: decision?.evaluated ?? 0, depth: decision?.depth ?? 0, acceptable: decision?.acceptable ?? 0, score: decision?.score, forcing: decision?.forcing ?? 0 }
  if (best && entries.every(e => e.mate === undefined)) { result.spread = best.cp - entries.at(-1)!.cp; result.gap = entries[1] ? best.cp - entries[1].cp : undefined }
  if (prediction && best) {
    result.modelMass = 0; result.mistakeMass = 0; result.expectedLoss = 0; result.mateRiskMass = 0
    for (const move of prediction.moves) {
      const entry = entries.find(e => e.line[0] === move.uci)
      if (!entry) continue
      result.modelMass += move.probability
      const loss = objectiveLoss(best, entry)
      if (loss !== null) { result.expectedLoss += move.probability * loss; if (loss > 150) result.mistakeMass += move.probability }
      else if (!soundCandidate(best, entry, 150)) result.mateRiskMass += move.probability
    }
  }
  return result
}
export function formation(before: string, after: string, side: Color) {
  const a = new Chess(before), b = new Chess(after)
  const changed = b.board().flat().filter(p => p?.color === side && (a.get(p.square)?.type !== p.type || a.get(p.square)?.color !== side))
  const lost = a.board().flat().filter(p => p?.color === side).length - b.board().flat().filter(p => p?.color === side).length
  return { changed: changed.map(p => ({ square: p!.square, piece: (side + p!.type.toUpperCase()) })), captured: Math.max(0, lost) }
}
export function planLabel(fen: string, moves: string[], side: Color) {
  const game = new Chess(fen)
  for (const text of moves) {
    const move = playUci(game, text)
    if (move.color !== side) continue
    if (move.piece === 'p' && ['c', 'd', 'e', 'f'].includes(move.to[0]) && move.captured) return 'Central pawn break'
    if (move.captured && move.piece !== 'p') return 'Material exchange'
    if (move.flags.includes('k') || move.flags.includes('q')) return 'Defensive consolidation'
    if (move.piece === 'n') return 'Knight maneuver'
    if (move.piece === 'p') return move.to[0] >= 'f' ? 'Kingside expansion' : move.to[0] <= 'c' ? 'Queenside expansion' : 'Central pawn advance'
  }
  return 'Alternative continuation'
}
// Compare legal endpoints; piece zones group minor rearrangements, pawn/king squares retain precision.
export function formationKey(fen: string) {
  return fen.split(' ').slice(1, 4).join(' ') + '|' + new Chess(fen).board().flat().filter(p => p).map(p => `${p!.color}${p!.type}:${p!.type === 'p' || p!.type === 'k' ? p!.square : `${Math.floor((p!.square.charCodeAt(0)-97)/2)}${Math.floor((Number(p!.square[1])-1)/2)}`}`).sort().join('|')
}
export function preliminaryPlans(fen: string, options: PlannerOptions, roots: Evaluation[]): Plan[] {
  if (!roots.length) return []
  const position = new Chess(options.history?.startFen || fen)
  try { options.history?.moves.forEach(move => playUci(position, move)) } catch { return [] }
  if (position.fen() !== fen || position.isGameOver() || position.turn() !== options.side) return []
  const best = roots[0]
  return roots.slice(0, 4).filter(root => (options.rootMove ? root.line[0] === options.rootMove : soundCandidate(best, root, options.tolerance))).flatMap(root => {
    const game = new Chess(fen)
    try {
      const played = playUci(game, root.line[0])
      return [{ id: root.line[0], root, loss: objectiveLoss(best, root), refuted: !soundCandidate(best, root, options.tolerance), preliminary: true, stage: 'candidate', label: planLabel(fen, [root.line[0]], options.side), fens: [fen, game.fen()], moves: [root.line[0]], sans: [played.san], steps: [0, 1], evidence: {}, response: 'Candidate move · defense verification pending', leadIn: 0 } satisfies Plan]
    } catch { return [] }
  })
}
export async function discoverPlans(fen: string, options: PlannerOptions, sources: PlannerSources, signal: AbortSignal, onPlan?: (plan: Plan) => void, onCandidates?: (plans: Plan[]) => void): Promise<PlannerResult> {
  const started = performance.now(), deadline = started + options.budgetMs
  const active = AbortSignal.any([signal, AbortSignal.timeout(options.budgetMs)])
  const startGame = () => {
    const game = new Chess(options.history?.startFen || fen)
    options.history?.moves.forEach(move => playUci(game, move))
    if (game.fen() !== fen) throw new Error('Planner history does not match the displayed position.')
    return game
  }
  const predictionCache = new Map<string, HumanPrediction>()
  const result: PlannerResult = { fen, plans: [], elapsedMs: 0, searches: 0, duplicates: 0 }
  const timings = import.meta.env.DEV ? { rootMs: 0, opponentMs: 0, continuationMs: 0, classificationMs: 0, groupingMs: 0, queueMs: 0, uniquePositions: 0, achievedDepths: [] as number[] } : undefined
  const positions = new Set<string>()
  if (timings) result.timings = timings
  const check = () => { active.throwIfAborted() }
  const errorText = (error: unknown) => active.reason?.name === 'TimeoutError' ? 'Planner time limit reached; completed searches are retained for Refresh plans.' : (error as Error).message
  const search = async (position: string, count = 4, restrict?: string[], requestedDepth = options.depth, progress?: (entries: Evaluation[]) => void, phase: 'root' | 'opponent' | 'continuation' = 'continuation') => {
    check(); const game = new Chess(position)
    if (game.isGameOver()) return []
    const searchStarted = performance.now()
    result.searches++
    positions.add(position)
    const entries = await sources.analyze(position, Math.min(count, game.moves().length), requestedDepth, active, Math.max(1, deadline - performance.now()), false, restrict, { priority: phase === 'root' ? 'explicit' : 'visible', onDepth: progress })
    if (timings) { const wallMs = performance.now() - searchStarted; timings[`${phase}Ms`] += wallMs; timings.queueMs += Math.min(wallMs, entries[0]?.search?.queueMs || 0); timings.achievedDepths.push(entries[0]?.depth || 0); timings.uniquePositions = positions.size }
    check()
    if (!entries.length || entries.some(e => !Number.isFinite(e.cp) || e.search?.multiPVComplete === false || !game.moves({ verbose: true }).some(m => uci(m) === e.line[0]))) throw new Error('No coherent legal engine candidates.')
    return entries
  }
  const predict = async (position: string) => {
    if (!sources.human) throw new Error('Maia unavailable')
    return humanPrediction(sources.human, position, options.rating, active, Math.max(1, Math.min(1500, deadline-performance.now())), predictionCache)
  }
  try {
    check()
    const initial = startGame(), lead: string[] = []
    if (initial.isGameOver()) { result.error = initial.isThreefoldRepetition() ? 'Game ended by repetition in the supplied history.' : 'Terminal position — no future moves.'; return result }
    if (initial.turn() !== options.side) { const response = (await search(initial.fen(), 4, undefined, options.depth, undefined, 'root'))[0]; lead.push(response.line[0]); playUci(initial, response.line[0]) }
    if (initial.isGameOver()) return { ...result, error: 'The opponent’s strongest response ends the game before your first move.' }
    let tablebase: Tablebase | undefined
    if (sources.tablebase && initial.board().flat().filter(Boolean).length <= 7 && initial.fen().split(' ')[2] === '-') {
      try { tablebase = await sources.tablebase(initial.fen(), AbortSignal.any([active, AbortSignal.timeout(1500)])) } catch { check() }
    }
    const outcome = (category: string) => ({ loss: 2, 'blessed-loss': 1, draw: 0, 'cursed-win': -1, win: -2 })[category] ?? -3
    if (tablebase && !tablebase.moves.some(move => outcome(move.category) > -3)) tablebase = undefined
    const bestOutcome = tablebase ? Math.max(...tablebase.moves.map(move => outcome(move.category))) : undefined
    let lastPublishedDepth = 0
    const publishCandidates = initial.fen() === fen && !options.rootMove && onCandidates ? (entries: Evaluation[]) => { if (!active.aborted && entries[0].depth >= 6 && (entries[0].depth >= lastPublishedDepth + 2 || entries[0].depth >= options.depth)) { lastPublishedDepth = entries[0].depth; onCandidates(preliminaryPlans(fen, options, entries)) } } : undefined
    const roots = await search(initial.fen(), 4, undefined, options.depth, publishCandidates, 'root'), best = roots[0]
    publishCandidates?.(roots)
    let candidates = roots
    if (options.rootMove) {
      const existing = roots.find(e => e.line[0] === options.rootMove)
      candidates = existing ? [existing] : await search(initial.fen(), 1, [options.rootMove], Math.max(options.depth, best.depth), undefined, 'root')
    }
    for (const root of candidates.slice(0, 4)) {
      check()
      const tbMove = tablebase?.moves.find(move => move.uci === root.line[0])
      const classifiedAt = performance.now()
      const refuted = tablebase ? !tbMove || outcome(tbMove.category) < bestOutcome! : !soundCandidate(best, root, options.tolerance)
      if (timings) timings.classificationMs += performance.now() - classifiedAt
      if (refuted && !options.rootMove) continue
      const game = startGame()
      const plan: Plan = { id: root.line[0], root, loss: objectiveLoss(best, root), refuted, preliminary: roots.some(e => e.depth < options.depth || e.search?.stoppedByBudget) || root.depth < Math.max(options.depth, best.depth), label: '', fens: [fen], moves: [], sans: [], steps: [0], evidence: {}, response: options.response === 'strong' ? 'Stockfish strongest defense' : 'Maia highest-probability response (one conditional path)', leadIn: lead.length, tablebase: tbMove?.category }
      const play = (move: string) => { const played = playUci(game, move); plan.moves.push(move); plan.sans.push(played.san); plan.fens.push(game.fen()) }
      lead.forEach(play)
      try {
        for (let turn = 0; turn < options.horizon && !game.isGameOver(); turn++) {
          check()
          const own = turn === 0 ? roots : await search(game.fen())
          if (!plan.evidence[options.side]) {
            let prediction: HumanPrediction | undefined
            if (options.response === 'human') try { prediction = await predict(game.fen()) } catch (error) { check(); plan.error = (error as Error).message }
            plan.evidence[options.side] = decisionEvidence(game.fen(), own, prediction)
          }
          play(turn === 0 ? root.line[0] : own[0].line[0])
          if (!game.isGameOver()) {
            const opponent = game.turn(), replies = await search(game.fen(), 4, undefined, options.depth, undefined, 'opponent')
            let prediction: HumanPrediction | undefined
            if (options.response === 'human') try { prediction = await predict(game.fen()) } catch (error) { check(); throw error }
            if (!plan.evidence[opponent]) plan.evidence[opponent] = decisionEvidence(game.fen(), replies, prediction)
            const reply = options.response === 'human' ? [...prediction!.moves].sort((a,b) => b.probability-a.probability)[0].uci : replies[0].line[0]
            play(reply)
            plan.preliminary ||= replies.some(e => e.depth < options.depth || e.search?.stoppedByBudget)
          }
          plan.preliminary ||= own.some(e => e.depth < options.depth || e.search?.stoppedByBudget)
          plan.steps.push(plan.moves.length)
        }
      } catch (error) {
        if (signal.aborted) throw error
        plan.error = errorText(error); plan.preliminary = true
        if (plan.steps.at(-1) !== plan.moves.length) plan.steps.push(plan.moves.length)
      }
      const labelAt = performance.now(); plan.label = planLabel(fen, plan.moves, options.side); if (timings) timings.classificationMs += performance.now() - labelAt
      if (!plan.moves.length || plan.moves.length <= lead.length) continue
      const groupAt = performance.now(), key = formationKey(plan.fens.at(-1)!)
      const duplicate = !options.rootMove && result.plans.some(p => formationKey(p.fens.at(-1)!) === key)
      if (timings) timings.groupingMs += performance.now() - groupAt
      if (duplicate) { result.duplicates++; continue }
      result.plans.push(plan); onPlan?.(plan)
    }
  } catch (error) { if (signal.aborted) throw error; result.error = errorText(error) }
  finally { result.elapsedMs = performance.now() - started }
  return result
}
export function planArrows(plan: Plan, through: number, side: Color) {
  const game = new Chess(plan.fens[0]), arrows: { startSquare: string; endSquare: string; color: string }[] = []
  for (const text of plan.moves.slice(0, through)) { const move = playUci(game, text); if (move.color === side) arrows.push({ startSquare: move.from, endSquare: move.to, color: move.piece === 'p' ? '#db9129' : '#168c9dcc' }) }
  return arrows.slice(-5)
}
export function positionPieces(fen: string) {
  return Object.fromEntries(new Chess(fen).board().flat().filter(p => p).map(p => [p!.square as Square, { pieceType: p!.color + p!.type.toUpperCase() }]))
}
