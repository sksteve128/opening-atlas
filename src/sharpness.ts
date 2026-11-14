import { Chess } from 'chess.js'
import type { Evaluation } from './engine'
import type { ExplorerData } from './core'

export type SharpnessSettings = { depth: number; budgetMs: number; excellentCp: number; playableCp: number; seriousCp: number; candidates?: number; minimumCandidates?: number; branches?: number; cacheKey?: string }
export type SharpMove = { uci: string; san: string; lossCp: number | null; acceptable: boolean; serious: boolean; forcing: boolean; mate?: number }
export type SharpDecision = { score: number; legal: number; evaluated: number; coverage: number; preliminary: boolean; acceptable: number; excellent: number; serious: number; forcing: number; moves: SharpMove[]; humanErrorShare?: number; humanCoverage?: number; depth: number }
export type SharpnessResult = { fen: string; white?: SharpDecision; black?: SharpDecision; whiteProjected: boolean; blackProjected: boolean; continuations: { san: string; decision: SharpDecision; weight: number }[]; complete: boolean; depth: number }
export type SharpnessSources = {
  analyze: (fen: string, count: number, depth: number, signal?: AbortSignal, timeoutMs?: number) => Promise<Evaluation[]>
  cached?: (fen: string, count: number, depth: number) => Evaluation[] | undefined
  explorer?: (fen: string, signal?: AbortSignal) => Promise<ExplorerData>
}

const cache = new Map<string, SharpnessResult>()
const fastCache = new Map<string, SharpnessResult>()
export const invalidateFastSharpness = (fen: string) => fastCache.delete(fen)
const games = (move: { white: number; draws: number; black: number }) => move.white + move.draws + move.black
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const fastSettings: SharpnessSettings = { depth: 8, budgetMs: 4000, excellentCp: 30, playableCp: 70, seriousCp: 150 }

export const cachedFastSharpness = (fen: string) => fastCache.get(fen)
// Same preliminary model as automatic analysis, using only candidates already evaluated.
export const estimateFastSharpness = (fen: string, entries: Evaluation[]) => assessDecision(fen, entries, undefined, { ...fastSettings, minimumCandidates: 3 })

export function sharpnessLabel(score: number) {
  return score <= 20 ? 'Very forgiving' : score <= 40 ? 'Straightforward' : score <= 60 ? 'Moderate' : score <= 80 ? 'Precise' : 'Highly unforgiving'
}

export function assessDecision(fen: string, evaluations: Evaluation[], data: ExplorerData | undefined, settings: SharpnessSettings): SharpDecision | undefined {
  const legal = new Chess(fen).moves({ verbose: true })
  if (!legal.length) return undefined
  const byUci = new Map(legal.map(move => [move.from + move.to + (move.promotion || ''), move]))
  const seen = new Set<string>()
  const entries = evaluations.filter(entry => {
    const uci = entry.line[0]
    if (!uci || !byUci.has(uci) || seen.has(uci) || !Number.isFinite(entry.cp) || entry.depth < settings.depth - 2 || entry.search?.multiPVComplete === false) return false
    seen.add(uci)
    return true
  }).sort((a, b) => b.cp - a.cp)
  if (entries.length < Math.min(settings.minimumCandidates ?? 4, legal.length)) return undefined
  const best = entries[0]
  const moves = entries.map(entry => {
    const move = byUci.get(entry.line[0])!
    const lossCp = best.mate === undefined && entry.mate === undefined ? Math.max(0, best.cp - entry.cp) : null
    const acceptable = lossCp !== null ? lossCp <= settings.playableCp : best.mate !== undefined && entry.mate !== undefined && Math.sign(best.mate) === Math.sign(entry.mate)
    return { uci: entry.line[0], san: move.san, lossCp, acceptable, serious: lossCp !== null ? lossCp > settings.seriousCp : (best.mate !== undefined && best.mate > 0 && !(entry.mate !== undefined && entry.mate > 0)) || (best.mate === undefined && entry.mate !== undefined && entry.mate < 0), forcing: !!move.captured || move.san.includes('+') || move.san.includes('#'), mate: entry.mate }
  })
  const acceptable = moves.filter(move => move.acceptable).length
  const excellent = moves.filter(move => move.lossCp !== null && move.lossCp <= settings.excellentCp).length
  const serious = moves.filter(move => move.serious).length
  const forcing = moves.filter(move => move.forcing).length
  let humanErrorShare: number | undefined, humanCoverage: number | undefined
  const total = data && data.source !== 'book' ? data.white + data.draws + data.black : 0
  if (total) {
    const known = data!.moves.filter(move => moves.some(entry => entry.uci === move.uci))
    humanCoverage = known.reduce((sum, move) => sum + games(move), 0) / total
    if (humanCoverage >= 0.6) humanErrorShare = known.filter(move => moves.find(entry => entry.uci === move.uci)?.serious).reduce((sum, move) => sum + games(move), 0) / total
  }
  // Heuristic precision among evaluated moves; 0 means no measured loss, not that every legal move is safe.
  const score = legal.length === 1 ? 0 : clamp(50 * (1 - acceptable / moves.length) + 25 * serious / moves.length + (legal.length >= 4 && acceptable === 1 ? 10 : 0) + (forcing >= 2 && serious >= 1 ? 5 : 0) + (humanErrorShare || 0) * 20)
  return { score, legal: legal.length, evaluated: moves.length, coverage: moves.length / legal.length, preliminary: moves.length < legal.length || entries.some(entry => entry.depth < settings.depth || entry.search?.stoppedByBudget), acceptable, excellent, serious, forcing, moves, humanErrorShare, humanCoverage, depth: Math.min(...entries.map(entry => entry.depth)) }
}

