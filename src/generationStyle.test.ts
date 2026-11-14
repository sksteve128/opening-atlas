import { Chess } from 'chess.js'
import { expect, it, vi } from 'vitest'
import { styledCandidate, styleNeedsVerification } from './generationStyle'
import { generateVariation, type Generation, type Sources } from './learning'

const fen = '7k/8/8/8/8/8/4Q3/4K3 w - - 0 1'
const choices = ['e2d3', 'e2e5', 'e2e7'].map((uci, index) => ({ cp: [30, 27, 15][index], depth: 12, line: [uci] }))

it('ranks only eligible sound Stockfish candidates after filtering, keeping best mode untouched', () => {
  const allowed = new Chess(fen).moves({ verbose: true }).map(move => move.from + move.to)
  expect(styledCandidate(fen, choices, 'best', 30, allowed)).toBeUndefined()
  expect(styledCandidate(fen, choices, 'aggressive', 30, allowed)?.entry.line[0]).toBe('e2e5')
  expect(styledCandidate(fen, choices, 'aggressive', 2, allowed)?.entry.line[0]).toBe('e2d3')
  expect(styledCandidate(fen, choices, 'aggressive', 30, allowed.filter(move => move !== 'e2e5'))?.entry.line[0]).toBe('e2e7')
  expect(styledCandidate(fen, choices.map((entry, index) => ({ ...entry, cp: [30, 27, -150][index] })), 'aggressive', 30, allowed)?.entry.line[0]).toBe('e2e5')
  expect(styledCandidate(fen, choices.map(entry => ({ ...entry, search: { multiPVComplete: false } as never })), 'aggressive', 30, allowed)).toBeUndefined()
})

it('prefers the safer legal candidate in solid mode when evaluations are close', () => {
  const start = new Chess(); start.move('e4'); start.move('e5')
  const position = start.fen(), entries = ['g1f3', 'b1c3', 'f2f4'].map((uci, index) => ({ cp: [30, 27, 25][index], depth: 12, line: [uci] }))
  const allowed = entries.map(entry => entry.line[0])
  expect(styledCandidate(position, entries, 'solid', 30, allowed)?.entry.line[0]).toBe('b1c3')
})

it('flags tactical candidate lines for deeper verification', () => {
  expect(styleNeedsVerification(fen, ['e2e5'])).toBe(true)
  expect(styleNeedsVerification(fen, ['e2d3'])).toBe(false)
})

it('applies style only to the user in complete-game generation', async () => {
  const game = new Chess()
  for (const san of ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6']) game.move(san)
  const options: Generation = { opening: 'London', startFen: game.fen(), prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2000], speeds: ['rapid'] }, maxPlies: 1, engineDepth: 16, tolerance: 35, mode: 'here', playMode: 'complete', style: 'aggressive', styleToleranceCp: 30 }
  const source: Sources = {
    explorer: async () => ({ source: 'book', white: 0, draws: 0, black: 0, moves: [] }),
    analyze: vi.fn(async (_fen, count, depth, _signal, _timeout, _refresh, searchMoves) => count === 4
      ? ['g1f3', 'c2c4', 'b1d2', 'f1d3'].map((uci, index) => ({ cp: [30, 25, 10, 5][index], depth, line: [uci] }))
      : [{ cp: searchMoves?.[0] === 'c2c4' ? 25 : 30, depth, line: [searchMoves?.[0] || 'g1f3'] }]),
  }
  const line = await generateVariation(options, [], source)
  expect(line.moves[0]).toMatchObject({ uci: 'c2c4', style: { lossCp: 5 } })
  expect(line.style).toBe('aggressive')
})
