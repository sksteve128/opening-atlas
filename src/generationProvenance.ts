import { Chess } from 'chess.js'
import type { Variation, LineMove } from './learning'
import { moveNumber } from './learning'
import { positions } from './gameAnalysis'

export function moveSource(move: LineMove): string {
 if (move.source === 'engine') return move.aggressive && !move.aggressive.rejected && move.aggressive.selected !== move.aggressive.stockfish ? 'Patricia (Stockfish checked)' : move.exploration || move.castling?.accepted || move.style ? 'Stockfish candidates · configured preference' : 'Stockfish'
 if (move.source === 'model') return 'Maia'
 return ({lichess:'Lichess',masters:'Masters',tablebase:'Tablebase',book:'Published line'} as Record<string,string>)[move.source] || 'Source unavailable'
}
export function generationProvenance(line: Variation) {
 const fens = positions(line)
 let boundary: number | undefined
 const branch = line.branch
 if (branch && Number.isInteger(branch.ply) && branch.ply >= 0 && branch.ply <= line.moves.length) {
  try { if (new Chess(branch.fen).fen() === fens[branch.ply]) boundary = branch.ply } catch { /* Invalid historical boundary remains unknown. */ }
 } else if (!branch) {
  // Only an explicitly marked, contiguous preset prefix supports legacy recovery.
  const first = line.moves.findIndex(move => move.source !== 'preset')
  if (first > 0 && line.moves.slice(first).every(move => move.source !== 'preset' && move.source !== 'import')) boundary = first
 }
 const entries = line.moves.map((move,index) => ({index,move,label:moveNumber(fens[index],move.san),opponent:fens[index].split(' ')[1] !== line.side[0],contextual:boundary !== undefined ? index < boundary : move.source === 'preset',source:moveSource(move)}))
 const start = boundary === undefined ? 'Generation boundary unavailable' : boundary > 0 ? `After ${entries[boundary - 1].label}` : line.startFen === new Chess().fen() ? 'At starting position' : `At supplied position · move ${fens[0].split(' ')[5]} · ${new Chess(line.startFen).turn() === 'w' ? 'White' : 'Black'} to move`
 const context = entries.filter(entry => entry.contextual).map(entry => entry.label).join(' ')
 return {boundary,start,context,entries}
}
