import { Chess, type Square } from 'chess.js'
import type { Evaluation } from './engine'

export type GenerationStyle = 'best' | 'aggressive' | 'solid'

export function styleScore(fen: string, uci: string, style: Exclude<GenerationStyle, 'best'>) {
  const game = new Chess(fen), color = game.turn(), enemy = color === 'w' ? 'b' : 'w'
  const played = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  const pieces = game.board().flat().filter(piece => piece !== null)
  const king = pieces.find(piece => piece.color === (style === 'aggressive' ? enemy : color) && piece.type === 'k')!
  const file = king.square.charCodeAt(0), rank = Number(king.square[1])
  const ring = [-1, 0, 1].flatMap(df => [-1, 0, 1].map(dr => `${String.fromCharCode(file + df)}${rank + dr}`)).filter(square => /^[a-h][1-8]$/.test(square)) as Square[]
  const attacked = ring.filter(square => game.isAttacked(square, style === 'aggressive' ? color : enemy)).length
  const replies = game.moves({ verbose: true })
  const forcing = replies.filter(move => move.captured || move.promotion || /[+#]/.test(move.san)).length
  if (style === 'aggressive') {
    const pawnbreak = played.piece === 'p' && 'cdef'.includes(played.to[0]) && ['4', '5'].includes(played.to[1]) ? 1 : 0
    const oppositeCastling = /O-O/.test(played.san) && pieces.some(piece => piece.color === enemy && piece.type === 'k' && (piece.square[0] === 'c' || piece.square[0] === 'g') && piece.square[0] !== played.to[0]) && attacked > 0 ? 1 : 0
    return attacked * 3 + pawnbreak * 2 + oppositeCastling + Number(/[+#]/.test(played.san)) * 0.5
  }
  const defended = pieces.filter(piece => piece.color === color && piece.type !== 'k' && game.isAttacked(piece.square, color)).length
  const pawnFiles = 'abcdefgh'.split('').map(file => pieces.filter(piece => piece.color === color && piece.type === 'p' && piece.square[0] === file).length)
  const doubled = pawnFiles.reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  return defended - attacked * 3 - forcing - doubled * 2
}

export function styleNeedsVerification(fen: string, line: string[]) {
  const game = new Chess(fen)
  let forcing = 0
  for (const uci of line.slice(0, 4)) {
    try {
      const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
      if (move.captured || move.promotion || /[+#]/.test(move.san)) forcing++
      if (forcing >= 2) return true
    } catch { return true }
  }
  return forcing > 0
}

// Discovery is provisional. The caller verifies the chosen move against full-depth single-PV scores.
export function styledCandidate(fen: string, entries: Evaluation[], style: GenerationStyle, toleranceCp: number, allowed: string[]) {
  if (style === 'best' || !entries.length || entries.some(entry => entry.search?.multiPVComplete === false)) return undefined
  const legal = new Set(new Chess(fen).moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || '')))
  const ranked = entries.filter(entry => legal.has(entry.line[0]) && allowed.includes(entry.line[0]) && Number.isFinite(entry.cp) && entry.mate === undefined && entry.depth >= 10).sort((a, b) => b.cp - a.cp)
  if (!ranked.length) return undefined
  const best = ranked[0]
  const sound = ranked.filter(entry => best.cp - entry.cp <= toleranceCp)
  return sound.map(entry => ({ entry, score: styleScore(fen, entry.line[0], style) })).sort((a, b) => b.score - a.score || b.entry.cp - a.entry.cp)[0]
}
