import { Chess } from 'chess.js'
import { expect, it, vi } from 'vitest'
import { generateHumanRepertoire, verificationReasons } from './humanGeneration'
import { lineFen, saveVariation, restoreActiveLine, type Generation, type Sources, type Variation } from './learning'
import { estimateFastSharpness, type SharpnessResult } from './sharpness'
import { beginMemory, finishMemory, emptyMemoryStats } from './memorize'

const root = new Chess().fen()
const legal = (fen: string) => new Chess(fen).moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''))
const options: Generation = { opening: 'Test', startFen: root, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2200, 2500], speeds: ['rapid'] }, maxPlies: 20, maxMs: 20000, engineDepth: 16, verificationDepth: 24, tolerance: 35, mode: 'main', seed: 42, humanPolicy: 'simulation', engineFallback: false }
function sources(): Sources {
  return {
    explorer: vi.fn<Sources['explorer']>(async fen => ({ white: 100, draws: 0, black: 0, source: 'lichess', moves: legal(fen).slice(0, 2).map((uci, i) => ({ uci, san: uci, white: i ? 20 : 80, draws: 0, black: 0 })) })),
    analyze: vi.fn<Sources['analyze']>(async (fen, n, depth, _signal, _timeout, _refresh, restricted) => (restricted || legal(fen)).slice(0, n).map(uci => ({ cp: 0, depth, line: [uci] }))),
  }
}
it.each(['white', 'black'] as const)('builds a %s opening with one search per user decision and one endpoint check', async side => {
  const src = sources(), line = await generateHumanRepertoire({ ...options, side }, [], src)
  expect(line.moves).toHaveLength(20)
  expect(src.analyze).toHaveBeenCalledTimes(11)
  expect(src.explorer).toHaveBeenCalledTimes(10)
  expect(line.moves.filter(m => m.sampling)).toHaveLength(10)
  expect(line.recommendation).toMatchObject({ verification: 'passed', verifiedMoves: 10, verificationScope: 'adaptive', stopKind: 'length' })
  expect(lineFen(line).split(' ').slice(0, 4).join(' ')).toBe(line.endPosition)
  for (const call of vi.mocked(src.analyze).mock.calls) expect(call[2]).toBe(16)
  for (const call of vi.mocked(src.explorer).mock.calls) { expect(call[1]).toEqual(options.filters); expect(call[3]).toBe('lichess') }
})
it('reuses compatible global MultiPV and cached fast sharpness without extra searches', async () => {
  const src = sources(), cached = await src.analyze(root, 3, 18)
  vi.mocked(src.analyze).mockClear()
  src.cached = (fen, n, depth) => fen === root && n <= 3 && depth <= 18 ? cached.slice(0, n) : undefined
  const sharp: SharpnessResult = { fen: root, white: estimateFastSharpness(root, cached), whiteProjected: false, blackProjected: true, continuations: [], complete: false, depth: 18 }
  src.fastSharpness = vi.fn(fen => fen === root ? sharp : undefined)
  const line = await generateHumanRepertoire({ ...options, maxPlies: 1 }, [], src)
  expect(src.analyze).toHaveBeenCalledTimes(1)
  expect(line.recommendation?.performance).toMatchObject({ engineCacheHits: 1, sharpnessCacheHits: 1, searches: 1 })
  expect(line.recommendation?.userDifficulty).toBe(sharp.white?.score)
})
it('selects the strongest sound candidate without human reply evaluation trees', async () => {
  const src = sources(), analyze = src.analyze
  src.analyze = vi.fn<Sources['analyze']>(async (...args) => (await analyze(...args)).map((entry, i) => ({ ...entry, cp: -i * 20 })))
  const line = await generateHumanRepertoire({ ...options, maxPlies: 1 }, [], src)
  expect(line.moves[0].uci).toBe(legal(root)[0])
  expect(src.analyze).toHaveBeenCalledTimes(2)
  expect(src.explorer).not.toHaveBeenCalled()
  expect(line.human?.decisions).toEqual([]) // No invented branch utilities or human win estimates.
})
it('stops explicitly on absent human data, or uses only an explicitly selected engine fallback', async () => {
  const src = sources(); src.explorer = vi.fn<Sources['explorer']>(async () => ({ white: 0, draws: 0, black: 0, source: 'book', moves: [], unavailableReason: 'HTTP 401' }))
  const stopped = await generateHumanRepertoire({ ...options, side: 'black' }, [], src)
  expect(stopped.human?.status).toBe('HUMAN DATA UNAVAILABLE')
  expect(stopped.termination).toContain('HTTP 401')
  expect(src.analyze).not.toHaveBeenCalled()
  const fallback = await generateHumanRepertoire({ ...options, side: 'black', engineFallback: true, maxPlies: 2 }, [], src)
  expect(fallback.fallback).toBe(true)
  expect(fallback.moves.every(move => move.source === 'engine' && move.frequency === undefined && move.sampling === undefined)).toBe(true)
})
it('records the actual seeded weighted sample and conditions expansion on uncovered moves', async () => {
  const a = await generateHumanRepertoire({ ...options, side: 'black', humanPolicy: 'expansion', maxPlies: 1 }, [], sources())
  const b = await generateHumanRepertoire({ ...options, side: 'black', humanPolicy: 'expansion', maxPlies: 1 }, [a], sources())
  expect(a.moves[0].sampling?.probability).toBe(.8)
  expect(b.moves[0].uci).not.toBe(a.moves[0].uci)
  expect(b.moves[0].sampling).toMatchObject({ probability: 1, eligibleGames: 20, omittedMass: .8 })
  expect(b.moves[0].frequency).toBe(.2)
})
it.each(['white', 'black'] as const)('requires deeper flexible stability for a %s advantage', async side => {
  const src = sources(), analyze = src.analyze
  src.analyze = vi.fn<Sources['analyze']>(async (...args) => (await analyze(...args)).map(e => ({ ...e, cp: args[0].split(' ')[1] === side[0] ? 170 : -170 })))
  const line = await generateHumanRepertoire({ ...options, side }, [], src)
  expect(line.status).toBe('favorable')
  expect(line.recommendation).toMatchObject({ stopKind: 'advantage', verification: 'passed', depth: 24, objectiveCp: 170 })
  expect(vi.mocked(src.analyze).mock.calls.some(call => call[2] === 24)).toBe(true)
})
it('continues when deeper evaluation refutes a shallow advantage', async () => {
  const src = sources(), analyze = src.analyze
  src.analyze = async (...args) => (await analyze(...args)).map(e => ({ ...e, cp: args[2] === 16 ? (args[0].split(' ')[1] === 'w' ? 170 : -170) : 0 }))
  const line = await generateHumanRepertoire({ ...options, maxPlies: 4 }, [], src)
  expect(line.moves).toHaveLength(4)
  expect(line.status).not.toBe('favorable')
  expect(line.recommendation?.objectiveCp).toBe(0)
})
it('flags sacrifices, exposed kings, checks, and evaluation swings for adaptive verification', () => {
  const sacrifice = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3'
  expect(verificationReasons(sacrifice, [{ cp: 0, depth: 16, line: ['c4f7', 'e8f7'] }])).toContain('material sacrifice')
  expect(verificationReasons(root, [{ cp: -180, depth: 16, line: ['e2e4'] }], 0)).toContain('large evaluation swing')
  expect(verificationReasons('4k3/8/8/8/8/8/4r3/4K2Q w - - 0 1', [{ cp: 0, depth: 16, line: ['e1e2'] }])).toContain('king in check')
  expect(verificationReasons('4k3/8/8/8/8/8/8/4K2Q b - - 0 1', [{ cp: -100, depth: 16, line: ['e8d7'] }])).toContain('exposed king')
})
it('repairs a tactical sacrifice before creating its dependent suffix', async () => {
  const startFen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3', src = sources(), analyze = src.analyze
  src.analyze = vi.fn<Sources['analyze']>(async (...args) => {
    if (args[0] === startFen) {
      if (args[6]) return [{ cp: -200, depth: args[2], line: ['c4f7'] }]
      if (args[2] === 24) return [{ cp: 10, depth: 24, line: ['g1f3'] }]
      return [{ cp: 30, depth: 16, line: ['c4f7', 'e8f7'] }, { cp: 10, depth: 16, line: ['g1f3'] }, { cp: 0, depth: 16, line: ['d2d3'] }]
    }
    return analyze(...args)
  })
  const line = await generateHumanRepertoire({ ...options, startFen, maxPlies: 1 }, [], src)
  expect(line.moves).toHaveLength(1)
  expect(line.moves[0].uci).toBe('g1f3')
  expect(line.human?.repair).toContain('earliest unsound')
  expect(line.recommendation?.verification).toBe('passed')
})
it('never labels a timed out or incomplete search verified', async () => {
  for (const failure of ['timeout', 'partial']) {
    const src = sources(); src.analyze = async () => { if (failure === 'timeout') throw new Error('Engine timed out'); return [{ cp: 0, depth: 15, line: ['e2e4'] }] }
    const line = await generateHumanRepertoire(options, [], src)
    expect(line.moves).toHaveLength(0)
    expect(line.status).toBe('incomplete')
    expect(line.recommendation?.verification).toBe('pending')
    expect(line.recommendation?.preliminary).toBe(true)
    expect(line.recommendation?.practicalChoices).toBeUndefined()
  }
})
it('respects cancellation before starting and during human data retrieval', async () => {
  const control = new AbortController(); control.abort()
  await expect(generateHumanRepertoire(options, [], sources(), control.signal)).rejects.toMatchObject({ name: 'AbortError' })
  const mid = new AbortController(), src = sources()
  src.explorer = async () => { mid.abort(); throw new DOMException('Cancelled', 'AbortError') }
  await expect(generateHumanRepertoire({ ...options, side: 'black' }, [], src, mid.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
it('distinguishes computation exhaustion from a finished line', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(0), src = sources(), analyze = src.analyze
  src.analyze = async (...args) => { const result = await analyze(...args); now.mockReturnValue(20100); return result }
  try {
    const line = await generateHumanRepertoire(options, [], src)
    expect(line.status).toBe('incomplete')
    expect(line.human?.status).toBe('COMPUTATION BUDGET EXHAUSTED')
    expect(line.recommendation?.verification).toBe('pending')
  } finally { now.mockRestore() }
})
it('keeps saved variations and independent memorization progress compatible', async () => {
  const line = await generateHumanRepertoire({ ...options, maxPlies: 2 }, [], sources())
  const saved: Variation = JSON.parse(JSON.stringify(line))
  expect(saveVariation([saved], line)).toHaveLength(1)
  expect(restoreActiveLine([], saved, saved.id)).toEqual([saved])
  const memory = beginMemory(emptyMemoryStats(), saved.id, 0, 2, 1000)
  const stats = finishMemory(memory.stats, { ...memory.session, index: 2 }, 2000)
  const resumed = await generateHumanRepertoire({ ...options, resume: { ...saved, stats: { ...saved.stats, completions: 7 } }, maxPlies: 2 }, [], sources())
  expect(resumed.id).toBe(saved.id)
  expect(resumed.stats.completions).toBe(7)
  expect(stats).toMatchObject({ perfect: 1, completed: 1, attempts: 1 })
})
it('falls back to a bounded search when a supplied cache entry is incomplete', async () => {
  const src = sources()
  src.cached = () => [{ cp: 0, depth: 8, line: ['e2e4'] }]
  const line = await generateHumanRepertoire({ ...options, maxPlies: 1 }, [], src)
  expect(line.recommendation?.verification).toBe('passed')
  expect(src.analyze).toHaveBeenCalledTimes(2)
  expect(line.recommendation?.performance?.engineCacheHits).toBe(0)
})
it('marks earlier unsound decisions failed when subsequent evaluations disagree', async () => {
  const src = sources(), analyze = src.analyze
  src.analyze = async (...args) => {
    if (args[0] === root && args[2] === 24) return [{ cp: args[6] ? -200 : 0, depth: 24, line: [args[6]?.[0] || legal(root)[1]] }]
    const values = await analyze(...args)
    return args[0] === root ? values : values.map(value => ({ ...value, cp: args[0].split(' ')[1] === 'w' ? -180 : 180 }))
  }
  const line = await generateHumanRepertoire({ ...options, maxPlies: 3 }, [], src)
  expect(line.recommendation?.verification).toBe('failed')
  expect(line.recommendation?.verifiedMoves).toBe(0)
  expect(line.status).toBe('incomplete')
})
it('does not retry a deep search that just timed out during final verification', async () => {
  const src = sources(), analyze = src.analyze
  src.analyze = vi.fn<Sources['analyze']>(async (...args) => {
    if (args[2] === 24) throw new Error('Engine timed out')
    return (await analyze(...args)).map(e => ({ ...e, cp: args[0] === root ? 0 : args[0].split(' ')[1] === 'w' ? -150 : 150 }))
  })
  const line = await generateHumanRepertoire({ ...options, maxPlies: 3 }, [], src)
  const deepCalls = vi.mocked(src.analyze).mock.calls.filter(call => call[2] === 24)
  expect(new Set(deepCalls.map(call => [call[0], call[1], call[2], call[6]].join('|'))).size).toBe(deepCalls.length)
  expect(line.recommendation?.verification).toBe('pending')
})

it('keeps coherent shallow discovery preliminary and resumes its saved continuation', async () => {
  const src = sources(), original = src.analyze
  src.analyze = async (...args) => (await original(...args)).map(e => args[1] === 3 ? { ...e, depth: 12, search: { requestedDepth: args[2], achievedDepth: 12, durationMs: 4000, queueMs: 0, multiPVComplete: true, endedNaturally: false, stoppedByBudget: true } } : e)
  const line = await generateHumanRepertoire({ ...options, maxPlies: 4 }, [], src)
  expect(line.moves).toHaveLength(4)
  expect(line.recommendation).toMatchObject({ preliminary: true, verification: 'pending', verifiedMoves: 0 })
  expect(line.recommendation?.performance?.searchDetails).toHaveLength(2)
  const saved: Variation = JSON.parse(JSON.stringify(line))
  const resumed = await generateHumanRepertoire({ ...options, resume: saved, prefix: saved.moves, rootFen: lineFen(saved), maxPlies: 2 }, [], sources())
  expect(resumed.id).toBe(saved.id)
  expect(resumed.moves.slice(0, 4)).toEqual(saved.moves)
  expect(resumed.moves).toHaveLength(6)
  expect(resumed.recommendation?.verification).toBe('pending')
})
it('retains prior moves when required deep verification returns below its target', async () => {
  const src = sources(), original = src.analyze
  src.analyze = async (...args) => (await original(...args)).map(e => ({ ...e, cp: args[0] === root ? 0 : args[0].split(' ')[1] === 'w' ? -150 : 150, ...(args[2] === 24 ? { depth: 18, search: { requestedDepth: 24, achievedDepth: 18, durationMs: 30000, queueMs: 0, multiPVComplete: true, endedNaturally: false, stoppedByBudget: true } } : {}) }))
  const line = await generateHumanRepertoire({ ...options, maxPlies: 3 }, [], src)
  expect(line.moves).toHaveLength(2)
  expect(line.recommendation).toMatchObject({ verification: 'pending', preliminary: true })
  expect(line.termination).toContain('Verification budget expired')
  expect(JSON.parse(JSON.stringify(line)).moves).toEqual(line.moves)
})
it('allocates from the total budget instead of imposing a 2.5 second cap', async () => {
  const src = sources()
  await generateHumanRepertoire({ ...options, maxMs: 180000, maxPlies: 20, engineTimeoutMs: 30000 }, [], src)
  const calls = vi.mocked(src.analyze).mock.calls
  expect(calls[0][4]).toBeGreaterThan(14000)
  expect(calls[0][4]).toBeLessThanOrEqual(15000)
  expect(calls.at(-1)?.[4]).toBe(30000)
})
