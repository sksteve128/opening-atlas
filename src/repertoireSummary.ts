import { generationProvenance } from './generationProvenance'
import type { Variation } from './learning'
import { positions } from './gameAnalysis'
import { modelFallbackReason } from './learning'
import type { RepertoireNode } from './repertoireTree'

export type OpponentProvenance = { label: string; details: string; category: 'lichess' | 'maia' | 'other' | 'unknown'; firstMaia?: string; reason?: string; transitions: number; runs: { source: string; first: string; last: string; index: number }[] }
const provenanceCache = new WeakMap<Variation, OpponentProvenance>()

export function opponentProvenance(line: Variation): OpponentProvenance {
  const cached = provenanceCache.get(line)
  if (cached) return cached
  const provenance = generationProvenance(line)
  const moves = provenance.entries.filter(entry => entry.opponent)
  const generated = moves.filter(move => !move.contextual)
  const sources = generated.map(move => move.source)
  const runs: OpponentProvenance['runs'] = []
  for (const move of generated) {
    if (runs.at(-1)?.source === move.source) runs[runs.length - 1].last = move.label
    else runs.push({source:move.source,first:move.label,last:move.label,index:move.index})
  }
  const transitions = Math.max(0,runs.length - 1)
  const firstMaia = generated.find(move => move.source === 'Maia')
  const reason = firstMaia && line.recommendation?.populationAttempts?.some(attempt => attempt.ply === firstMaia.index) ? modelFallbackReason(line, firstMaia.index) : undefined
  const distinct = [...new Set(sources)]
  const category: OpponentProvenance['category'] = !sources.length || distinct.includes('Source unavailable') ? 'unknown' : distinct.includes('Maia') ? 'maia' : distinct.length === 1 && distinct[0] === 'Lichess' ? 'lichess' : 'other'
  const known = runs.filter(run => run.source !== 'Source unavailable')
  const sequence = known.map(run => run.source).filter((source,i,all)=>i===0||source!==all[i-1]).join(' → ')
  const uncertain = runs.some(run => run.source === 'Source unavailable')
  const label = !known.length ? !sources.length && provenance.boundary !== undefined ? 'No generated opponent moves' : !sources.length && provenance.context ? 'Opening context · Generation boundary unavailable' : 'Opponent source unavailable'
    : uncertain ? `Opponent: ${sequence} · Transition unknown`
    : runs.length > 2 ? `Opponent: ${sequence}`
    : runs.length === 2 ? `Opponent: ${sequence} from ${runs[1].first}`
    : `Opponent: ${runs[0].source}${runs[0].source === 'Stockfish' ? provenance.boundary !== undefined ? ' from generation start' : ' · Generation boundary unavailable' : ' throughout'}`
  const details = [`Generation start: ${provenance.start}`, ...(provenance.context ? [`Opening context: ${provenance.context}`] : []), provenance.boundary === undefined ? 'Recorded opponent moves' : 'Generated opponent moves', ...moves.filter(move => !move.contextual).map(move => `${move.label} — ${move.source === 'Source unavailable' ? provenance.boundary === undefined ? 'Historical move · Source unavailable' : 'Generated move · Source unavailable' : move.source}`), ...(line.opponentTransition ? [`Stockfish takeover: ${provenance.entries[line.opponentTransition.ply]?.label || 'Recorded ply ' + line.opponentTransition.ply} — ${line.opponentTransition.reason}`] : []), ...(reason ? [`Fallback: ${reason}`] : [])].join('\n')
  const value = { label, details, category, firstMaia: firstMaia?.label, reason, transitions, runs }
  provenanceCache.set(line, value)
  return value
}

const branchCache = new WeakMap<RepertoireNode, string>()
export function branchProvenance(node: RepertoireNode): string {
  const cached = branchCache.get(node)
  if (cached) return cached
  const counts = { lichess: 0, maia: 0, other: 0, unknown: 0 }, seen = new Set<string>()
  const visit = (current: RepertoireNode) => {
    for (const entry of current.ends) if (!seen.has(entry.line.id)) { seen.add(entry.line.id); counts[opponentProvenance(entry.line).category]++ }
    current.children.forEach(visit)
  }
  visit(node)
  const result = [`${counts.lichess} Lichess-based`, `${counts.maia} Maia-based`, ...(counts.other ? [`${counts.other} other`] : []), ...(counts.unknown ? [`${counts.unknown} unknown`] : [])].join(' · ')
  branchCache.set(node, result)
  return result
}

export function repertoireDate(timestamp?: number) {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime()) ? new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : undefined
}
export function repertoireEvaluation(line: Variation) {
  if (line.sideUnconfirmed) return undefined
  const fens = positions(line)
  const point = line.analysis?.points.filter(p => p && Number.isInteger(p.index) && p.index >= 0 && p.index <= line.moves.length && p.fen === fens[p.index] && (Number.isFinite(p.mate) || Number.isFinite(p.cp))).sort((a, b) => b!.index - a!.index)[0]
  const recommendation = line.recommendation
  const cp = point?.cp !== undefined ? point.cp * (line.side === 'black' ? -1 : 1) : recommendation?.objectiveCp
  const mate = point?.mate === undefined ? undefined : point.mate * (line.side === 'black' ? -1 : 1)
  if (!Number.isFinite(mate) && !Number.isFinite(cp)) return undefined
  const ply = point?.index ?? recommendation?.evaluationPly
  const provenance = ply === line.moves.length ? 'Final' : ply !== undefined && ply >= 0 && ply < line.moves.length ? 'Latest' : 'Saved'
  const color = line.side === 'black' ? 'Black' : 'White'
  const score = mate !== undefined ? `${color} ${mate < 0 ? '−' : '+'}M${Math.abs(mate)}` : `${color} ${cp! < 0 ? '' : '+'}${(cp! / 100).toFixed(2)}`
  const deeplyVerified = (point?.depth ?? recommendation?.depth ?? 0) >= (recommendation?.configuration?.verificationDepth ?? 24) && recommendation?.verification === 'passed' && recommendation.verificationScope === 'deep' && !recommendation.preliminary
  return { score, provenance, depth: point?.depth ?? recommendation?.depth, quality: deeplyVerified ? 'Deeply verified' : 'Preliminary' }
}
export function repertoireOutcome(line: Variation) {
  if (line.termination?.toLowerCase().includes('checkmate')) return 'Checkmate'
  if (line.result === '1/2-1/2' || /drawn game|stalemate|threefold|fifty.move|insufficient material/i.test(line.termination || '')) return 'Draw'
  if (line.termination?.toLowerCase().includes('advantage secured')) return 'Advantage secured'
  return 'Unresolved'
}
