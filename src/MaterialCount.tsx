import { Chess } from 'chess.js'
import type { Side } from './core'

const values = { p: 1, n: 3, b: 3, r: 5, q: 9 }
const symbols = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' }
const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' }

export function materialBalance(fen: string) {
  const counts = { white: { p: 0, n: 0, b: 0, r: 0, q: 0 }, black: { p: 0, n: 0, b: 0, r: 0, q: 0 } }
  for (const piece of new Chess(fen).board().flat()) {
    if (piece && piece.type !== 'k') counts[piece.color === 'w' ? 'white' : 'black'][piece.type]++
  }
  const pieces = { white: '', black: '' }, descriptions = { white: [] as string[], black: [] as string[] }
  let score = 0
  for (const type of ['p', 'n', 'b', 'r', 'q'] as const) {
    const difference = counts.white[type] - counts.black[type]
    score += difference * values[type]
    const side = difference > 0 ? 'white' : 'black', amount = Math.abs(difference)
    pieces[side] += symbols[type].repeat(amount)
    if (amount) descriptions[side].push(`${amount} ${names[type]}${amount > 1 ? 's' : ''}`)
  }
  return { pieces, descriptions, score }
}

export default function MaterialCount({ material, side }: { material: ReturnType<typeof materialBalance>; side: Side }) {
  const advantage = material.score * (side === 'white' ? 1 : -1)
  const label = `${side === 'white' ? 'White' : 'Black'} material: ${material.descriptions[side].join(', ') || 'no extra pieces'}; ${advantage > 0 ? `ahead by ${advantage}` : advantage < 0 ? `behind by ${-advantage}` : 'equal value'}`
  return <div className="material-count" aria-label={label} title={label}><span className="material-pieces" aria-hidden="true">{material.pieces[side]}</span>{advantage > 0 && <span aria-hidden="true">+{advantage}</span>}</div>
}
