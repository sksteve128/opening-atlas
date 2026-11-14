import { Chess } from 'chess.js'
import { expect, it } from 'vitest'
import { generationScore, latestSharpness, measuredPoint, positionEvaluation, positionLabel, positions, recentLineEvaluation, runGameAnalysis, validPoint } from './gameAnalysis'
import { nearestGraphIndex } from './AnalysisGraphs'
import type { Variation } from './learning'
import type { Evaluation } from './engine'

it('keeps move numbers and direct sharpness tied to the actual side to move', () => {
  const game = new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 18')
  const start = game.fen(), move = game.move('e5')
  const line = { startFen: start, moves: [{ uci: move.from + move.to, san: move.san }] } as Variation
  expect(positions(line)).toHaveLength(2)
  expect(positionLabel(line, 0)).toContain('18...')
  expect(positionLabel(line, 1)).toBe('18...e5')
  const evaluated: Evaluation[] = ['e7e5', 'd7d5', 'g8f6', 'c7c5'].map((uci, index) => ({ cp: [40, 10, -100, -180][index], depth: 8, line: [uci] }))
  const point = measuredPoint(start, 0, evaluated, 'fast', 1)
  expect(point.cp).toBe(-40)
  expect(point.black).toBeTypeOf('number')
  expect(point.white).toBeUndefined()
  expect(point.blackKind).toBe('direct')
  expect(point.whiteKind).toBe('unavailable')
  expect(validPoint(point, start, 1)).toBeUndefined()
  expect(validPoint({ ...point, engineVersion: 'old-engine' }, start, 0)).toBeUndefined()
})

it('maps both ends and the midpoint of a compressed long game to exact plies', () => {
  expect(nearestGraphIndex(42, 201)).toBe(0)
  expect(nearestGraphIndex(300, 201)).toBe(100)
  expect(nearestGraphIndex(558, 201)).toBe(200)
})

