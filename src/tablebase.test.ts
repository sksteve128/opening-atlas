import { Chess } from 'chess.js'
import { afterEach, expect, it, vi } from 'vitest'
import { lookupTablebase, tablebaseOutcome, tablebaseSupported } from './learning'
import { generateSimpleRepertoire } from './simpleGeneration'
import type { Generation, Sources } from './learning'

afterEach(() => vi.unstubAllGlobals())

it('classifies wins and losses from the side to move, and fifty-move exceptions as draws', () => {
  const white = '7k/5Q2/5K2/8/8/8/8/8 w - - 0 1'
  const black = '8/5Q2/5K2/8/8/8/8/7k b - - 0 1'
  expect(tablebaseOutcome(white, { category: 'win', moves: [] }, 'white')).toMatchObject({ label: 'Tablebase win', winner: 'white' })
  expect(tablebaseOutcome(white, { category: 'win', moves: [] }, 'black')).toMatchObject({ label: 'Tablebase loss', winner: 'white' })
  expect(tablebaseOutcome(black, { category: 'loss', moves: [] }, 'white')).toMatchObject({ label: 'Tablebase win', winner: 'white' })
  expect(tablebaseOutcome(black, { category: 'loss', moves: [] }, 'black')).toMatchObject({ label: 'Tablebase loss', winner: 'white' })
  for (const category of ['draw', 'cursed-win', 'blessed-loss']) expect(tablebaseOutcome(white, { category, moves: [] }, 'white')?.label).toBe('Tablebase draw')
  for (const category of ['unknown', 'maybe-win', 'syzygy-win']) expect(tablebaseOutcome(white, { category, moves: [] }, 'white')).toBeUndefined()
  expect(tablebaseSupported(new Chess().fen())).toBe(false)
  expect(tablebaseSupported('7k/5Q2/5K2/8/8/8/8/8 w K - 0 1')).toBe(false)
  expect(tablebaseSupported(white)).toBe(true)
})

it('uses the official endpoint, caches complete rule-relevant positions, and respects rate limits', async () => {
  const fen = '8/8/8/8/8/8/4K3/6kq w - - 17 1'
  const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ category: 'loss', moves: [] }), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  expect((await lookupTablebase(fen)).category).toBe('loss')
  expect((await lookupTablebase(fen.replace(/ 1$/, ' 2'))).category).toBe('loss')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toContain('https://tablebase.lichess.org/standard?fen=')
  const other = fen.replace(' 17 ', ' 18 ')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    fetcher.mockResolvedValueOnce(new Response('limited', { status: 429, headers: { 'Retry-After': '2' } }))
    await expect(lookupTablebase(other)).rejects.toThrow('429')
    await expect(lookupTablebase(other)).rejects.toThrow('rate limited')
    expect(fetcher).toHaveBeenCalledTimes(2)
    clock.mockReturnValue(3001)
    expect((await lookupTablebase(other)).category).toBe('loss')
    expect(fetcher).toHaveBeenCalledTimes(3)
  } finally { clock.mockRestore() }
})

it('stops a generated continuation at a known tablebase result and continues when the provider fails', async () => {
  const fen = '7k/5Q2/5K2/8/8/8/8/8 w - - 0 1'
  const options: Generation = { opening: 'Endgame', startFen: fen, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, maxPlies: 1, engineDepth: 16, tolerance: 35, mode: 'here' }
  const sources: Sources = { explorer: async () => ({ white: 0, draws: 0, black: 0, moves: [], source: 'book' }), analyze: vi.fn(async () => [{ cp: 900, depth: 16, line: ['f7g7'] }]), tablebase: async () => ({ category: 'win', moves: [] }) }
  const stopped = await generateSimpleRepertoire(options, [], sources)
  expect(stopped).toMatchObject({ status: 'instructional', termination: 'Tablebase win — White wins.', tablebase: { winner: 'white' } })
  expect(sources.analyze).not.toHaveBeenCalled()
  sources.tablebase = async () => { throw new Error('offline') }
  expect((await generateSimpleRepertoire(options, [], sources)).moves[0].uci).toBe('f7g7')
})
