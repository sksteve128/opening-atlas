import { Chess } from 'chess.js'
import { expect, it } from 'vitest'
import { analyzeFastSharpness, analyzeSharpness, assessDecision, invalidateFastSharpness, type SharpnessSettings } from './sharpness'
import type { Evaluation } from './engine'

const settings: SharpnessSettings = { depth: 16, budgetMs: 10000, excellentCp: 30, playableCp: 70, seriousCp: 150 }
const start = new Chess().fen()
function entries(fen: string, scores: number[], depth = 16): Evaluation[] {
  return new Chess(fen).moves({ verbose: true }).slice(0, scores.length).map((move, index) => ({ cp: scores[index], depth, line: [move.from + move.to + (move.promotion || '')] }))
}

it('uses move losses rather than the absolute evaluation in equal and advantageous positions', () => {
  const equal = assessDecision(start, entries(start, [20, 10, 0, -180]), undefined, settings)!
  const winning = assessDecision(start, entries(start, [220, 210, 200, 20]), undefined, settings)!
  expect(equal.score).toBe(winning.score)
  expect(equal.acceptable).toBe(3)
  expect(equal.serious).toBe(1)
  expect(equal.evaluated).toBe(4)
  expect(equal.legal).toBe(20)
})

it('uses zero when checked moves show no loss while exposing incomplete candidate coverage', () => {
  const partial = assessDecision(start, entries(start, [20, 10, 0, -10]), undefined, settings)!
  expect(partial).toMatchObject({ score: 0, evaluated: 4, legal: 20, coverage: 0.2, preliminary: true })
  const full = assessDecision(start, entries(start, Array(20).fill(0)), undefined, settings)!
  expect(full).toMatchObject({ score: 0, coverage: 1, preliminary: false })
  expect(assessDecision(start, [], undefined, settings)).toBeUndefined()
  expect(assessDecision(start, entries(start, [20, 10, 0, -10]).map(entry => ({ ...entry, search: { multiPVComplete: false } as never })), undefined, settings)).toBeUndefined()
})

it('adds only a small forcingness signal when tactical choices also carry serious loss', () => {
  const fen = '4k3/8/8/8/3Q4/8/8/4K3 w - - 0 1'
  const legal = new Chess(fen).moves({ verbose: true })
  const scoreMoves = (sans: string[]) => sans.map((san, index) => { const move = legal.find(item => item.san === san)!; return { cp: [50, 40, 30, -200][index], depth: 16, line: [move.from + move.to] } })
  const quiet = assessDecision(fen, scoreMoves(['Qc5', 'Qb6', 'Qa7', 'Qd5']), undefined, settings)!
  const tactical = assessDecision(fen, scoreMoves(['Qd7+', 'Qd8+', 'Qe5+', 'Qh8+']), undefined, settings)!
  expect(quiet.forcing).toBe(0)
  expect(tactical.forcing).toBe(4)
  expect(tactical.score).toBe(quiet.score + 5)
})

it('treats a sole forced legal move as straightforward and handles mate scores separately', () => {
  const fen = '7k/6Q1/4K3/8/8/8/8/8 b - - 0 1'
  expect(assessDecision(fen, [{ cp: -99999, mate: -1, depth: 16, line: ['h8g7'] }], undefined, settings)).toMatchObject({ score: 0, legal: 1, evaluated: 1, preliminary: false })
  const mate = entries(start, [99997, 99995, 20, -100]).map((entry, index) => index < 2 ? { ...entry, mate: index + 2 } : entry)
  expect(assessDecision(start, mate, undefined, settings)?.moves.map(move => move.lossCp)).toEqual([null, null, null, null])
})

it('uses only real game counts for measured human serious-move share', () => {
  const moves = entries(start, [50, 40, 30, -200])
  const data = { white: 100, draws: 0, black: 0, source: 'lichess', moves: moves.map((move, index) => ({ uci: move.line[0], san: 'move', white: [40, 25, 20, 15][index], draws: 0, black: 0 })) } as const
  const withHumans = assessDecision(start, moves, data, settings)!
  const engineOnly = assessDecision(start, moves, { ...data, source: 'book' }, settings)!
  expect(withHumans.humanErrorShare).toBe(0.15)
  expect(withHumans.score).toBeGreaterThan(engineOnly.score)
  expect(engineOnly.humanErrorShare).toBeUndefined()
})

it('reports insufficient analysis when MultiPV is too narrow or too shallow', () => {
  expect(assessDecision(start, entries(start, [20, 10, 0]), undefined, settings)).toBeUndefined()
  expect(assessDecision(start, entries(start, [20, 10, 0, -20], 10), undefined, settings)).toBeUndefined()
})

