import { Chess, type Square } from 'chess.js'
import { playUci, type Side } from './core'

export type Premove = { uci: string; fen: string }

export function queuePremove(fen: string, uci: string, side: Side): Premove | null {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) || uci.slice(0, 2) === uci.slice(2, 4)) return null
  const board = new Chess(fen), color = side === 'white' ? 'w' : 'b'
  return board.turn() !== color && board.get(uci.slice(0, 2) as Square)?.color === color ? { uci, fen } : null
}

export function premoveStatus(premove: Premove, fen: string): 'waiting' | 'play' | 'cancel' {
  if (premove.fen === fen) return 'waiting'
  const ply = (position: string) => Number(position.split(' ')[5]) * 2 + Number(position.split(' ')[1] === 'b')
  return ply(fen) === ply(premove.fen) + 1 && playUci(fen, premove.uci) ? 'play' : 'cancel'
}
