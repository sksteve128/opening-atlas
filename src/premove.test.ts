import { expect, test } from 'vitest'
import { Chess } from 'chess.js'
import { premoveStatus, queuePremove } from './premove'

test('queues the second a-pawn move, waits for White, then checks legality', () => {
  const board = new Chess(); board.move('d4'); board.move('a5')
  const queued = queuePremove(board.fen(), 'a5a4', 'black')!
  expect(queued).not.toBeNull()
  expect(premoveStatus(queued, board.fen())).toBe('waiting')
  expect(queuePremove(board.fen(), 'd4d5', 'black')).toBeNull()
  expect(queuePremove(board.fen(), 'a5a5', 'black')).toBeNull()
  board.move('e4')
  expect(premoveStatus(queued, board.fen())).toBe('play')
  expect(queuePremove(board.fen(), 'a5a4', 'black')).toBeNull()
  board.move('h6'); board.move('e5')
  expect(premoveStatus(queued, board.fen())).toBe('cancel')
})

test('cancels a premove made illegal by the opponent reply', () => {
  const board = new Chess(); board.move('d4'); board.move('a5')
  const queued = queuePremove(board.fen(), 'a5a4', 'black')!
  board.move('a4')
  expect(premoveStatus(queued, board.fen())).toBe('cancel')
})
