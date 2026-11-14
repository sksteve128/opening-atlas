import { expect, test } from 'vitest'
import { Chess } from 'chess.js'
import { materialBalance } from './MaterialCount'

test('equal material stays empty', () => {
  expect(materialBalance(new Chess().fen())).toMatchObject({ pieces: { white: '', black: '' }, score: 0 })
})

test('captures update material and undo restores it', () => {
  const game = new Chess(); for (const san of ['e4', 'd5', 'exd5']) game.move(san)
  expect(materialBalance(game.fen())).toMatchObject({ pieces: { white: '♟', black: '' }, score: 1 })
  game.undo()
  expect(materialBalance(game.fen()).score).toBe(0)
})

test('shows opposing imbalances and net score like the reference', () => {
  expect(materialBalance('4k3/p7/8/8/8/8/8/3QK3 w - - 0 1')).toMatchObject({ pieces: { white: '♛', black: '♟' }, score: 8 })
})

test('counts promoted pieces without assuming starting material', () => {
  expect(materialBalance('4k3/8/8/8/8/8/8/2QQK3 w - - 0 1')).toMatchObject({ pieces: { white: '♛♛', black: '' }, score: 18 })
})
