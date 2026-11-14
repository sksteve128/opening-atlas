import { afterEach, expect, it, vi } from 'vitest'
import { Chess } from 'chess.js'
import { maia2 } from './maia2'
import { humanPrediction } from './humanModel'
import { generateSimpleRepertoire } from './simpleGeneration'

afterEach(() => vi.unstubAllGlobals())

it('passes FEN and selected rating to the local Maia provider', async () => {
  const fen = new Chess().fen()
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ model: 'maia2-rapid', version: '0.11.0', rating: 1900, calibrated: false, moves: [{ uci: 'e2e4', probability: 1 }] }), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  const result = await humanPrediction(maia2, fen, 1900, new AbortController().signal, 500, new Map())
  expect(fetcher).toHaveBeenCalledWith('/maia/predict', expect.objectContaining({ method: 'POST', body: JSON.stringify({ fen, rating: 1900 }) }))
  expect(result.moves).toEqual([{ uci: 'e2e4', probability: 1 }])
})

it('keeps the configured stop or explicit Stockfish fallback when Maia is unavailable', async () => {
  vi.stubGlobal('fetch', async () => new Response('Unavailable', { status: 503 }))
  const options = { opening: 'Empty Explorer', startFen: new Chess().fen(), prefix: [], side: 'black' as const, database: 'lichess' as const, filters: { ratings: [1800], speeds: ['rapid'] }, maxPlies: 1, engineDepth: 16, tolerance: 35, mode: 'here' as const, mastersFallback: false, targetRating: 1900 }
  const sources = { humanModel: maia2, explorer: async () => ({ source: 'lichess' as const, white: 0, draws: 0, black: 0, moves: [] }), analyze: vi.fn(async () => [{ cp: 0, depth: 16, line: ['e2e4'] }]) }
  const stopped = await generateSimpleRepertoire({ ...options, limitedHumanData: 'stop' }, [], sources)
  expect(stopped.moves).toHaveLength(0)
  expect(stopped.recommendation?.conversion?.modelStatus).toContain('unavailable')
  const fallback = await generateSimpleRepertoire({ ...options, limitedHumanData: 'engine' }, [], sources)
  expect(fallback.moves[0]).toMatchObject({ source: 'engine', engineFallback: true })
  expect(fallback.moves[0].prediction).toBeUndefined()
})

it.skipIf(process.env.MAIA_INTEGRATION !== '1')('uses real Maia when Lichess has no games', async () => {
  const remoteFetch = globalThis.fetch
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => remoteFetch('http://127.0.0.1:8765' + url.replace('/maia', ''), init))
  for (const moves of [[], ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3', 'c5'], ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3']]) {
    const board = new Chess(); moves.forEach(move => board.move(move))
    const line = await generateSimpleRepertoire({ opening: 'Empty Explorer', startFen: board.fen(), prefix: [], side: board.turn() === 'w' ? 'black' : 'white', database: 'lichess', filters: { ratings: [1800], speeds: ['rapid'] }, maxPlies: 1, engineDepth: 16, tolerance: 35, mode: 'here', mastersFallback: false, targetRating: 1900, limitedHumanData: 'stop', seed: 1 }, [], { humanModel: maia2, explorer: async () => ({ source: 'lichess', white: 0, draws: 0, black: 0, moves: [] }), analyze: async () => { throw new Error('Stockfish must not select this opponent move') } })
    expect(line.moves[0]).toMatchObject({ source: 'model', prediction: { model: 'maia2-rapid', version: '0.11.0', rating: 1900, calibrated: false } })
    expect(line.moves[0].games).toBeUndefined()
    expect(board.moves({ verbose: true }).some(move => move.from + move.to + (move.promotion || '') === line.moves[0].uci)).toBe(true)
  }
})
