import { Chess } from 'chess.js'
import { identity } from './core'
import { positions } from './gameAnalysis'
import type { Generation, LineMove, Variation } from './learning'

export type Branch = { version: 1; fen: string; ply: number; divergencePly?: number; kind: 'mainline' | 'opponent variation' | 'alternative repertoire move'; source: string }
export type KnownHistory = { startFen: string; moves: string[]; index: number; opening: string; parentId?: string }
export function restoreKnownHistory(value: unknown, displayedFen?: string): KnownHistory | undefined {
  try {
    const h = value as KnownHistory
    if (!h || typeof h.startFen !== 'string' || !Array.isArray(h.moves) || !h.moves.every(m => typeof m === 'string') || !Number.isInteger(h.index) || h.index < 0 || h.index > h.moves.length || typeof h.opening !== 'string') return
    const fens = positions({ startFen: h.startFen, moves: h.moves.map(uci => ({ uci, san: '', source: 'preset' })) })
    if (displayedFen && fens[h.index] !== new Chess(displayedFen).fen()) return
    return h
  } catch { return }
}
export function branchVariation(line: Variation, options: Pick<Generation, 'startFen' | 'prefix' | 'opening' | 'parentId' | 'playMode' | 'sourceGame'>, parent?: Variation): Variation {
  const fens = positions(line), ply = options.prefix.length
  if (line.startFen !== options.startFen || options.prefix.some((m, i) => line.moves[i]?.uci !== m.uci)) throw new Error('Generated continuation lost its inherited history.')
  let divergencePly: number | undefined
  if (parent && parent.startFen === line.startFen) {
    const first = line.moves.findIndex((m, i) => parent.moves[i] && parent.moves[i].uci !== m.uci)
    if (first >= 0) divergencePly = first
  }
  if (divergencePly === undefined && !line.branch) { const explored = line.moves.findIndex((move,i) => i >= ply && move.exploration?.deviation); if (explored >= 0) divergencePly = explored }
  const deviation = divergencePly === undefined ? undefined : new Chess(fens[divergencePly])
  const branch: Branch = { version: 1, fen: fens[ply], ply, divergencePly, kind: !deviation ? 'mainline' : deviation.turn() === line.side[0] ? 'alternative repertoire move' : 'opponent variation', source: options.playMode === 'complete' ? 'engine' : 'human' }
  const first = divergencePly ?? ply
  const game = new Chess(fens[first]), move = line.moves[first]
  const notation = move ? game.moveNumber() + (game.turn() === 'w' ? '.' : '...') + move.san : 'continuation'
  return { ...line, ...(options.sourceGame ? { sourceGame: options.sourceGame } : {}), opening: options.opening, openingId: parent?.openingId || line.openingId || options.opening + '|' + identity(line.startFen), parentId: options.parentId, branch: line.branch || branch, name: options.opening + ' — ' + notation + ' variation' }
}
export function branchLabel(line: Variation) {
  if (!line.branch) return ''
  const game = new Chess(line.branch.fen)
  return 'Generated from move ' + game.moveNumber() + (game.turn() === 'b' ? ' (Black)' : '')
}
export function divergenceLabel(line: Variation) {
  const ply = line.branch?.divergencePly
  if (ply === undefined || !line.moves[ply]) return ''
  const game = new Chess(positions(line)[ply])
  return 'First deviation: ' + game.moveNumber() + (game.turn() === 'w' ? '.' : '...') + line.moves[ply].san
}
// Positions are shared; each traversal retains its own path and move order.
export function buildOpeningTree(lines: Variation[]) {
  const nodes = new Map<string, { visits: { lineId: string; ply: number; side: Variation['side'] }[]; edges: Map<string, { to: string; lineIds: string[] }> }>()
  for (const line of lines) {
    let fens: string[]
    try { fens = positions(line) } catch { continue }
    fens.forEach((fen, ply) => {
      const key = identity(fen)
      const node = nodes.get(key) || { visits: [] as { lineId: string; ply: number; side: Variation['side'] }[], edges: new Map<string, { to: string; lineIds: string[] }>() }
      node.visits.push({ lineId: line.id, ply, side: line.side })
      if (line.moves[ply]) {
        const uci = line.moves[ply].uci
        const edge = node.edges.get(uci) || { to: identity(fens[ply + 1]), lineIds: [] }
        if (!edge.lineIds.includes(line.id)) edge.lineIds.push(line.id)
        node.edges.set(uci, edge)
      }
      nodes.set(key, node)
    })
  }
  return nodes
}
export function migrateVariations(lines: Variation[]): Variation[] {
  const migrated = new Map<string, Variation>(), visiting = new Set<string>()
  const visit = (line: Variation): Variation => {
    if (migrated.has(line.id)) return migrated.get(line.id)!
    visiting.add(line.id)
    const result = migrate(line)
    visiting.delete(line.id); migrated.set(line.id, result)
    return result
  }
  const migrate = (line: Variation): Variation => {
    if (line.branch || !line.parentId) return line
    const originalParent = lines.find(p => p.id === line.parentId && p.id !== line.id)
    if (!originalParent || visiting.has(originalParent.id)) return line
    const parent = visit(originalParent)
    try {
      const parentFens = positions(parent)
      let prefix: LineMove[] = []
      if (line.startFen !== parent.startFen) {
        const matches = parentFens.flatMap((fen, i) => fen === line.startFen ? [i] : [])
        if (matches.length !== 1) return line
        prefix = parent.moves.slice(0, matches[0])
      } else {
        // The original generation point cannot be recovered from the common prefix.
        // Keep history intact and the reliable parent link without inventing a branch point.
        return { ...line, openingId: parent.openingId || parent.opening + '|' + identity(parent.startFen), opening: line.opening === 'Custom position' ? parent.opening : line.opening, name: line.opening === 'Custom position' && line.name.startsWith('Custom position') ? line.name.replace('Custom position', parent.opening) : line.name }
      }
      const game = new Chess(parent.startFen), moves = [...prefix, ...line.moves]
      for (const m of moves) game.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] })
      const restored = { ...line, recommendation: line.recommendation ? { ...line.recommendation, evaluationPly: line.recommendation.evaluationPly === undefined ? undefined : line.recommendation.evaluationPly + prefix.length, populationAttempts: line.recommendation.populationAttempts?.map(p => ({ ...p, ply: p.ply + prefix.length })) } : undefined, startFen: parent.startFen, moves, pgn: game.pgn(), analysis: line.analysis ? { ...line.analysis, points: [...Array(prefix.length).fill(null), ...line.analysis.points.map(p => p ? { ...p, index: p.index + prefix.length } : null)] } : undefined }
      return branchVariation(restored, { startFen: parent.startFen, prefix, opening: parent.opening, parentId: parent.id, playMode: line.generationMode }, parent)
    } catch { return line }
  }
  return lines.map(visit)
}