it('updates progressively, reuses saved analysis, and stops on cancellation', async () => {
  const game = new Chess(), start = game.fen(), move = game.move('e4')
  const line = { startFen: start, moves: [{ uci: move.from + move.to, san: move.san }] } as Variation
  let calls = 0
  const sources = { cached: () => undefined, analyze: async (fen: string, count: number): Promise<Evaluation[]> => { calls++; const moves = new Chess(fen).moves({ verbose: true }); expect(count).toBe(moves.length); return moves.map(move => ({ cp: 0, depth: 8, line: [move.from + move.to + (move.promotion || '')] })) } }
  const seen: number[] = []
  const saved = await runGameAnalysis(line, undefined, 'fast', sources, new AbortController().signal, (_point, done) => seen.push(done))
  expect(seen).toEqual([1, 2])
  expect(saved.points).toHaveLength(2)
  expect(saved.points[0]?.cp).toBe(0)
  await runGameAnalysis(line, JSON.parse(JSON.stringify(saved)), 'fast', sources, new AbortController().signal, () => {})
  expect(calls).toBe(2)
  const controller = new AbortController(); controller.abort()
  await expect(runGameAnalysis(line, undefined, 'fast', sources, controller.signal, () => {})).rejects.toMatchObject({ name: 'AbortError' })
  const midrun = new AbortController(), reached: number[] = []
  await expect(runGameAnalysis(line, undefined, 'fast', sources, midrun.signal, (_point, done) => { reached.push(done); midrun.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  expect(reached).toEqual([1])
})

it('keeps mates and unavailable engine results distinct from measured draws', () => {
  const fen = new Chess().fen()
  const mate = measuredPoint(fen, 0, [{ cp: 99997, mate: 3, depth: 12, line: ['e2e4'] }], 'deep')
  expect(mate.mate).toBe(3)
  expect(mate.cp).toBe(99997)
  const missing = measuredPoint(fen, 0, [], 'fast')
  expect(missing.cp).toBeUndefined()
  expect(missing.mate).toBeUndefined()
  expect(missing.whiteKind).toBe('unavailable')
})

it('uses the evaluation for the displayed ply when live analysis lags behind playback', () => {
  const game = new Chess(), before = game.fen()
  game.move('e4')
  const after = game.fen()
  const saved = measuredPoint(after, 1, [{ cp: -45, depth: 8, line: ['e7e5'] }], 'fast')
  expect(positionEvaluation(before, 0, { cp: 20 })?.cp).toBe(20)
  expect(positionEvaluation(after, 1, { cp: -30 }, saved)?.cp).toBe(45)
  expect(positionEvaluation(after, 1, { cp: -30 }, saved, undefined, { cp: -60, depth: 8, line: ['e7e5'] })?.cp).toBe(60)
  expect(positionEvaluation(after, 1, { cp: -30 }, saved, { cp: -70, depth: 18, line: ['e7e5'] })?.cp).toBe(70)
  expect(positionEvaluation(after, 1, undefined, { ...saved, fen: before })).toBeUndefined()
})

it('carries the latest scored move through a short generation gap with the correct color', () => {
  const line = { startFen: new Chess().fen(), moves: [{ cp: 40 }, {}, { cp: 30 }, {}] } as Variation
  expect(recentLineEvaluation(line, 1)?.cp).toBe(40)
  expect(recentLineEvaluation(line, 2)?.cp).toBe(40)
  expect(recentLineEvaluation(line, 4)?.cp).toBe(30)
  expect(recentLineEvaluation(line, 0)).toBeUndefined()
  const blackStart = { startFen: new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1').fen(), moves: [{ cp: 25 }] } as Variation
  expect(recentLineEvaluation(blackStart, 1)?.cp).toBe(-25)
})

it('deepens only selected critical positions after the fast pass', async () => {
  const game = new Chess(), startFen = game.fen()
  const moves = ['e4', 'e5', 'Nf3', 'Nc6'].map(san => { const move = game.move(san); return { uci: move.from + move.to, san: move.san } })
  const line = { startFen, moves } as Variation
  const calls: number[] = []
  const result = await runGameAnalysis(line, undefined, 'deep', { cached: () => undefined, analyze: async (fen, count, depth) => { calls.push(depth); const legal = new Chess(fen).moves({ verbose: true }); expect(count).toBe(legal.length); return legal.map(move => ({ cp: calls.length === 3 ? 200 : 10, depth, line: [move.from + move.to + (move.promotion || '')] })) } }, new AbortController().signal, () => {})
  expect(calls.filter(depth => depth === 8)).toHaveLength(5)
  expect(calls.filter(depth => depth === 12)).toHaveLength(2)
  expect(result.points.filter(point => point?.level === 'deep')).toHaveLength(2)
})

it('uses the checkmate winner instead of stale or missing engine evaluations', () => {
  for (const [fen, winner, cp] of [
    ['7k/6Q1/5K2/8/8/8/8/8 b - - 0 1', 'White', 100000],
    ['8/8/8/8/8/5k2/6q1/7K w - - 0 1', 'Black', -100000],
  ] as const) {
    expect(new Chess(fen).isCheckmate()).toBe(true)
    expect(positionEvaluation(fen, 0)).toEqual({ winner, cp, mate: 0 })
    expect(positionEvaluation(fen, 0, undefined, undefined, { cp: 0, depth: 18, line: [] })).toEqual({ winner, cp, mate: 0 })
  }
})

it('measures losing alternatives instead of calling a top-four sample forgiving', async () => {
  const game = new Chess(), fen = game.fen(), legal = game.moves({ verbose: true })
  const evaluations = legal.map((move, i) => ({ cp: i < 4 ? 0 : -300, depth: 8, line: [move.from + move.to] }))
  const partial = measuredPoint(fen, 0, evaluations.slice(0, 4), 'fast')
  expect(partial.white).toBe(0)
  expect(partial.evaluated).toBe(4)
  let calls = 0
  const result = await runGameAnalysis({ startFen: fen, moves: [] } as unknown as Variation, { version: 1, points: [partial] }, 'fast', { cached: () => undefined, analyze: async (_fen, count) => { calls++; expect(count).toBe(20); return evaluations } }, new AbortController().signal, () => {})
  expect(calls).toBe(1)
  expect(result.points[0]?.white).toBeGreaterThan(0)
  expect(result.points[0]?.evaluated).toBe(20)
})
it('shows each side at its own last decision without inventing scores across missing samples', () => {
  const game = new Chess(), fens = [game.fen()]; game.move('e4'); fens.push(game.fen()); game.move('e5'); fens.push(game.fen())
  const point = (fen: string, index: number) => measuredPoint(fen, index, new Chess(fen).moves({ verbose: true }).map((move, i) => ({ cp: -i * 30, depth: 8, line: [move.from + move.to] })), 'fast')
  const points = fens.map(point)
  expect(latestSharpness(points, 1, 'white', fens)?.index).toBe(0)
  expect(latestSharpness(points, 1, 'black', fens)?.index).toBe(1)
  expect(latestSharpness([points[0], points[1], undefined], 2, 'white', fens)).toBeUndefined()
  expect(latestSharpness(points, 0, 'black', fens)).toBeUndefined()
})
it('records terminal scores without an engine search or fictitious sharpness', async () => {
  const fen = '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1'
  const result = await runGameAnalysis({ startFen: fen, moves: [] } as unknown as Variation, undefined, 'fast', { cached: () => undefined, analyze: async () => { throw new Error('Terminal positions must not search') } }, new AbortController().signal, () => {})
  expect(result.points[0]).toMatchObject({ cp: 100000, mate: 0, legal: 0, evaluated: 0 })
  expect(result.points[0]?.black).toBeUndefined()
})

it('shows a checkmate win rather than the mate score encoded as centipawns', () => {
  const game = new Chess(), startFen = game.fen()
  const moves = ['f3', 'e5', 'g4', 'Qh4#'].map(san => { const move = game.move(san); return { uci: move.from + move.to, san } })
  const line = { startFen, moves, side: 'black', recommendation: { objectiveCp: 99999, depth: 18 } } as Variation
  expect(generationScore(line)).toBe('Win for Black')
  expect(generationScore({ ...line, side: 'white' })).toBe('Win for Black')
  expect(generationScore({ ...line, moves: [] })).toBe('Forced mate for black')
  expect(generationScore({ ...line, moves: [], recommendation: { verification: 'pending', objectiveCp: 80, depth: 18 } })).toBe('Latest evaluation +0.80 for black at depth 18')
})
