import { Chess } from 'chess.js'
import type { Evaluation } from './engine'
import type { Variation } from './learning'
import { assessDecision, type SharpnessSettings } from './sharpness'

export const ENGINE_VERSION = 'stockfish-19-lite-single'
export type AnalysisPoint = { sharpnessVersion?: 1; evaluated?: number; legal?: number; fen: string; index: number; cp?: number; mate?: number; depth?: number; white?: number; black?: number; whiteKind: 'direct' | 'projected' | 'unavailable'; blackKind: 'direct' | 'projected' | 'unavailable'; level: 'fast' | 'deep'; engineVersion: string; candidates: number; budgetMs: number; timestamp: number }
export type SavedGameAnalysis = { version: 1; points: (AnalysisPoint | null)[] }
export type AnalysisSources = {
  cached: (fen: string, count: number, depth: number) => Evaluation[] | undefined
  analyze: (fen: string, count: number, depth: number, signal?: AbortSignal, timeoutMs?: number) => Promise<Evaluation[]>
}

// Weak ownership releases histories when saved lines leave memory. Compare UCI content
// because generators append in place and imported lines can replace individual moves.
const histories = new WeakMap<Variation['moves'], { start: string; moves: string[]; fens: string[] }>()
export function positions(line: Pick<Variation, 'startFen' | 'moves'>) {
  const cached = histories.get(line.moves)
  if (cached?.start === line.startFen && cached.moves.length === line.moves.length && line.moves.every((move, i) => move.uci === cached.moves[i])) return cached.fens
  const game = new Chess(line.startFen), result = [game.fen()]
  for (const move of line.moves) { game.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] }); result.push(game.fen()) }
  histories.set(line.moves, { start: line.startFen, moves: line.moves.map(move => move.uci), fens: result })
  return result
}

export function positionLabel(line: Pick<Variation, 'startFen' | 'moves'>, index: number) {
  const before = positions(line)[Math.max(0, index - 1)].split(' ')
  return index ? `${before[5]}${before[1] === 'w' ? '.' : '...'}${line.moves[index - 1].san}` : `Start · ${before[5]}${before[1] === 'w' ? '.' : '...'} to move`
}

export function validPoint(point: AnalysisPoint | null | undefined, fen: string, index: number) { return point?.fen === fen && point.index === index && point.engineVersion === ENGINE_VERSION && !!point.whiteKind && !!point.blackKind ? point : undefined }

// Scores on moves describe the position before that move; Stockfish scores are relative to the side to move.
export function positionEvaluation(fen: string, index: number, nextMove?: { cp?: number }, point?: AnalysisPoint | null, live?: Evaluation, generated?: Evaluation, cached?: Evaluation) {
  const game = new Chess(fen)
  if (game.isCheckmate()) return { cp: game.turn() === 'b' ? 100000 : -100000, mate: 0, winner: game.turn() === 'b' ? 'White' : 'Black' }
  const current = live || generated || cached
  if (current) return { cp: current.cp * (fen.split(' ')[1] === 'w' ? 1 : -1), mate: current.mate === undefined ? undefined : current.mate * (fen.split(' ')[1] === 'w' ? 1 : -1) }
  const saved = validPoint(point, fen, index)
  if (saved?.cp !== undefined) return { cp: saved.cp, mate: saved.mate }
  return nextMove?.cp === undefined ? undefined : { cp: nextMove.cp * (fen.split(' ')[1] === 'w' ? 1 : -1) }
}

export function recentLineEvaluation(line: Pick<Variation, 'startFen' | 'moves'>, index: number) {
  // ponytail: carry a score at most two plies while the next position is being searched.
  for (let moveIndex = index - 1; moveIndex >= Math.max(0, index - 2); moveIndex--) {
    const cp = line.moves[moveIndex]?.cp
    if (cp !== undefined) return { cp: cp * (line.startFen.split(' ')[1] === 'w' ? 1 : -1) * (moveIndex % 2 ? -1 : 1), mate: undefined, estimated: true }
  }
}