it('projects the opposite side only after real candidate moves, for both colors', async () => {
  const afterE4 = new Chess(); afterE4.move('e4')
  for (const fen of [start, afterE4.fen()]) {
    const game = new Chess(fen)
    const calls: string[] = []
    const result = await analyzeSharpness(fen, { ...settings, cacheKey: `side-${fen}` }, {
      analyze: async (position, _count, depth) => { calls.push(position); return entries(position, [30, 20, 10, -100], depth) },
    })
    expect(calls[0]).toBe(fen)
    expect(calls).toHaveLength(3)
    expect(result.white).toBeDefined()
    expect(result.black).toBeDefined()
    expect(result.whiteProjected).toBe(game.turn() === 'b')
    expect(result.blackProjected).toBe(game.turn() === 'w')
    expect(result.continuations).toHaveLength(2)
  }
})

it('includes a common human continuation when it is among the evaluated candidates', async () => {
  const options = entries(start, [40, 30, 20, 10])
  const popular = options[2].line[0]
  const result = await analyzeSharpness(start, { ...settings, cacheKey: 'human-projection' }, {
    analyze: async (fen, _count, depth) => fen === start ? options : entries(fen, [20, 10, 0, -100], depth),
    explorer: async fen => fen === start ? { white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: options[0].line[0], san: 'first', white: 10, draws: 0, black: 0 }, { uci: popular, san: 'popular', white: 80, draws: 0, black: 0 }] } : { white: 0, draws: 0, black: 0, source: 'book', moves: [] },
  })
  const legal = new Chess(start).moves({ verbose: true })
  expect(result.continuations.map(item => item.san)).toContain(legal.find(move => move.from + move.to === popular)?.san)
  expect(result.continuations).toHaveLength(2)
})

it('can cancel a bounded sharpness analysis', async () => {
  const controller = new AbortController()
  await expect(analyzeSharpness(start, { ...settings, cacheKey: 'cancel' }, {
    analyze: async (_fen, _count, _depth, signal) => { controller.abort(); if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); return [] },
  }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it('reuses current Stockfish lines, projects one future decision, and caches the fast estimate', async () => {
  const game = new Chess(); game.move('e4'); game.move('c5'); const fen = game.fen()
  const first = entries(fen, [40, 20, 10, -170], 10)
  const after = new Chess(fen); after.move({ from: first[0].line[0].slice(0, 2), to: first[0].line[0].slice(2, 4) })
  const calls: string[] = [], updates: number[] = []
  const sources = {
    cached: (position: string) => position === fen ? first : undefined,
    analyze: async (position: string) => { calls.push(position); return entries(position, [30, 20, 0, -180], 8) },
  }
  const result = await analyzeFastSharpness(fen, sources, undefined, undefined, value => updates.push(Number(!!value.white) + Number(!!value.black)))
  expect(calls).toEqual([after.fen()])
  expect(updates).toEqual([1])
  expect(result).toMatchObject({ complete: true, blackProjected: true, whiteProjected: false })
  expect(result.black?.evaluated).toBe(4)
  expect(result.white?.evaluated).toBe(4)
  expect((await analyzeFastSharpness(fen, sources)).complete).toBe(true)
  expect(calls).toHaveLength(1)
  invalidateFastSharpness(fen)
  await analyzeFastSharpness(fen, sources)
  expect(calls).toHaveLength(2)
})

it('cancels an obsolete fast request before it can publish a stale score', async () => {
  const game = new Chess(); game.move('d4'); game.move('d5'); const fen = game.fen()
  const controller = new AbortController()
  const pending = analyzeFastSharpness(fen, { analyze: async (_position, _count, _depth, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
  }) }, controller.signal)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const next = new Chess(fen); next.move('c4')
  const fresh = await analyzeFastSharpness(next.fen(), { analyze: async (position) => entries(position, [40, 20, 10, -170], 8) })
  expect(fresh.fen).toBe(next.fen())
  expect(fresh.whiteProjected).toBe(true)
})

it('keeps deeper analysis configurable without changing its default search count', async () => {
  const game = new Chess(); game.move('Nf3'); game.move('Nf6'); const fen = game.fen()
  const calls: { count: number; position: string }[] = []
  const result = await analyzeSharpness(fen, { ...settings, candidates: 5, branches: 3, cacheKey: 'configurable-deep' }, {
    analyze: async (position, count, depth) => { calls.push({ position, count }); return entries(position, [40, 30, 20, 10, -150], depth) },
  })
  expect(calls).toHaveLength(4)
  expect(calls.every(call => call.count === 5)).toBe(true)
  expect(result.continuations).toHaveLength(3)
})
