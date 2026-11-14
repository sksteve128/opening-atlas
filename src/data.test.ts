import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { write } from './data'
import { identity } from './core'

afterEach(() => vi.unstubAllGlobals())

it('recovers immediately after sign-in and sends rating and speed filters with the user token', async () => {
  let token: string | null = null
  vi.stubGlobal('sessionStorage', { getItem: () => token })
  const requests: { url: URL; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/book.json') return new Response('{}')
    const url = new URL(String(input)); requests.push({ url, init })
    if (!token) return new Response('', { status: 401 })
    return new Response(JSON.stringify({ white: url.searchParams.get('speeds') === 'rapid' ? 80 : 20, draws: 10, black: 10, moves: [] }))
  }))
  vi.resetModules()
  const { explorer } = await import('./data')
  const game = new (await import('chess.js')).Chess(); game.move('d4')
  const fen = game.fen()
  expect((await explorer(fen, { ratings: [1800], speeds: ['rapid'] })).unavailableReason).toContain('401')
  token = 'test_user_token'
  expect((await explorer(fen, { ratings: [1800], speeds: ['rapid'] })).white).toBe(80)
  expect((await explorer(fen, { ratings: [2200], speeds: ['classical'] })).white).toBe(20)
  expect(requests[1].init?.headers).toEqual({ Authorization: 'Bearer test_user_token' })
  expect(requests[2].url.searchParams.get('ratings')).toBe('2200')
  expect(requests[2].url.searchParams.get('speeds')).toBe('classical')
  await explorer(fen, { ratings: [1800], speeds: ['rapid'] })
  expect(requests).toHaveLength(3)
})

it('persists saved lines without changing their storage key', async () => {
  const value = [{ id: 'line-1', name: 'Italian — 3...Nf6', moves: [{ uci: 'e2e4' }] }]
  const repertoire = { nodes: [{ id: 'old-node', fen: new (await import('chess.js')).Chess().fen() }] }
  await write('generated-lines-v1', value)
  await write('state', repertoire)
  vi.resetModules()
  const reopened = await import('./data')
  expect(await reopened.read('generated-lines-v1')).toEqual(value)
  expect(await reopened.read('state')).toEqual(repertoire)
})

it('requests the documented masters and Lichess endpoints without inventing credentials', async () => {
  const requests: { url: URL; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), init })
    return new Response(JSON.stringify({ white: 10, draws: 5, black: 5, moves: [{ uci: 'e2e4', san: 'e4', white: 8, draws: 2, black: 0 }] }))
  }))
  vi.resetModules()
  const { explorer } = await import('./data')
  const fen = new (await import('chess.js')).Chess().fen()
  const filters = { ratings: [1600, 1800], speeds: ['blitz', 'rapid'] }
  expect((await explorer(fen, filters, undefined, 'masters')).source).toBe('masters')
  expect((await explorer(fen, filters)).source).toBe('lichess')
  expect(requests.map(request => request.url.origin + request.url.pathname)).toEqual(['https://explorer.lichess.org/masters', 'https://explorer.lichess.org/lichess'])
  expect(requests[0].url.searchParams.get('fen')).toBe(fen)
  expect(requests[0].url.searchParams.has('ratings')).toBe(false)
  expect(requests[1].url.searchParams.get('ratings')).toBe('1600,1800')
  expect(requests[1].url.searchParams.get('speeds')).toBe('blitz,rapid')
  expect(requests.every(request => !request.init?.headers)).toBe(true)
  await explorer(fen, filters)
  expect(requests).toHaveLength(2)
})

it('keeps published opening lines when the public endpoint returns HTTP 401', async () => {
  const fen = new (await import('chess.js')).Chess().fen()
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    requests.push(String(input))
    if (String(input) === '/book.json') return new Response(JSON.stringify({ [identity(fen)]: { name: 'Starting position', moves: [{ uci: 'e2e4', san: 'e4' }] } }))
    return new Response('<h1>401 Authorization Required</h1>', { status: 401, headers: { 'content-type': 'text/html' } })
  }))
  vi.resetModules()
  const { explorer } = await import('./data')
  const result = await explorer(fen, { ratings: [2500], speeds: ['classical'] })
  expect(result.unavailableReason).toContain('HTTP 401')
  expect(result).toMatchObject({ source: 'book', opening: { name: 'Starting position' }, moves: [{ uci: 'e2e4', white: 0 }] })
  expect(requests[0]).toContain('https://explorer.lichess.org/lichess')
  expect(requests[1]).toBe('/book.json')
  expect((await explorer(fen, { ratings: [1000], speeds: ['bullet'] })).source).toBe('book')
  expect(requests.filter(url => url.startsWith('https://'))).toHaveLength(1)
})

