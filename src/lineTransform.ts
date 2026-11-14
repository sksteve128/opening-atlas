import { Chess, type Square } from 'chess.js'
import type { Variation } from './learning'

export type Perspective = 'normal' | 'reverse' | 'mirror' | 'combined'
const separator = '::perspective:'
export const originalLineId = (id: string) => id.split(separator)[0]
export function linePerspective(id: string): Perspective {
  const mode = id.split(separator)[1]
  return mode === 'reverse' || mode === 'mirror' || mode === 'combined' ? mode : 'normal'
}
export function transformSquare(square: string, mode: Perspective): Square {
  const file = square.charCodeAt(0) - 97, rank = Number(square[1]) - 1
  return `${String.fromCharCode(97 + (mode === 'mirror' || mode === 'combined' ? 7 - file : file))}${1 + (mode === 'reverse' || mode === 'combined' ? 7 - rank : rank)}` as Square
}
export function transformFen(fen: string, mode: Perspective): string {
  const original = new Chess(fen)
  if (mode === 'normal') return original.fen()
  const reverse = mode === 'reverse' || mode === 'combined'
  const fields = fen.split(' ')
  if ((mode === 'mirror' || mode === 'combined') && fields[2] !== '-') throw new Error('Mirror Files is unavailable for lines with castling rights: reflecting files moves the king away from its standard castling square.')
  const rows = Array.from({ length: 8 }, () => Array<string>(8).fill(''))
  for (const row of original.board()) for (const piece of row) if (piece) {
    const target = transformSquare(piece.square, mode)
    const color = reverse ? piece.color === 'w' ? 'b' : 'w' : piece.color
    rows[8 - Number(target[1])][target.charCodeAt(0) - 97] = color === 'w' ? piece.type.toUpperCase() : piece.type
  }
  fields[0] = rows.map(row => { let text = '', empty = 0; for (const piece of row) { if (!piece) empty++; else { if (empty) text += empty; empty = 0; text += piece } } return text + (empty || '') }).join('/')
  if (reverse) {
    fields[1] = fields[1] === 'w' ? 'b' : 'w'
    const swapped = fields[2].split('').map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join('')
    fields[2] = 'KQkq'.split('').filter(c => swapped.includes(c)).join('') || '-'
  }
  if (fields[3] !== '-') fields[3] = transformSquare(fields[3], mode)
  const transformed = new Chess(fields.join(' '))
  return transformed.fen({ forceEnpassantSquare: true })
}
export function transformLine(line: Variation, mode: Perspective): Variation {
  if (mode === 'normal') return line
  const original = new Chess(line.startFen), startFen = transformFen(line.startFen, mode), game = new Chess(startFen)
  const moves = line.moves.map((move, index) => {
    original.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] })
    const uci = transformSquare(move.uci.slice(0, 2), mode) + transformSquare(move.uci.slice(2, 4), mode) + move.uci.slice(4)
    try { const played = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); return { uci, san: played.san, source: move.source } }
    catch { throw new Error(`Cannot replay transformed move ${index + 1} (${move.san}). This perspective is unavailable for practice.`) }
  })
  const reversed = mode === 'reverse' || mode === 'combined'
  // Transient view only: omit original evaluations and generation claims.
  return { id: originalLineId(line.id) + separator + mode, opening: line.opening, name: line.name, customName: line.customName, startFen, moves, pgn: game.pgn(), side: reversed ? line.side === 'white' ? 'black' : 'white' : line.side, database: line.database, filters: line.filters, created: line.created, stats: { firstTry: 0, errors: 0, reveals: 0, completions: 0, totalMs: 0 }, endPosition: game.fen(), fallback: false, imported: true }
}
