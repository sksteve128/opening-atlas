import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { batchManager } from '../server/batch.mjs'
import { sharedGenerationFetch } from '../server/shared-fetch.mjs'
import { autoWorkers, backgroundBatch, newerBatch, pendingBatch, recentBatches, rememberBatch, spectatorPly } from './backgroundBatch'
import { committedEvents, type CommittedEvent } from '../server/generation-events.mjs'
import { batchOpponentChoice } from './humanGeneration'
import type { Generation, Variation } from './learning'
import { Chess } from 'chess.js'

const root = new Chess().fen()
const options = { seed: 7, prefix: [], startFen: root } as unknown as Generation
const choices: Record<string, string> = { m0: 'a2a3', m1: 'b2b3', m2: 'c2c3', partial: 'd2d3' }
const line = (move: string) => ({ id: move, side: 'white', startFen: root, moves: [{ uci: choices[move] || 'e2e4' }] }) as unknown as Variation
class FakeChild extends EventEmitter {
  connected = true
  current?: number
  attempts = 0
  response: (index: number, attempt: number) => string
  constructor(response: (index: number, attempt: number) => string) { super(); this.response = response }
  send(message: { options?: Generation; cancel?: boolean }) {
    if (message.cancel) { queueMicrotask(() => { this.emit('message', { status: 'cancelled', line: line('partial') }); this.emit('message', { ready: true }) }); return }
    if (!message.options) return
    const index = this.current!, attempt = ++this.attempts
    setTimeout(() => { this.emit('message', { phase: 'Working', line: line('partial') }); this.emit('message', { status: 'complete', line: line(this.response(index, attempt)) }); this.emit('message', { ready: true }) }, 0)
  }
  kill() { this.connected = false; this.emit('close', 0, null) }
}
const input = (count: 3 | 5 | 10, workers: 1 | 2 | 4 | 6) => ({ count, workers, options, lines: [], seed: 7 })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

test('bounded pool reuses workers, retries duplicates, and preserves distinct lines', async () => {
  let created = 0
  const manager = batchManager({ spawn: () => { created++; return new FakeChild((index, attempt) => index === 1 && attempt === 1 ? 'm0' : `m${index}`) as never } })
  const batch = manager.start(crypto.randomUUID(), input(3, 2))
  await vi.waitFor(() => expect(batch.status).toBe('complete'))
  expect(created).toBe(2)
  expect(batch.completed).toBe(3)
  expect((batch.jobs as { line: Variation; attempts: number }[]).map(job => job.line.moves[0].uci)).toEqual(['a2a3', 'b2b3', 'c2c3'])
  expect((batch.jobs as { attempts: number }[])[1].attempts).toBe(2)
})

test('ten jobs stay within worker limit and cancel without losing partials', async () => {
  const children: FakeChild[] = []
  const manager = batchManager({ spawn: () => { const child = new FakeChild(index => `m${index}`); children.push(child); return child as never } })
  const batch = manager.start(crypto.randomUUID(), input(10, 4))
  expect(children).toHaveLength(4)
  batch.stop()
  await vi.waitFor(() => expect(batch.status).toBe('cancelled'))
  expect(batch.cancelled).toBe(10)
  expect((batch.jobs as { line?: Variation }[]).some(job => job.line?.moves[0].uci === 'd2d3')).toBe(true)
})

test('batch human choices favor common distinct replies while auto stays conservative', () => {
  const moves = [{ uci: 'a', probability: .7 }, { uci: 'b', probability: .2 }, { uci: 'c', probability: .1 }]
  expect(batchOpponentChoice(moves, { ...options, batchIndex: 1 }, 1)?.uci).toBe('b')
  expect(batchOpponentChoice(moves, { ...options, batchIndex: 3 }, 3)?.uci).toBe('b')
  expect(autoWorkers(10)).toBe(4)
  expect(autoWorkers(4)).toBe(2)
})

test('reload polls existing batch and completed jobs are reported independently', async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  const handle = { id: crypto.randomUUID(), options, count: 3 as const, workers: 2 as const, seed: 7 }
  const state = { status: 'complete', revision: 1, total: 3, completed: 1, running: 0, failed: 2, cancelled: 0, workers: 2, jobs: [] }
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(state)))
  vi.stubGlobal('fetch', fetcher)
  const progress = vi.fn()
  expect(await backgroundBatch(handle, [], new AbortController().signal, progress, true)).toEqual(state)
  expect(fetcher.mock.calls[0][0]).toBe(`/api/generation/batch/${handle.id}`)
  expect(pendingBatch()).toBeUndefined()
})

test('crashed worker fails its job and a replacement completes pending jobs', async () => {
  let created = 0
  const manager = batchManager({ spawn: () => {
    const child = new FakeChild(index => `m${index}`)
    if (++created === 1) queueMicrotask(() => child.kill())
    return child as never
  } })
  const batch = manager.start(crypto.randomUUID(), input(3, 1))
  await vi.waitFor(() => expect(batch.status).toBe('failed'))
  expect(batch.failed).toBe(1)
  expect(batch.completed).toBe(2)
  expect(created).toBe(2)
})