it('bounds a network failure and reuses the published fallback', async () => {
  const game = new (await import('chess.js')).Chess(); game.move('e4'); const fen = game.fen()
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    requests.push(String(input))
    if (String(input) === '/book.json') return new Response(JSON.stringify({ [identity(fen)]: { moves: [{ uci: 'e7e5', san: 'e5' }] } }))
    throw new Error('Network unavailable')
  }))
  vi.resetModules()
  const { explorer } = await import('./data')
  expect((await explorer(fen, { ratings: [1400], speeds: ['rapid'] })).source).toBe('book')
  expect((await explorer(fen, { ratings: [1600], speeds: ['blitz'] })).source).toBe('book')
  expect(requests.filter(url => url.startsWith('https://'))).toHaveLength(1)
})

it('lets simple generation use the same authenticated Explorer cache and filters as the panel', async () => {
  vi.stubGlobal('sessionStorage', { getItem: () => 'test_shared_token' })
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ white: 100, draws: 0, black: 0, moves: [{ uci: 'd2d4', san: 'd4', white: 100, draws: 0, black: 0 }] })))
  vi.stubGlobal('fetch', fetcher); vi.resetModules()
  const { Chess } = await import('chess.js'), game = new Chess()
  for (const move of ['e4', 'e5', 'Nf3', 'Nc6']) game.move(move)
  const fen = game.fen(), filters = { ratings: [1400, 2500], speeds: ['rapid'] }
  const { explorer } = await import('./data')
  await explorer(fen, filters)
  const { generateSimpleRepertoire } = await import('./simpleGeneration')
  const analyze = vi.fn(async () => { throw new Error('Opponent selection must not use the engine') })
  const line = await generateSimpleRepertoire({ opening: 'Test', startFen: fen, rootFen: fen, prefix: [], side: 'black', database: 'lichess', filters, maxPlies: 1, engineDepth: 16, tolerance: 35, mode: 'here', seed: 1 }, [], { explorer, analyze })
  expect(line.moves[0]).toMatchObject({ uci: 'd2d4', source: 'lichess', games: 100, sampling: { probability: 1 } })
  expect(analyze).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer test_shared_token' })
  const url = new URL(String(fetcher.mock.calls[0][0]))
  expect(url.searchParams.get('fen')).toBe(fen)
  expect(url.searchParams.get('ratings')).toBe('1400,2500')
  expect(url.searchParams.get('speeds')).toBe('rapid')
})

it('migrates old Explorer entries, preserves retrieval time, and refreshes stale data in the background', async () => {
  const game = new (await import('chess.js')).Chess(); game.move('c4'); const fen = game.fen()
  const filters = { ratings: [1800, 1600], speeds: ['rapid', 'blitz'] }
  const at = Date.now() - 8 * 86400000
  await write(`explorer:lichess:${identity(fen)}:1600,1800:blitz,rapid`, { at, data: { source: 'lichess', white: 10, draws: 5, black: 5, moves: [] } })
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ white: 20, draws: 5, black: 5, moves: [] })))
  vi.stubGlobal('fetch', fetcher); vi.resetModules()
  const cache = await import('./data')
  expect(await cache.explorer(fen, filters)).toMatchObject({ white: 10, cache: { state: 'stale', retrievedAt: at } })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  await vi.waitFor(async () => expect((await cache.explorer(fen, filters)).white).toBe(20))
  expect((await cache.explorer(fen, filters)).cache?.state).toBe('refreshed')
  expect(await cache.read(`explorer:lichess:${identity(fen)}:1600,1800:blitz,rapid`)).toBeUndefined()
  expect((await cache.explorerCacheStats()).networkAvoided).toBeGreaterThan(0)
})

