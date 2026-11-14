import { afterAll, expect, test, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Chess } from 'chess.js'
import { generationServer } from './generation'
const jobs = generationServer()
const server = createServer((req, res) => { void jobs.middleware(req, res, () => { res.writeHead(404); res.end() }) })
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/generation/`
afterAll(() => { jobs.close(); server.close() })
const options = { opening: 'Background test', side: 'white', startFen: '7k/ppp5/5KQ1/8/8/8/PPP5/8 w - - 0 1', rootFen: '7k/ppp5/5KQ1/8/8/8/PPP5/8 w - - 0 1', prefix: [], database: 'lichess', filters: { ratings: [1800], speeds: ['rapid'] }, maxPlies: 2, maxMs: 10000, engineDepth: 4, verificationDepth: 5, engineTimeoutMs: 3000, tolerance: 35, mode: 'main', playMode: 'complete', engineFallback: true }
const start = (id: string, input = options) => fetch(base + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options: input, lines: [] }) })
test('server job survives disconnected client, uses real Stockfish, and returns the same result on reconnect', async () => {
  const id = crypto.randomUUID()
  expect((await start(id)).status).toBe(202)
  // No open connection owns the job. Reconnecting never launches another search.
  expect((await start(id)).status).toBe(200)
  let state
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(base + id)).json()
    if (state.status !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  expect(state.error).toBeUndefined()
  expect(state.status).toBe('complete')
  expect(state.line.moves.length).toBeGreaterThan(0)
  expect(Object.values(state.analyses).some((entries: any) => entries[0]?.depth > 0 && entries[0]?.line.length > 0)).toBe(true)
  const game = new Chess(options.startFen)
  for (const move of state.line.moves) game.move(move.san)
  expect(game.isCheckmate()).toBe(true)
  expect(await (await fetch(base + id)).json()).toEqual(state)
  expect(JSON.stringify(state)).not.toContain('token')
}, 30000)
test('explicit cancellation and invalid/cross-origin requests', async () => {
  const id = crypto.randomUUID()
  expect((await start(id)).status).toBe(202)
  expect((await (await fetch(base + id, { method: 'DELETE' })).json()).status).toBe('cancelled')
  expect((await (await fetch(base + id)).json()).status).toBe('cancelled')
  expect((await fetch(base + id, { headers: { Origin: 'https://other.example' } })).status).toBe(403)
  expect((await start(crypto.randomUUID(), { ...options, engineDepth: 999 })).status).toBe(400)
  expect((await fetch(base + crypto.randomUUID())).status).toBe(404)
})

test('personal game proxy restricts upstream and bounds completed-game export',async()=>{
 const nativeFetch=globalThis.fetch
 const upstream=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  if(String(input).startsWith('https://lichess.org'))return new Response('1. e4 e5 1-0')
  return nativeFetch(input,init)
 })
 try {
  const url=base+'personal-games?path='+encodeURIComponent('/api/games/user/Alice?max=999&ongoing=true&unknown=x')
  expect(await (await nativeFetch(url)).text()).toBe('1. e4 e5 1-0')
  const target=new URL(String(upstream.mock.calls[0][0]))
  expect(target.origin).toBe('https://lichess.org');expect(target.searchParams.get('max')).toBe('100')
  expect(target.searchParams.get('ongoing')).toBe('false');expect(target.searchParams.has('unknown')).toBe(false)
  expect((await nativeFetch(base+'personal-games?path='+encodeURIComponent('https://other.example/'))).status).toBe(400)
  expect((await nativeFetch(url,{headers:{Origin:'https://other.example'}})).status).toBe(403)
  expect((await nativeFetch(url,{method:'POST'})).status).toBe(405)
 } finally {upstream.mockRestore()}
})