test('batch workers forward generation policy without changing depth or preferences', async () => {
  const dispatched: Generation[] = []
  const settings = { ...options, side: 'black', engineDepth: 18, verificationDepth: 24, style: 'aggressive', castlingPreference: 'kingside', exclusions: { test: ['e2e4'] }, targetRating: 1500 } as Generation
  const manager = batchManager({ spawn: () => {
    const child = new FakeChild(index => `m${index}`)
    const send = child.send.bind(child)
    child.send = message => { if (message.options) dispatched.push(message.options); send(message) }
    return child as never
  } })
  const batch = manager.start(crypto.randomUUID(), { ...input(3, 2), options: settings })
  await vi.waitFor(() => expect(batch.status).toBe('complete'))
  expect(dispatched).toHaveLength(3)
  for (const value of dispatched) expect(value).toMatchObject({ side: 'black', engineDepth: 18, verificationDepth: 24, style: 'aggressive', castlingPreference: 'kingside', exclusions: { test: ['e2e4'] }, targetRating: 1500 })
})

test('shared remote scheduler deduplicates requests and holds Explorer during rate limit cooldown', async () => {
  const fetcher = vi.fn(async () => new Response('limited', { status: 429 }))
  const remote = sharedGenerationFetch(fetcher)
  const request = { id: 1, url: 'https://explorer.lichess.org/lichess?fen=test' }
  const [first, same] = await Promise.all([remote(request), remote(request)])
  expect(first.status).toBe(429)
  expect(same.status).toBe(429)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect((await remote({ id: 2, url: request.url + '2' })).status).toBe(429)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

test('ten batch workers share one request for a position and serialize distinct Explorer positions', async () => {
  let active = 0, peak = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => 100000 + ++tick * 1200)
  let tick = 0
  try {
    const fetcher = vi.fn(async () => { peak = Math.max(peak, ++active); await Promise.resolve(); active--; return new Response('{"white":1}', { status: 200 }) })
    const remote = sharedGenerationFetch(fetcher)
    const same = await Promise.all(Array.from({ length: 10 }, (_, id) => remote({ id, url: 'https://explorer.lichess.org/lichess?fen=same' })))
    expect(fetcher).toHaveBeenCalledTimes(1); expect(same.every(result => result.status === 200)).toBe(true)
    await Promise.all(Array.from({ length: 10 }, (_, id) => remote({ id, url: `https://explorer.lichess.org/lichess?fen=${id}` })))
    expect(fetcher).toHaveBeenCalledTimes(11); expect(peak).toBe(1)
  } finally { clock.mockRestore() }
})

test('Explorer cooldown honors a longer Retry-After without sending more requests', async () => {
  let now = 100000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const fetcher = vi.fn(async () => new Response('limited', { status: 429, headers: { 'Retry-After': '120' } }))
    const remote = sharedGenerationFetch(fetcher)
    expect((await remote({ id: 1, url: 'https://explorer.lichess.org/lichess?fen=a' })).status).toBe(429)
    now += 61000
    expect((await remote({ id: 2, url: 'https://explorer.lichess.org/lichess?fen=b' })).status).toBe(429)
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { clock.mockRestore() }
})

test('ten parallel consumers reuse one persisted Explorer position without a network request', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
  try {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ white: 8, draws: 1, black: 1, moves: [] })))
    const remote = sharedGenerationFetch(fetcher)
    const url = new URL('https://explorer.lichess.org/lichess')
    url.searchParams.set('fen', root); url.searchParams.set('ratings', '1800,1600'); url.searchParams.set('speeds', 'rapid,blitz')
    expect(remote.seed({ url: url.toString() }, { status: 200, body: JSON.stringify({ white: 9, draws: 1, black: 0, moves: [] }) }, 90000)).toBe(true)
    const equivalent = new URL(url); equivalent.searchParams.set('ratings', '1600,1800'); equivalent.searchParams.set('speeds', 'blitz,rapid')
    const results = await Promise.all(Array.from({ length: 10 }, (_, id) => remote({ id, url: equivalent.toString() })))
    expect(results.every(result => result.cache?.state === 'cached')).toBe(true)
    expect(remote.metrics()).toMatchObject({ hits: 10, networkRequests: 0, entries: 1 })
    expect(fetcher).not.toHaveBeenCalled()
  } finally { clock.mockRestore() }
})

test('clearing the shared Explorer cache removes seeded positions', async () => {
  const remote = sharedGenerationFetch(vi.fn(async () => new Response(JSON.stringify({ white: 1, draws: 0, black: 0, moves: [] }))))
  const url = new URL('https://explorer.lichess.org/lichess'); url.searchParams.set('fen', root)
  expect(remote.seed({ url: url.toString() }, { status: 200, body: JSON.stringify({ white: 1, draws: 0, black: 0, moves: [] }) }, Date.now())).toBe(true)
  expect(remote.metrics().entries).toBe(1)
  remote.clear()
  expect(remote.metrics()).toMatchObject({ entries: 0, bytes: 0 })
})