it('does not replace compatible cached games with HTTP 401 or corrupt stored values', async () => {
  const game = new (await import('chess.js')).Chess(); game.move('e4'); game.move('c5'); const fen = game.fen()
  const filters = { ratings: [2000], speeds: ['rapid'] }, at = Date.now() - 31 * 86400000
  await write(`explorer:lichess:${identity(fen)}:2000:rapid`, { at, data: { source: 'lichess', white: 7, draws: 2, black: 1, moves: [] } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/book.json' ? new Response('{}') : new Response('denied', { status: 401 })))
  vi.resetModules()
  const cache = await import('./data')
  expect((await cache.explorer(fen, filters)).white).toBe(7)
  await vi.waitFor(async () => expect((await cache.explorerCacheStats()).networkRequests).toBe(1))
  expect((await cache.explorer(fen, filters)).source).toBe('lichess')
  const second = new (await import('chess.js')).Chess(); second.move('d4'); second.move('Nf6')
  await cache.write(cache.explorerCacheKey(second.fen(), filters, 'lichess'), { at, data: { source: 'lichess', white: -1, draws: 0, black: 0, moves: [] } })
  expect((await cache.explorer(second.fen(), filters)).source).toBe('book')
})

it('keeps stale Lichess probabilities after a failed refresh or rate limit', async () => {
  const game = new (await import('chess.js')).Chess(); game.move('Nf3'); const fen = game.fen()
  const filters = { ratings: [1400], speeds: ['classical'] }, at = Date.now() - 31 * 86400000
  await write(`explorer:lichess:${identity(fen)}:1400:classical`, { at, data: { source: 'lichess', white: 12, draws: 3, black: 5, moves: [{ uci: 'd7d5', san: 'd5', white: 12, draws: 3, black: 5 }] } })
  const fetcher = vi.fn(async () => new Response('limited', { status: 429, headers: { 'Retry-After': '120' } }))
  vi.stubGlobal('fetch', fetcher); vi.resetModules()
  const cache = await import('./data')
  expect((await cache.explorer(fen, filters)).moves[0].white).toBe(12)
  await vi.waitFor(async () => expect((await cache.explorerCacheStats()).rateLimits).toBe(1))
  expect((await cache.explorer(fen, filters)).source).toBe('lichess')
  expect((await cache.explorer(fen, filters)).cache?.state).toBe('stale')
  expect((await cache.explorerCacheStats()).rateLimits).toBe(1)
})

it('separates rating, speed, and provider keys and protects library records while evicting cache', async () => {
  vi.resetModules()
  const cache = await import('./data')
  const fen = new (await import('chess.js')).Chess().fen()
  expect(cache.explorerCacheKey(fen, { ratings: [1800, 1600], speeds: ['rapid', 'blitz'] }, 'lichess')).toBe(cache.explorerCacheKey(fen, { ratings: [1600, 1800], speeds: ['blitz', 'rapid'] }, 'lichess'))
  expect(cache.explorerCacheKey(fen, { ratings: [1800], speeds: ['rapid'] }, 'lichess')).not.toBe(cache.explorerCacheKey(fen, { ratings: [1800], speeds: ['blitz'] }, 'lichess'))
  expect(cache.explorerCacheKey(fen, { ratings: [1800], speeds: ['rapid'] }, 'masters')).not.toBe(cache.explorerCacheKey(fen, { ratings: [1800], speeds: ['rapid'] }, 'lichess'))
  const library = [{ id: 'do-not-evict' }]
  await cache.write('generated-lines-v1', library)
  await cache.write('explorer:old', { at: 1, data: { source: 'lichess', white: 1, draws: 0, black: 0, moves: [] } })
  await cache.write('explorer:new', { at: 2, data: { source: 'lichess', white: 1, draws: 0, black: 0, moves: [] } })
  await cache.enforceExplorerCacheBudget(1)
  expect(await cache.read('generated-lines-v1')).toEqual(library)
  expect(await cache.read('explorer:old')).toBeUndefined()
  await cache.clearExplorerCache()
  expect(await cache.read('generated-lines-v1')).toEqual(library)
})

it('retries an Explorer write after storage quota is exceeded', async () => {
  const game = new (await import('chess.js')).Chess(); game.move('b3'); const fen = game.fen()
  const filters = { ratings: [2500], speeds: ['bullet'] }
  const original = IDBObjectStore.prototype.put
  let rejected = false
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (!rejected && String(key).startsWith('explorer:v2:')) { rejected = true; throw new DOMException('Storage full', 'QuotaExceededError') }
    return original.call(this, value, key)
  })
  try {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ white: 4, draws: 1, black: 1, moves: [] }))))
    vi.resetModules()
    const cache = await import('./data')
    expect((await cache.explorer(fen, filters)).white).toBe(4)
    await vi.waitFor(async () => expect((await cache.read(cache.explorerCacheKey(fen, filters, 'lichess')) as { data: { white: number } } | undefined)?.data.white).toBe(4))
    expect(rejected).toBe(true)
  } finally { spy.mockRestore() }
})

it('hands persisted Explorer positions to the shared generation cache before a batch', async () => {
  const game = new (await import('chess.js')).Chess(); game.move('g3'); const fen = game.fen()
  vi.resetModules()
  const cache = await import('./data')
  const filters = { ratings: [1600], speeds: ['rapid'] }, at = Date.now() - 1000
  await cache.write(cache.explorerCacheKey(fen, filters, 'lichess'), { version: 2, at, data: { source: 'lichess', white: 3, draws: 2, black: 1, moves: [] } })
  const receiver = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ accepted: 1 })))
  vi.stubGlobal('fetch', receiver)
  expect(await cache.syncExplorerCache()).toBeGreaterThan(0)
  const uploads = receiver.mock.calls.filter(call => String(call[0]) === '/api/generation/cache')
  expect(uploads.length).toBeGreaterThan(0)
  const items = uploads.flatMap(call => (JSON.parse((call[1] as RequestInit).body as string) as { entries: { url: string; at: number }[] }).entries)
  expect(items.some(item => item.at === at && item.url.startsWith('https://explorer.lichess.org/lichess'))).toBe(true)
})