function aggregate(decisions: { decision: SharpDecision; weight: number }[]): SharpDecision | undefined {
  if (!decisions.length) return undefined
  const weight = decisions.reduce((sum, item) => sum + item.weight, 0)
  const average = (field: 'score' | 'legal' | 'evaluated' | 'acceptable' | 'excellent' | 'serious' | 'forcing') => decisions.reduce((sum, item) => sum + item.decision[field] * item.weight, 0) / weight
  const measured = decisions.filter(item => item.decision.humanErrorShare !== undefined)
  const measuredWeight = measured.reduce((sum, item) => sum + item.weight, 0)
  return { score: clamp(average('score')), legal: Math.round(average('legal')), evaluated: Math.round(average('evaluated')), coverage: decisions.reduce((sum, item) => sum + item.decision.coverage * item.weight, 0) / weight, preliminary: decisions.some(item => item.decision.preliminary), acceptable: Math.round(average('acceptable')), excellent: Math.round(average('excellent')), serious: Math.round(average('serious')), forcing: Math.round(average('forcing')), moves: decisions.flatMap(item => item.decision.moves.slice(0, 3)), depth: Math.min(...decisions.map(item => item.decision.depth)), humanErrorShare: measuredWeight ? measured.reduce((sum, item) => sum + item.decision.humanErrorShare! * item.weight, 0) / measuredWeight : undefined, humanCoverage: measuredWeight ? measured.reduce((sum, item) => sum + (item.decision.humanCoverage || 0) * item.weight, 0) / measuredWeight : undefined }
}

// ponytail: one current search and one successor search bound automatic work; add a tree only if measured accuracy needs it.
export async function analyzeFastSharpness(fen: string, sources: SharpnessSources, signal?: AbortSignal, onCurrent?: (lines: Evaluation[]) => void, onEstimate?: (result: SharpnessResult) => void): Promise<SharpnessResult> {
  signal?.throwIfAborted()
  const cached = fastCache.get(fen)
  const currentLines = sources.cached?.(fen, 4, fastSettings.depth)
  if (currentLines) onCurrent?.(currentLines)
  if (cached && (!currentLines || Math.min(...currentLines.map(entry => entry.depth)) <= (new Chess(fen).turn() === 'w' ? cached.white?.depth ?? 0 : cached.black?.depth ?? 0))) { onEstimate?.(cached); return cached }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  const game = new Chess(fen), current = game.turn() === 'w' ? 'white' : 'black', other = current === 'white' ? 'black' : 'white'
  const result: SharpnessResult = { fen, whiteProjected: current !== 'white', blackProjected: current !== 'black', continuations: [], complete: false, depth: fastSettings.depth }
  if (!game.moves().length) return result
  const first = currentLines || await sources.analyze(fen, 4, fastSettings.depth, signal, 2500)
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  if (!currentLines) onCurrent?.(first)
  const immediate = assessDecision(fen, first, undefined, fastSettings)
  result[current] = immediate
  result.depth = Math.min(...first.map(entry => entry.depth))
  onEstimate?.({ ...result })
  const top = first.find(entry => entry.line[0] && game.moves({ verbose: true }).some(move => move.from + move.to + (move.promotion || '') === entry.line[0]))
  if (!top) return result
  const move = game.move({ from: top.line[0].slice(0, 2), to: top.line[0].slice(2, 4), promotion: top.line[0][4] })
  const after = game.fen()
  try {
    const replies = sources.cached?.(after, 4, fastSettings.depth) || await sources.analyze(after, 4, fastSettings.depth, signal, 1500)
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    const projected = assessDecision(after, replies, undefined, fastSettings)
    if (projected) { result[other] = projected; result.continuations.push({ san: move.san, decision: projected, weight: 1 }); result.depth = Math.min(result.depth, projected.depth) }
  } catch (error) { if (signal?.aborted) throw error }
  result.complete = !!immediate && !!result[other]
  if (result.complete) { fastCache.set(fen, result); if (fastCache.size > 120) fastCache.delete(fastCache.keys().next().value!) }
  return result
}