test('shared Explorer request keeps an active consumer when another cancels', async () => {
  let cancelled = false
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ white: 1, draws: 0, black: 0, moves: [] })))
  const remote = sharedGenerationFetch(fetcher)
  const url = new URL('https://explorer.lichess.org/lichess'); url.searchParams.set('fen', root)
  const first = remote({ id: 1, url: url.toString() }, () => !cancelled)
  const second = remote({ id: 2, url: url.toString() })
  cancelled = true
  expect((await first).status).toBe(499)
  expect((await second).status).toBe(200)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

test.each([
  ['castling', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1'],
  ['en passant', '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6'],
  ['promotion', '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8q'],
])('committed %s event contains the actual legal FEN', (_name, fen, uci) => {
  const game = new Chess(fen), played = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  const job = { id: 'job', status: 'running', sequence: 0, events: [] as CommittedEvent[], ply: 0 }
  const draft = { startFen: fen, moves: [{ uci, san: played.san, source: 'engine' }] }
  const events = committedEvents(job, 'batch', draft, 'Generating')
  expect(events).toMatchObject([{ type: 'move_committed', batchId: 'batch', jobId: 'job', sequence: 1, ply: 1, fen: game.fen(), move: { uci } }])
  expect(committedEvents(job, 'batch', draft, 'Generating')).toHaveLength(0)
})

test('event history is bounded and stale queue snapshots cannot replace newer state', () => {
  const job = { id: 'job', status: 'running', sequence: 128, events: Array.from({ length: 128 }, (_, index) => ({ sequence: index + 1 }) as CommittedEvent), ply: 0 }
  committedEvents(job, 'batch', { startFen: root, moves: [{ uci: 'e2e4', san: 'e4', source: 'engine' }] }, 'Generating')
  expect(job.events).toHaveLength(128)
  expect(job.events[0].sequence).toBe(2)
  expect(spectatorPly(12, 18, false)).toBe(12)
  expect(spectatorPly(12, 18, true)).toBe(13)
  expect(newerBatch({ id: 'batch', revision: 5 } as never, { id: 'batch', revision: 4 } as never).revision).toBe(5)
})

test('recent results keep twenty summaries without copying full variations', () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  for (let i = 0; i < 21; i++) rememberBatch({ id: String(i), opening: 'French Exchange', side: 'black', startedAt: i, status: 'complete', total: 3, completed: 1, failed: 1, cancelled: 1, jobs: [{ id: String(i), status: 'complete', line: line('m0') }] } as never)
  expect(recentBatches()).toHaveLength(20)
  expect(recentBatches()[0].jobs[0].lineId).toBe('m0')
  expect(JSON.stringify(recentBatches())).not.toContain('startFen')
})

test('exploration jobs share a reproducible assignment seed and preserve distinct slots',async()=>{
 const dispatched: Generation[]=[]
 const manager=batchManager({spawn:()=>{const child=new FakeChild(i=>`m${i}`),send=child.send.bind(child);child.send=message=>{if(message.options)dispatched.push(message.options);send(message)};return child as never}})
 const batch=manager.start(crypto.randomUUID(),{...input(3,2),options:{...options,exploration:{mode:'explore',lossCp:30,candidates:4,temperature:'auto',novelty:true,noveltyWeight:1}}})
 await vi.waitFor(()=>expect(batch.status).toBe('complete'))
 expect(dispatched.map(o=>o.batchIndex)).toEqual([0,1,2]);expect(dispatched.every(o=>o.explorationBatchSeed===7)).toBe(true)
})

test('completed Stockfish analyses are shared across exploration jobs, incomplete results are not',async()=>{
 const received: {sharedAnalyses?: unknown[];sharedEngineAnalysis?: unknown}[]=[]
 const manager=batchManager({spawn:()=>{const child=new FakeChild(i=>`m${i}`),send=child.send.bind(child);child.send=message=>{
  received.push(message as never);if(message.options)queueMicrotask(()=>{child.emit('message',{engineCache:{key:`${root}|1|18|`,entries:[{cp:12,depth:18,line:['e2e4']}]}});child.emit('message',{engineCache:{key:'incomplete',entries:[{cp:12,depth:18,line:['e2e4'],search:{stoppedByBudget:true}}]}})})
  send(message)
 };return child as never}})
 const batch=manager.start(crypto.randomUUID(),{...input(3,2),options:{...options,exploration:{mode:'explore'}}})
 await vi.waitFor(()=>expect(batch.status).toBe('complete'))
 expect(received.some(m=>m.sharedEngineAnalysis)).toBe(true)
 expect(received.some(m=>m.sharedAnalyses?.length)).toBe(true)
 expect(JSON.stringify(received)).not.toContain('incomplete')
})