export function measuredPoint(fen: string, index: number, lines: Evaluation[], level: 'fast' | 'deep', now = Date.now(), budgetMs = level === 'fast' ? 2500 : 5000): AnalysisPoint {
  const side = fen.split(' ')[1] === 'w' ? 1 : -1
  const game = new Chess(fen), legal = game.moves().length
  const top = lines[0]
  const settings: SharpnessSettings = { depth: level === 'fast' ? 8 : 12, budgetMs: 0, candidates: lines.length, excellentCp: 30, playableCp: 70, seriousCp: 150 }
  const decision = assessDecision(fen, lines, undefined, settings)
  return { fen, index, sharpnessVersion: 1, evaluated: decision?.evaluated ?? 0, legal, ...(!legal ? { cp: game.isCheckmate() ? -100000 * side : 0, ...(game.isCheckmate() ? { mate: 0 } : {}) } : {}), ...(top ? { cp: top.cp * side, mate: top.mate === undefined ? undefined : top.mate * side, depth: top.depth } : {}), ...(decision ? fen.split(' ')[1] === 'w' ? { white: decision.score } : { black: decision.score } : {}), whiteKind: decision && fen.split(' ')[1] === 'w' ? 'direct' : 'unavailable', blackKind: decision && fen.split(' ')[1] === 'b' ? 'direct' : 'unavailable', level, engineVersion: ENGINE_VERSION, candidates: lines.length, budgetMs, timestamp: now }
}

export async function runGameAnalysis(line: Variation, existing: SavedGameAnalysis | undefined, level: 'fast' | 'deep', sources: AnalysisSources, signal: AbortSignal, onPoint: (point: AnalysisPoint, done: number, total: number) => void, fastBudgetMs = 2500) {
  const fens = positions(line)
  const points = fens.map((fen, index) => validPoint(existing?.version === 1 ? existing.points[index] : undefined, fen, index) || null)
  async function check(index: number, pass: 'fast' | 'deep', done: number, total: number) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    const old = points[index]
    const depth = pass === 'fast' ? 8 : 12, count = new Chess(fens[index]).moves().length, timeout = pass === 'fast' ? fastBudgetMs : fastBudgetMs * 2
    if (!count) { const point = measuredPoint(fens[index], index, [], pass); points[index] = point; onPoint(point, done, total); return }
    if (old && old.sharpnessVersion === 1 && old.evaluated === count && old.depth !== undefined && old.depth >= depth) { onPoint(old, done, total); return }
    try {
      const lines = sources.cached(fens[index], count, depth) || await sources.analyze(fens[index], count, depth, signal, timeout)
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      const measured = measuredPoint(fens[index], index, lines, pass, Date.now(), timeout)
      const point = old && (old.evaluated || 0) >= (measured.evaluated || 0) && (old.depth || 0) > (measured.depth || 0) ? old : measured
      points[index] = point; onPoint(point, done, total)
    } catch (error) {
      if (signal.aborted) throw error
      // ponytail: failed positions remain gaps; retry on the next explicit analysis run.
      const unavailable = old || { fen: fens[index], index, whiteKind: 'unavailable' as const, blackKind: 'unavailable' as const, level: pass, engineVersion: ENGINE_VERSION, candidates: count, budgetMs: timeout, timestamp: Date.now() }
      points[index] = unavailable; onPoint(unavailable, done, total)
    }
  }
  for (let index = 0; index < fens.length; index++) await check(index, 'fast', index + 1, fens.length)
  if (level === 'deep') {
    // ponytail: deepen only the strongest preliminary signals, capped at a quarter of the line.
    const ranked = points.map((point, index) => ({ index, weight: (point?.mate !== undefined ? 500 : 0) + Math.abs((point?.cp || 0) - (points[index - 1]?.cp || 0)) + Math.max(point?.white || 0, point?.black || 0) * 2 + (line.moves[index - 1]?.san.match(/[x+#]/) ? 100 : 0) })).sort((a, b) => b.weight - a.weight).slice(0, Math.max(1, Math.ceil(fens.length / 4))).sort((a, b) => a.index - b.index)
    for (let position = 0; position < ranked.length; position++) await check(ranked[position].index, 'deep', fens.length + position + 1, fens.length + ranked.length)
  }
  return { version: 1 as const, points }
}

export function latestSharpness(points: (AnalysisPoint | undefined)[], focus: number, side: 'white' | 'black', fens: string[]) {
  for (let index = focus; index >= 0; index--) {
    const point = points[index]
    if (fens[index]?.split(' ')[1] !== side[0]) continue
    // Do not carry an older score past a missing measurement for this side.
    return point && point[side + 'Kind' as 'whiteKind' | 'blackKind'] === 'direct' && point[side] !== undefined ? point : undefined
  }
}

export function generationScore(line: Variation) {
  const final = new Chess(positions(line).at(-1)!)
  if (final.isCheckmate()) return `Win for ${final.turn() === 'w' ? 'Black' : 'White'}`
  const cp = line.recommendation?.objectiveCp
  if (cp === undefined) return 'Evaluation unavailable'
  if (Math.abs(cp) >= 99000) return `Forced mate for ${cp > 0 ? line.side : line.side === 'white' ? 'black' : 'white'}`
  return `Latest evaluation ${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)} for ${line.side}${line.recommendation?.depth === undefined ? '' : ` at depth ${line.recommendation.depth}`}`
}
