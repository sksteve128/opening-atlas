import { Chess } from 'chess.js'
import { expect, it, vi } from 'vitest'
import { humanPopulation, supportedRatings } from './humanPopulation'
import { generateSimpleRepertoire } from './simpleGeneration'
import type { ExplorerData } from './core'
import type { Generation, Sources } from './learning'
const fen = new Chess().fen()
const options: Generation = { opening: 'Coverage', startFen: fen, prefix: [], side: 'black', database: 'lichess', filters: { ratings: [1600, 1800, 2000, 2200], speeds: ['blitz', 'rapid', 'classical'] }, maxPlies: 1, engineDepth: 16, tolerance: 35, mode: 'here', seed: 42 }
const data = (games: number, source: 'lichess' | 'masters' = 'lichess'): ExplorerData => ({ source, white: games, draws: 0, black: 0, moves: [{ uci: 'e2e4', san: 'e4', white: Math.ceil(games * .8), draws: 0, black: 0 }, { uci: 'd2d4', san: 'd4', white: Math.floor(games * .2), draws: 0, black: 0 }] })
function sources(counts: number[]): Sources {
  let calls = 0
  return { explorer: vi.fn(async (_fen, _filters, _signal, database) => data(counts[calls++] ?? 0, database)), analyze: vi.fn(async () => [{ cp: 0, depth: 16, line: ['e2e4'] }]) }
}
it.each([0, 1, 2, 3])('stops querying at the first sufficient population: tier %i', async index => {
  const counts = Array.from({ length: 4 }, (_, i) => i === index ? 100 : 9), src = sources(counts)
  const result = await humanPopulation(fen, options, src)
  expect(src.explorer).toHaveBeenCalledTimes(index + 1)
  expect(result.population?.tier).toBe(['selected', 'higher', 'all', 'masters'][index])
  expect(result.dist?.games).toBe(100)
  expect(result.dist?.moves.reduce((n, m) => n + m.probability, 0)).toBeCloseTo(1)
  if (index >= 1) expect(vi.mocked(src.explorer).mock.calls[1][1].ratings).toEqual([2200, 2500])
  if (index >= 2) expect(vi.mocked(src.explorer).mock.calls[2][1].ratings).toEqual(supportedRatings)
  if (index === 3) expect(vi.mocked(src.explorer).mock.calls[3].slice(1)).toEqual([{ ratings: [], speeds: [] }, undefined, 'masters'])
  expect(options.filters.ratings).toEqual([1600, 1800, 2000, 2200])
})
it('never adds overlapping Lichess or Masters populations together', async () => {
  const result = await humanPopulation(fen, options, sources([9, 8, 19, 15]))
  expect(result.dist).toBeUndefined()
  expect(result.attempts.map(a => a.games)).toEqual([9, 8, 19, 15])
})
it('uses one explicitly sparse population, including actual low-count moves', async () => {
  const src = sources([9, 8, 19, 15])
  const result = await humanPopulation(fen, { ...options, limitedHumanData: 'sparse' }, src)
  expect(result.population).toMatchObject({ tier: 'all', sparse: true, database: 'lichess' })
  expect(result.dist?.games).toBe(19)
  expect(result.dist?.moves.map(m => m.probability)).toEqual([16 / 19, 3 / 19])
})
it('records Masters as Masters and sampling remains reproducible after fallback', async () => {
  const a = await generateSimpleRepertoire(options, [], sources([9, 0, 19, 100]))
  const b = await generateSimpleRepertoire(options, [], sources([9, 0, 19, 100]))
  expect(a.moves).toEqual(b.moves)
  expect(a.moves[0]).toMatchObject({ source: 'masters', population: { tier: 'masters', ratings: [], speeds: [] }, sampling: { eligibleGames: 100 } })
  expect(JSON.parse(JSON.stringify(a)).moves[0].population).toEqual(a.moves[0].population)
})
it('uses only one single-PV search for explicitly enabled opponent engine fallback', async () => {
  const src = sources([0, 0, 0, 0])
  const line = await generateSimpleRepertoire({ ...options, limitedHumanData: 'engine' }, [], src)
  expect(src.analyze).toHaveBeenCalledTimes(1)
  expect(vi.mocked(src.analyze).mock.calls[0][1]).toBe(1)
  expect(line.moves[0]).toMatchObject({ source: 'engine', engineFallback: true })
  expect(line.moves[0].sampling).toBeUndefined()
  expect(line.fallback).toBe(true)
  const stopped = await generateSimpleRepertoire({ ...options, limitedHumanData: 'stop', engineFallback: true }, [], sources([0, 0, 0, 0]))
  expect(stopped.moves).toHaveLength(0); expect(stopped.termination).toContain('Unresolved'); expect(stopped.recommendation?.conversion?.detail).toContain('Limited human data')
})
it.each([['HTTP 401', 'authentication'], ['HTTP 403', 'authentication'], ['HTTP 429', 'rate-limit'], ['Network failed', 'network'], ['Explorer timed out', 'timeout'], ['Malformed Explorer response', 'malformed'], ['Unsupported query (400)', 'unsupported']])('stops expansion on %s instead of reporting insufficient games', async (message, issue) => {
  const src = sources([]); src.explorer = vi.fn<Sources['explorer']>(async () => ({ ...data(0), source: 'book', unavailableReason: message }))
  const result = await humanPopulation(fen, options, src)
  expect(src.explorer).toHaveBeenCalledTimes(1)
  expect(result.error).toBe(message)
  expect(result.attempts[0]).toMatchObject({ issue, error: message })
  expect(result.attempts[0].games).toBeUndefined()
})
it('distinguishes valid zero games from low coverage', async () => {
  const empty = await humanPopulation(fen, { ...options, mastersFallback: false }, sources([0, 0, 0]))
  expect(empty.attempts.every(attempt => attempt.issue === 'zero-games' && attempt.games === 0)).toBe(true)
  const thin = await humanPopulation(fen, { ...options, mastersFallback: false }, sources([9, 8, 7]))
  expect(thin.attempts.every(attempt => attempt.issue === 'insufficient')).toBe(true)
})
it('uses observed Sicilian frequencies before consulting Maia', async () => {
  const game = new Chess(); for (const san of ['e4', 'c5', 'Nf3']) game.move(san)
  const src = sources([])
  src.explorer = vi.fn(async () => ({ source: 'lichess' as const, white: 1000, draws: 100, black: 900, moves: [{ uci: 'd7d6', san: 'd6', white: 350, draws: 50, black: 300 }, { uci: 'b8c6', san: 'Nc6', white: 400, draws: 40, black: 410 }] }))
  src.humanModel = { id: 'test-maia', version: '1', minRating: 0, maxRating: 3000, predict: vi.fn(async () => { throw new Error('Maia must not run') }) }
  const line = await generateSimpleRepertoire({ ...options, startFen: game.fen(), rootFen: game.fen(), side: 'white', maxPlies: 1, playMode: 'mainline' }, [], src)
  expect(line.moves[0]).toMatchObject({ source: 'lichess', san: 'Nc6', games: 850 })
  expect(src.humanModel.predict).not.toHaveBeenCalled()
})
it('deduplicates transpositions and identical populations without changing selected filters', async () => {
  const src = sources([0, 100]), cache = new Map<string, Promise<ExplorerData>>()
  const all = { ...options, filters: { ...options.filters, ratings: [...supportedRatings].reverse() } }
  await humanPopulation(fen, all, src, undefined, cache)
  await humanPopulation(fen.replace('0 1', '4 3'), all, src, undefined, cache)
  expect(src.explorer).toHaveBeenCalledTimes(2)
  expect(vi.mocked(src.explorer).mock.calls[1][3]).toBe('masters')
  expect(all.filters.ratings).toEqual([...supportedRatings].reverse())
})
it('records no legal returned continuation independently of position count', async () => {
  const src = sources([]); src.explorer = async () => ({ ...data(100), moves: [{ uci: 'e7e5', san: 'e5', white: 100, draws: 0, black: 0 }] })
  const result = await humanPopulation(fen, options, src)
  expect(result.dist).toBeUndefined()
  expect(result.attempts.every(a => a.issue === 'no-legal-moves')).toBe(true)
})
it('retains fresh coverage diagnostics when no moves extend an existing line', async () => {
  const previous = await generateSimpleRepertoire(options, [], sources([0, 0, 0, 0]))
  const result = await generateSimpleRepertoire(options, [previous], sources([9, 0, 15, 0]))
  expect(result.recommendation?.populationAttempts?.map(a => a.games)).toEqual([9, 0, 15, 0])
  expect(previous.recommendation?.populationAttempts?.map(a => a.games)).toEqual([0, 0, 0, 0])
})
