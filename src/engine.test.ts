import { Chess } from 'chess.js'
import { expect, it, vi } from 'vitest'
import { reusableAnalysis, type Evaluation } from './engine'

it('reuses complete deeper MultiPV results only for compatible requests', () => {
  const fen = new Chess().fen()
  const moves = new Chess().moves({ verbose: true }).slice(0, 6).map(move => move.from + move.to)
  const entries: Evaluation[] = moves.map((move, index) => ({ cp: 100 - index, depth: 20, line: [move] }))
  const cache = new Map([[`${fen}|6|20|`, entries]])
  expect(reusableAnalysis(cache, fen, 4, 20)).toEqual(entries.slice(0, 4))
  expect(reusableAnalysis(cache, fen, 4, 21)).toBeUndefined()
  expect(reusableAnalysis(cache, fen, 7, 20)).toBeUndefined()
  expect(reusableAnalysis(cache, fen, 1, 20, [moves[0]])).toBeUndefined()
  expect(reusableAnalysis(new Map(), fen, 4, 20)).toBeUndefined()
  for (const incomplete of [entries.slice(0, 4), entries.map((entry, index) => index === 5 ? { ...entry, depth: 19 } : entry), [...entries.slice(0, 5), entries[0]]]) {
    expect(reusableAnalysis(new Map([[`${fen}|6|20|`, incomplete]]), fen, 4, 18)).toBeUndefined()
  }
  const restricted = new Map([[`${fen}|2|20|${moves.slice(0, 2).join(',')}`, entries.slice(0, 2)]])
  expect(reusableAnalysis(restricted, fen, 1, 20)).toBeUndefined()
  expect(reusableAnalysis(restricted, fen, 1, 20, moves.slice(0, 2).reverse())).toEqual(entries.slice(0, 1))
})

it('asks Stockfish to evaluate the requested human candidates with MultiPV', async () => {
  const commands: string[] = []
  class WorkerStub {
    private listener?: (event: MessageEvent<string>) => void
    addEventListener(_type: string, listener: (event: MessageEvent<string>) => void) { this.listener = listener }
    removeEventListener() { this.listener = undefined }
    terminate() {}
    postMessage(command: string) {
      commands.push(command)
      if (command.startsWith('go ')) queueMicrotask(() => {
        this.listener?.({ data: 'info depth 14 multipv 1 score cp 30 wdl 400 500 100 pv e2e4' } as MessageEvent<string>)
        this.listener?.({ data: 'info depth 14 multipv 2 score cp 20 pv d2d4' } as MessageEvent<string>)
        this.listener?.({ data: 'bestmove e2e4' } as MessageEvent<string>)
      })
    }
  }
  vi.stubGlobal('Worker', WorkerStub)
  vi.resetModules()
  const { analyze } = await import('./engine')
  const result = await analyze(new Chess().fen(), 2, 14, undefined, 1000, false, ['e2e4', 'd2d4'])
  expect(commands).toContain('setoption name UCI_ShowWDL value true')
  expect(result[0].wdl).toEqual([400, 500, 100])
  expect(commands).toContain('setoption name MultiPV value 2')
  expect(commands).toContain('go depth 14 searchmoves e2e4 d2d4')
  expect(result.map(entry => entry.line[0])).toEqual(['e2e4', 'd2d4'])
  vi.unstubAllGlobals()
})

it('bounds queue waiting and cancels queued work without interrupting an unrelated search', async () => {
  const commands: string[] = []
  let finish: (() => void) | undefined
  class WorkerStub {
    listener?: (event: MessageEvent<string>) => void
    addEventListener(_type: string, listener: (event: MessageEvent<string>) => void) { this.listener = listener }
    removeEventListener() { this.listener = undefined }
    terminate() { commands.push('terminate') }
    postMessage(command: string) {
      commands.push(command)
      if (command.startsWith('go ')) finish = () => {
        this.listener?.({ data: 'info depth 16 multipv 1 score cp 20 pv e2e4' } as MessageEvent<string>)
        this.listener?.({ data: 'bestmove e2e4' } as MessageEvent<string>)
      }
    }
  }
  vi.stubGlobal('Worker', WorkerStub); vi.resetModules()
  try {
    const { analyze, engineMetrics } = await import('./engine')
    const active = analyze(new Chess().fen(), 1, 16, undefined, 1000)
    await Promise.resolve()
    const queued = analyze(new Chess().fen(), 1, 18, undefined, 20)
    await expect(queued).rejects.toThrow('including queue waiting')
    const control = new AbortController()
    const cancelled = analyze(new Chess().fen(), 1, 20, control.signal, 1000)
    control.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(commands).not.toContain('terminate')
    finish!(); await active
    await Promise.resolve(); await Promise.resolve()
    expect(commands.filter(command => command.startsWith('go '))).toHaveLength(1)
    expect(engineMetrics().queueMs).toBeGreaterThanOrEqual(15)
  } finally { vi.unstubAllGlobals() }
})

it('rejects an active timeout and never caches its incomplete output', async () => {
  let killed = 0
  class WorkerStub {
    addEventListener() {}
    removeEventListener() {}
    terminate() { killed++ }
    postMessage() {}
  }
  vi.stubGlobal('Worker', WorkerStub); vi.resetModules()
  try {
    const { analyze, cachedAnalysis } = await import('./engine')
    await expect(analyze(new Chess().fen(), 3, 16, undefined, 20)).rejects.toThrow('Engine timed out')
    expect(killed).toBe(1)
    expect(cachedAnalysis(new Chess().fen(), 3, 16)).toBeUndefined()
  } finally { vi.unstubAllGlobals() }
})
it('prefers deeper compatible cache entries even when a shallower result arrived later',()=>{
  const fen=new Chess().fen(),deep=[{cp:10,depth:20,line:['e2e4']}],shallow=[{cp:30,depth:12,line:['d2d4']}]
  expect(reusableAnalysis(new Map([[`${fen}|1|20|`,deep],[`${fen}|1|12|`,shallow]]),fen,1,8)).toEqual(deep)
})
