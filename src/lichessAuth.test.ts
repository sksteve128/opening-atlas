import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())
function environment(href = 'http://localhost:5173/?fen=position') {
  const values = new Map<string, string>(), persistent = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => persistent.get(key) ?? null, setItem: (key: string, value: string) => persistent.set(key, value), removeItem: (key: string) => persistent.delete(key) })
  const location = { ...Object.fromEntries(['origin', 'pathname', 'search'].map(key => [key, new URL(href)[key as 'origin' | 'pathname' | 'search']])), href, assign: vi.fn() }
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('location', location)
  vi.stubGlobal('history', { replaceState: vi.fn() })
  vi.resetModules()
  return { values, persistent, location }
}

it('uses PKCE without a client secret and preserves the board URL', async () => {
  const { values, location } = environment()
  const { connectLichess } = await import('./lichessAuth')
  await connectLichess()
  const pending = JSON.parse(values.get('opening-atlas-lichess-login')!)
  const url = new URL(location.assign.mock.calls[0][0])
  expect(url.origin + url.pathname).toBe('https://lichess.org/oauth')
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('state')).toBe(pending.state)
  expect(url.searchParams.get('redirect_uri')).toBe(location.href)
  expect(url.searchParams.has('code_verifier')).toBe(false)
  expect(url.searchParams.get('scope')).toBe('')
})

it('exchanges a matching callback once and persists the token while keeping PKCE state tab-local', async () => {
  const { values, persistent } = environment('http://localhost:5173/?code=single_use&state=matching')
  values.set('opening-atlas-lichess-login', JSON.stringify({ state: 'matching', verifier: 'private_verifier', at: Date.now(), redirect: 'http://localhost:5173/', returnUrl: 'http://localhost:5173/?fen=position' }))
  const request = vi.fn(async () => new Response(JSON.stringify({ access_token: 'test_token' })))
  vi.stubGlobal('fetch', request)
  const { finishLichessLogin, lichessToken, disconnectLichess } = await import('./lichessAuth')
  expect(await finishLichessLogin()).toBe(true)
  expect(await finishLichessLogin()).toBe(true)
  expect(request).toHaveBeenCalledTimes(1)
  expect(lichessToken()).toBe('test_token')
  expect(persistent.get('opening-atlas-lichess-token')).toBe('test_token')
  expect(values.has('opening-atlas-lichess-token')).toBe(false)
  expect(values.has('opening-atlas-lichess-login')).toBe(false)
  expect(history.replaceState).toHaveBeenCalledWith(null, '', 'http://localhost:5173/?fen=position')
  disconnectLichess()
  expect(lichessToken()).toBeUndefined()
})

it('rejects a mismatched callback without exchanging a code', async () => {
  const { values } = environment('http://localhost:5173/?code=single_use&state=wrong')
  values.set('opening-atlas-lichess-login', JSON.stringify({ state: 'matching', verifier: 'private', at: Date.now(), redirect: 'http://localhost:5173/' }))
  const request = vi.fn(); vi.stubGlobal('fetch', request)
  const { finishLichessLogin } = await import('./lichessAuth')
  await expect(finishLichessLogin()).rejects.toThrow('could not be validated')
  expect(request).not.toHaveBeenCalled()
})


it('migrates a connected tab and survives a new session', async () => {
  const { values, persistent } = environment()
  values.set('opening-atlas-lichess-token', 'legacy_token')
  const { lichessToken } = await import('./lichessAuth')
  expect(lichessToken()).toBe('legacy_token')
  expect(persistent.get('opening-atlas-lichess-token')).toBe('legacy_token')
  values.clear(); vi.resetModules()
  expect((await import('./lichessAuth')).lichessToken()).toBe('legacy_token')
})

it('does not resurrect a disconnected connection from another tab', async () => {
  const { values, persistent } = environment()
  persistent.set('opening-atlas-lichess-token', 'saved_token')
  const { disconnectLichess, lichessToken } = await import('./lichessAuth')
  disconnectLichess()
  values.set('opening-atlas-lichess-token', 'old_tab_token')
  expect(lichessToken()).toBeUndefined()
})

it('keeps a working session when persistent storage is blocked', async () => {
  const { values } = environment()
  values.set('opening-atlas-lichess-token', 'session_token')
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
  expect((await import('./lichessAuth')).lichessToken()).toBe('session_token')
})
