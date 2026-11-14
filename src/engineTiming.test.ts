import { Chess } from 'chess.js'
import { afterEach, expect, it, vi } from 'vitest'

const fen = new Chess().fen()
class WorkerStub {
  static instances: WorkerStub[] = []
  commands: string[] = []
  listener?: (event: MessageEvent<string>) => void
  onerror?: (() => void) | null
  killed = false
  onCommand?: (command: string) => void
  constructor() { WorkerStub.instances.push(this) }
  addEventListener(_: string, listener: (event: MessageEvent<string>) => void) { this.listener = listener }
  removeEventListener() { this.listener = undefined }
  postMessage(command: string) { this.commands.push(command); this.onCommand?.(command) }
  terminate() { this.killed = true }
  emit(data: string) { this.listener?.({ data } as MessageEvent<string>) }
  iteration(depth: number) {
    this.emit(`info depth ${depth} multipv 1 score cp 30 pv e2e4`)
    this.emit(`info depth ${depth} multipv 2 score cp 20 pv d2d4`)
  }
}
async function setup() {
  vi.useFakeTimers(); vi.resetModules(); WorkerStub.instances = []; vi.stubGlobal('Worker', WorkerStub)
  return import('./engine')
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('retains coherent completed iterations on graceful budget stop and caches only achieved depth', async () => {
  const { analyze, cachedAnalysis, engineMetrics } = await setup()
  const pending = analyze(fen, 2, 18, undefined, 100)
  await Promise.resolve()
  const engine = WorkerStub.instances[0]
  engine.iteration(12)
  engine.emit('info depth 13 multipv 1 score cp 40 pv g1f3')
  engine.onCommand = command => { if (command === 'stop') engine.emit('bestmove g1f3') }
  await vi.advanceTimersByTimeAsync(101)
  const result = await pending
  expect(result.map(e => [e.depth, e.line[0]])).toEqual([[12, 'e2e4'], [12, 'd2d4']])
  expect(result[0].search).toMatchObject({ requestedDepth: 18, achievedDepth: 12, multiPVComplete: true, stoppedByBudget: true, endedNaturally: false })
  expect(engine.commands).toContain('stop'); expect(engine.killed).toBe(false)
  expect(cachedAnalysis(fen, 2, 18)).toBeUndefined()
  expect(await analyze(fen, 2, 12)).toEqual(result)
  expect(engineMetrics()).toMatchObject({ searches: 1, gracefullyStopped: 1, discarded: 0, cacheHits: 1 })
})
it('returns natural depth completion without stopping or replacing the worker', async () => {
  const { analyze } = await setup()
  const pending = analyze(fen, 2, 16)
  await Promise.resolve()
  const engine = WorkerStub.instances[0]; engine.iteration(16); engine.emit('bestmove e2e4')
  expect((await pending)[0].search).toMatchObject({ achievedDepth: 16, endedNaturally: true, stoppedByBudget: false })
  expect(engine.commands).not.toContain('stop')
  expect(engine.killed).toBe(false)
})
it('rejects incomplete, duplicate, or mixed-depth MultiPV output', async () => {
  const { analyze } = await setup()
  for (const second of ['', 'info depth 16 multipv 2 score cp 10 pv e2e4', 'info depth 15 multipv 2 score cp 10 pv d2d4']) {
    const pending = analyze(fen, 2, 16, undefined, 100, true)
    const rejected = expect(pending).rejects.toThrow('Invalid engine output')
    await Promise.resolve(); await Promise.resolve()
    const engine = WorkerStub.instances[0]
    engine.emit('info depth 16 multipv 1 score cp 30 pv e2e4')
    if (second) engine.emit(second)
    engine.emit('bestmove e2e4'); await rejected
    expect(engine.killed).toBe(false)
  }
})
it('waits for bestmove after cancellation before starting the next queued request', async () => {
  const { analyze } = await setup(), control = new AbortController()
  const pending = analyze(fen, 2, 16, control.signal, 1000)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await Promise.resolve()
  const engine = WorkerStub.instances[0]; engine.iteration(12)
  control.abort(); await rejected
  const next = analyze(fen, 2, 16, undefined, 1000)
  await Promise.resolve()
  expect(engine.commands.filter(c => c.startsWith('go '))).toHaveLength(1)
  engine.emit('bestmove e2e4')
  await vi.advanceTimersByTimeAsync(1)
  expect(engine.commands.filter(c => c.startsWith('go '))).toHaveLength(2)
  engine.iteration(16); engine.emit('bestmove e2e4'); await next
  expect(WorkerStub.instances).toHaveLength(1); expect(engine.killed).toBe(false)
})
it('kills an unresponsive worker only after the stop grace period', async () => {
  const { analyze, engineMetrics } = await setup()
  const pending = analyze(fen, 2, 16, undefined, 100)
  const rejected = expect(pending).rejects.toThrow('no bestmove')
  await vi.advanceTimersByTimeAsync(100)
  const engine = WorkerStub.instances[0]
  expect(engine.commands).toContain('stop'); expect(engine.killed).toBe(false)
  await vi.advanceTimersByTimeAsync(500); await rejected
  expect(engine.killed).toBe(true); expect(engineMetrics().discarded).toBe(1)
})
it('reports a crash separately and replaces the worker for the next request', async () => {
  const { analyze, engineMetrics } = await setup()
  const pending = analyze(fen, 2, 16)
  const rejected = expect(pending).rejects.toThrow('Engine crash')
  await Promise.resolve(); WorkerStub.instances[0].onerror?.(); await rejected
  const next = analyze(fen, 2, 16)
  await vi.advanceTimersByTimeAsync(1)
  const engine = WorkerStub.instances[1]; engine.iteration(16); engine.emit('bestmove e2e4'); await next
  expect(engineMetrics().crashes).toBe(1)
})

it('distinguishes external budget expiration from user cancellation and preserves completed analysis', async () => {
  const { analyze } = await setup(), control = new AbortController()
  const pending = analyze(fen, 2, 18, control.signal, 1000)
  await Promise.resolve()
  const engine = WorkerStub.instances[0]; engine.iteration(12)
  engine.onCommand = command => { if (command === 'stop') engine.emit('bestmove e2e4') }
  control.abort(new DOMException('Budget expired', 'TimeoutError'))
  expect((await pending)[0].search).toMatchObject({ achievedDepth: 12, stoppedByBudget: true })
  expect(engine.killed).toBe(false)
})

it('uses the reported single-PV bestmove with its completed evaluation when the final choice changes', async () => {
  const { analyze } = await setup()
  const pending = analyze(fen, 1, 18)
  await Promise.resolve()
  const engine = WorkerStub.instances[0]
  engine.emit('info depth 12 multipv 1 score cp 30 pv e2e4')
  engine.emit('info depth 13 multipv 1 score cp 20 pv d2d4')
  engine.emit('bestmove e2e4')
  const result = await pending
  expect(result[0]).toMatchObject({ depth: 12, cp: 30, line: ['e2e4'], search: { bestMove: 'e2e4', achievedDepth: 12 } })
})

it('publishes only coherent progressive depths before bestmove and never after cancellation', async () => {
  const { analyze } = await setup(), updates = vi.fn(), control = new AbortController()
  const pending = analyze(fen, 2, 24, control.signal, 30000, false, undefined, { onDepth: updates })
  const rejected = expect(pending).rejects.toMatchObject({name:'AbortError'})
  await Promise.resolve()
  const engine=WorkerStub.instances[0]
  engine.iteration(12)
  expect(updates.mock.calls[0][0]).toHaveLength(2)
  expect(updates.mock.calls[0][0][0].search).toMatchObject({requestedDepth:24,achievedDepth:12,endedNaturally:false})
  engine.emit('info depth 13 multipv 1 score cp 35 pv e2e4')
  expect(updates).toHaveBeenCalledTimes(1)
  control.abort();engine.iteration(14);engine.emit('bestmove e2e4')
  await rejected
  expect(updates).toHaveBeenCalledTimes(1)
})

it('prioritizes visible requests over queued background work and initializes one reused worker', async () => {
  const {analyze}=await setup()
  const first=analyze(fen,2,12,undefined,30000,true)
  await Promise.resolve()
  const engine=WorkerStub.instances[0]
  const background=analyze(fen,2,14,undefined,30000,true,undefined,{priority:'background'})
  const visible=analyze(fen,2,16,undefined,30000,true,undefined,{priority:'visible'})
  engine.iteration(12);engine.emit('bestmove e2e4');await first
  await vi.advanceTimersByTimeAsync(0)
  expect(engine.commands.filter(c=>c.startsWith('go '))).toEqual(['go depth 12','go depth 16'])
  engine.iteration(16);engine.emit('bestmove e2e4');await visible
  await vi.advanceTimersByTimeAsync(0)
  engine.iteration(14);engine.emit('bestmove e2e4');await background
  expect(engine.commands.filter(c=>c==='uci')).toHaveLength(1)
  expect(WorkerStub.instances).toHaveLength(1)
})
it('gracefully yields an active background search to visible analysis without restarting', async () => {
  const {analyze}=await setup()
  const background=analyze(fen,2,18,undefined,30000,true,undefined,{priority:'background'})
  await Promise.resolve();const engine=WorkerStub.instances[0];engine.iteration(12)
  engine.onCommand=c=>{if(c==='stop')engine.emit('bestmove e2e4')}
  const visible=analyze(fen,2,16,undefined,30000,true,undefined,{priority:'visible'})
  expect((await background)[0].search).toMatchObject({achievedDepth:12,endedNaturally:false,stoppedByBudget:true})
  await vi.advanceTimersByTimeAsync(0)
  engine.iteration(16);engine.emit('bestmove e2e4');await visible
  expect(engine.killed).toBe(false)
})
it('retains completed work on cancellation but still rejects the cancelled request',async()=>{
  const {analyze,cachedAnalysis}=await setup(),control=new AbortController()
  const pending=analyze(fen,2,24,control.signal),rejected=expect(pending).rejects.toMatchObject({name:'AbortError'})
  await Promise.resolve();const engine=WorkerStub.instances[0];engine.iteration(18);control.abort();engine.emit('bestmove e2e4');await rejected
  expect(cachedAnalysis(fen,2,18)?.[0].search).toMatchObject({achievedDepth:18,cancelled:true,endedNaturally:false})
  expect(cachedAnalysis(fen,2,24)).toBeUndefined()
})

it('returns no candidates for checkmate or stalemate without starting Stockfish', async () => {
  const { analyze, engineMetrics } = await setup()
  const mate = new Chess(); for (const move of ['f3', 'e5', 'g4', 'Qh4#']) mate.move(move)
  const stalemate = new Chess('7k/5K2/6Q1/8/8/8/8/8 b - - 0 1')
  expect(mate.isCheckmate()).toBe(true)
  expect(stalemate.isStalemate()).toBe(true)
  for (const position of [mate, stalemate]) {
    expect(await analyze(position.fen(), 4, 24)).toEqual([])
    expect(await analyze(position.fen(), 1, 12, undefined, 1, true)).toEqual([])
  }
  expect(WorkerStub.instances).toHaveLength(0)
  expect(engineMetrics()).toMatchObject({ searches: 0, discarded: 0 })
  const controller = new AbortController(); controller.abort()
  await expect(analyze(mate.fen(), 4, 24, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
it('still rejects a null bestmove when legal moves exist', async () => {
  const { analyze } = await setup()
  const pending = analyze(fen, 4, 18)
  const rejected = expect(pending).rejects.toThrow('Invalid engine output')
  await Promise.resolve()
  WorkerStub.instances[0].emit('bestmove (none)')
  await rejected
})