export async function analyzeSharpness(fen: string, settings: SharpnessSettings, sources: SharpnessSources, signal?: AbortSignal, progress?: (text: string) => void): Promise<SharpnessResult> {
  signal?.throwIfAborted()
  const key = `${fen}|${settings.minimumCandidates ?? 4}|${settings.depth}|${settings.candidates || 12}|${settings.branches || 2}|${settings.excellentCp}|${settings.playableCp}|${settings.seriousCp}|${settings.cacheKey || ''}`
  const cached = cache.get(key)
  if (cached) return cached
  const budget = AbortSignal.timeout(settings.budgetMs)
  const active = signal ? AbortSignal.any([signal, budget]) : budget
  const game = new Chess(fen), legal = game.moves({ verbose: true })
  const current = game.turn() === 'w' ? 'white' : 'black'
  const other = current === 'white' ? 'black' : 'white'
  progress?.('Checking current choices…')
  const first = await sources.analyze(fen, Math.min(settings.candidates || 12, legal.length), settings.depth, active, settings.budgetMs)
  let human: ExplorerData | undefined
  try { human = await sources.explorer?.(fen, active) } catch { /* Engine-only estimate remains valid. */ }
  const immediate = assessDecision(fen, first, human, settings)
  const result: SharpnessResult = { fen, white: current === 'white' ? immediate : undefined, black: current === 'black' ? immediate : undefined, whiteProjected: other === 'white', blackProjected: other === 'black', continuations: [], complete: false, depth: settings.depth }
  if (active.aborted) throw new DOMException('Sharpness analysis cancelled or budget exceeded', 'AbortError')
  const ranked = first.filter(entry => entry.line[0] && legal.some(move => move.from + move.to + (move.promotion || '') === entry.line[0])).sort((a, b) => b.cp - a.cp)
  const popular = human && human.source !== 'book' ? [...human.moves].sort((a, b) => games(b) - games(a)).find(move => ranked.some(entry => entry.line[0] === move.uci && entry.line[0] !== ranked[0]?.line[0])) : undefined
  const candidates = [ranked[0], popular ? ranked.find(entry => entry.line[0] === popular.uci) : ranked[1], ...ranked.slice(2)].filter((entry): entry is Evaluation => !!entry).filter((entry, index, all) => all.findIndex(item => item.line[0] === entry.line[0]) === index).slice(0, settings.branches || 2)
  const projected: { decision: SharpDecision; weight: number }[] = []
  for (const candidate of candidates) {
    if (active.aborted) break
    const move = legal.find(item => item.from + item.to + (item.promotion || '') === candidate.line[0])!
    game.move(move)
    const after = game.fen(); game.undo()
    progress?.(`Checking ${other === 'white' ? 'White' : 'Black'} after ${move.san}…`)
    try {
      const replies = await sources.analyze(after, Math.min(settings.candidates || 12, new Chess(after).moves().length), settings.depth, active, settings.budgetMs)
      let responseData: ExplorerData | undefined
      try { responseData = await sources.explorer?.(after, active) } catch { /* Engine-only estimate. */ }
      const decision = assessDecision(after, replies, responseData, settings)
      if (decision) {
        const share = human && human.source !== 'book' ? human.moves.find(item => item.uci === candidate.line[0]) : undefined
        const weight = human && human.source !== 'book' ? Math.max(0.05, share ? games(share) / Math.max(1, human.white + human.draws + human.black) : 0) : 1
        projected.push({ decision, weight })
        result.continuations.push({ san: move.san, decision, weight })
      }
    } catch (error) { if (active.aborted) break; throw error }
  }
  result[other] = aggregate(projected)
  result.complete = !!immediate && projected.length === candidates.length && !active.aborted
  if (active.aborted && signal?.aborted) throw new DOMException('Sharpness analysis cancelled', 'AbortError')
  if (result.complete) { cache.set(key, result); if (cache.size > 100) cache.delete(cache.keys().next().value!) }
  return result
}
