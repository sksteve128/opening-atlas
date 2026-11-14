import { Chess } from 'chess.js'
import { describe, expect, it, vi } from 'vitest'
import { generateVerifiedVariation, reverifyVariation } from './repertoire'
import type { Generation, Sources, Variation } from './learning'
import type { Evaluation } from './engine'

const filters = { ratings: [1800], speeds: ['rapid'] }
const uci = (move: { from: string; to: string; promotion?: string }) => move.from + move.to + (move.promotion || '')
const legal = (fen: string) => new Chess(fen).moves({ verbose: true }).map(uci)
const data = (fen: string, moves: { uci: string; games: number }[]) => ({ white: 100, draws: 0, black: 0, source: 'lichess' as const, moves: moves.filter(move => legal(fen).includes(move.uci)).map(move => ({ uci: move.uci, san: move.uci, white: move.games, draws: 0, black: 0 })) })
const options = (fen = new Chess().fen(), side: Generation['side'] = 'white'): Generation => ({ opening: 'Test', startFen: fen, prefix: [], rootFen: fen, side, database: 'lichess', filters, maxPlies: 1, maxMs: 30000, engineDepth: 18, verificationDepth: 24, engineTimeoutMs: 1000, tolerance: 35, mode: 'main', playMode: 'mainline' })

it('leaves an expired candidate unscored and ranks the completed candidate', async () => {
  const start = new Chess().fen(), now = Date.now()
  let elapsed = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + elapsed)
  try {
    const sources: Sources = {
      explorer: async fen => data(fen, [{ uci: 'e2e4', games: 5 }, { uci: 'd2d4', games: 95 }]),
      analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => (searchMoves || legal(fen)).map(move => ({ cp: fen === start ? move === 'e2e4' ? 30 : move === 'd2d4' ? 20 : -200 : -20, depth, line: [move] })).sort((a, b) => b.cp - a.cp).slice(0, count),
    }
    const result = await generateVerifiedVariation({ ...options(), maxMs: 100000 }, [], sources, undefined, phase => { if (phase.startsWith('Scoring candidate 2')) elapsed = 56000 })
    expect(result.moves[0].uci).toBe('e2e4')
    expect(result.recommendation?.scoring).toBe('complete')
    expect(result.recommendation?.alternatives).toContainEqual(expect.objectContaining({ firstMove: 'd4', scoring: 'budget-exhausted', score: undefined }))
  } finally { clock.mockRestore() }
})

it('reuses rollout MultiPV for sharpness within the same generation', async () => {
  const hits: string[] = [], calls: { fen: string; count: number; depth: number }[] = []
  const sources: Sources = {
    onCacheHit: source => hits.push(source),
    explorer: async fen => data(fen, []),
    analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => {
      calls.push({ fen, count, depth })
      return (searchMoves || legal(fen)).slice(0, count).map((move, index) => ({ cp: -index * 100, depth, line: [move] }))
    },
  }
  await generateVerifiedVariation({ ...options(), maxPlies: 3 }, [], sources)
  expect(hits.filter(hit => hit === 'engine').length).toBeGreaterThanOrEqual(2)
  for (const call of calls.filter(call => call.count === 6)) expect(calls).not.toContainEqual({ ...call, count: 4 })
})

it('does not rank an interrupted shorter rollout alongside a complete sample', async () => {
  const start = new Chess().fen(), d4 = new Chess(); d4.move('d4')
  const sources: Sources = {
    explorer: async fen => data(fen, [{ uci: 'e2e4', games: 5 }, { uci: 'd2d4', games: 95 }]),
    analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => {
      if (fen === d4.fen() && count === 6) throw new Error('Engine timed out')
      return (searchMoves || legal(fen)).map(move => ({ cp: fen === start ? move === 'e2e4' ? 30 : move === 'd2d4' ? 20 : -200 : -20, depth, line: [move] })).sort((a, b) => b.cp - a.cp).slice(0, count)
    },
  }
  const result = await generateVerifiedVariation({ ...options(), maxPlies: 3 }, [], sources)
  expect(result.moves[0].uci).toBe('e2e4')
  expect(result.recommendation?.scoring).toBe('complete')
  expect(result.recommendation?.alternatives).toContainEqual(expect.objectContaining({ firstMove: 'd4', scoring: 'partial', score: undefined, sampledPlies: 1 }))
})

it('keeps deeper independent verification when discovering continuations at moderate depth', async () => {
  const calls: { count: number; depth: number; refresh?: boolean; searchMoves?: string[] }[] = []
  const sources: Sources = {
    explorer: async fen => data(fen, []),
    analyze: async (fen, count, depth, _signal, _timeout, refresh, searchMoves) => {
      calls.push({ count, depth, refresh, searchMoves })
      return (searchMoves || legal(fen)).slice(0, count).map((move, index) => ({ cp: -index * 100, depth, line: [move] }))
    },
  }
  const result = await generateVerifiedVariation({ ...options(), engineDepth: 20, maxPlies: 3 }, [], sources)
  expect(result.recommendation?.configuration?.discoveryDepth).toBe(18)
  expect(calls).toContainEqual(expect.objectContaining({ count: 6, depth: 18 }))
  expect(calls).toContainEqual(expect.objectContaining({ count: 4, depth: 20 }))
  expect(calls).toContainEqual(expect.objectContaining({ count: 1, depth: 24, refresh: true, searchMoves: undefined }))
  expect(calls.some(call => call.depth === 24 && call.refresh && call.searchMoves?.length === 1)).toBe(true)
  expect(calls.filter(call => call.refresh).every(call => call.depth >= 22)).toBe(true)
  expect(result.recommendation?.verification).toBe('passed')
})

it('rejects a shallow favorite that fails deeper verification and keeps weighted human evidence', async () => {
  const start = new Chess().fen(), calls: { fen: string; depth: number; moves?: string[] }[] = [], phases: string[] = [], draftStates: string[] = []
  const sources: Sources = {
    explorer: async fen => fen === start ? data(fen, [{ uci: 'e2e4', games: 70 }, { uci: 'd2d4', games: 30 }]) : data(fen, [{ uci: 'e7e5', games: 70 }, { uci: 'c7c5', games: 30 }, { uci: 'd7d5', games: 70 }, { uci: 'g8f6', games: 30 }]),
    analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves): Promise<Evaluation[]> => {
      calls.push({ fen, depth, moves: searchMoves })
      const moves = searchMoves || legal(fen)
      const ranked = moves.map(move => ({ cp: fen === start ? move === 'e2e4' ? depth >= 24 && searchMoves ? -200 : 30 : move === 'd2d4' ? 20 : -200 : fen.split(' ')[1] === 'w' ? move === 'e2e4' ? 60 : 20 : -20, depth, line: [move] }))
      return ranked.sort((a, b) => b.cp - a.cp).slice(0, count)
    },
  }
  const result = await generateVerifiedVariation(options(), [], sources, undefined, (phase, draft) => { phases.push(phase); if (draft?.recommendation) draftStates.push(draft.recommendation.verification) })
  expect(result.moves[0].uci).toBe('d2d4')
  expect(result.recommendation).toMatchObject({ verification: 'passed', depth: 24, configuration: { candidateDepth: 18, verificationDepth: 24 } })
  expect(result.recommendation?.humanCoverage).toBeGreaterThan(0)
  expect(result.recommendation?.alternatives?.[0]).toMatchObject({ firstMove: 'e4', verified: false })
  expect(calls).toContainEqual(expect.objectContaining({ fen: start, depth: 24, moves: ['e2e4'] }))
  expect(calls.filter(call => call.fen === start && call.depth === 24 && !call.moves)).toHaveLength(1)
  expect(phases).toContain('Finding candidate lines…')
  expect(phases.some(phase => phase.startsWith('Verifying candidate'))).toBe(true)
  expect(draftStates).toContain('pending')
  expect(draftStates).not.toContain('passed')
})

it('evaluates a Black recommendation from Black’s perspective and permits a sound second choice', async () => {
  const game = new Chess(); game.move('e4'); const start = game.fen()
  const sources: Sources = {
    explorer: async fen => data(fen, []),
    analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => (searchMoves || legal(fen)).map(move => ({ cp: fen === start ? move === 'e7e5' ? 30 : move === 'c7c5' ? 20 : -200 : -40, depth, line: [move] })).sort((a, b) => b.cp - a.cp).slice(0, count),
  }
  const result = await generateVerifiedVariation(options(start, 'black'), [], sources)
  expect(result.recommendation?.verification).toBe('passed')
  expect(result.recommendation?.objectiveCp).toBe(40)
  expect(['e7e5', 'c7c5']).toContain(result.moves[0].uci)
})

describe('verification failures', () => {
  it('never recommends a move with excessive deep evaluation loss', async () => {
    const start = new Chess().fen()
    const sources: Sources = {
      explorer: async fen => data(fen, []),
      analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => (searchMoves || legal(fen)).map(move => ({ cp: fen === start && searchMoves ? -500 : fen === start ? move === 'e2e4' ? 30 : -200 : -20, depth, line: [move] })).sort((a, b) => b.cp - a.cp).slice(0, count),
    }
    const result = await generateVerifiedVariation(options(), [], sources)
    expect(result.recommendation?.verification).toBe('failed')
    expect(result.status).toBe('incomplete')
  })
})

it('can select a sound practical move that is not the shallow engine favorite', async () => {
  const start = new Chess().fen()
  const sources: Sources = {
    explorer: async fen => fen === start ? data(fen, [{ uci: 'e2e4', games: 20 }, { uci: 'd2d4', games: 80 }]) : data(fen, []),
    analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => (searchMoves || legal(fen)).map(move => ({ cp: fen === start ? move === 'e2e4' ? 30 : move === 'd2d4' ? 20 : -200 : -20, depth, line: [move] })).sort((a, b) => b.cp - a.cp).slice(0, count),
  }
  const result = await generateVerifiedVariation(options(), [], sources)
  expect(result.moves[0].uci).toBe('d2d4')
  expect(result.recommendation?.verification).toBe('passed')
})

it('records a material offer and requires deeper soundness rather than rejecting it outright', async () => {
  const fen = '4k3/8/6p1/8/8/8/8/3QK3 w - - 0 1'
  const sources: Sources = {
    explorer: async position => data(position, []),
    analyze: async (position, count, depth, _signal, _timeout, _refresh, searchMoves) => position === fen ? [{ cp: 20, depth, line: ['d1h5', 'g6h5'] }] : (searchMoves || legal(position)).slice(0, count).map(move => ({ cp: -20, depth, line: [move] })),
  }
  const result = await generateVerifiedVariation(options(fen), [], sources)
  expect(result.recommendation).toMatchObject({ verification: 'passed', sacrificeCp: 900 })
})

it('stops on cancellation before any recommendation is made', async () => {
  const controller = new AbortController(); controller.abort()
  const sources: Sources = { explorer: async fen => data(fen, []), analyze: async () => { throw new Error('Engine should not run') } }
  await expect(generateVerifiedVariation(options(), [], sources, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it('reverifies an older saved line without changing its moves or practice history', async () => {
  const start = new Chess().fen(), after = new Chess(); after.move('e4')
  const line = { id: 'saved', startFen: start, side: 'white', moves: [{ uci: 'e2e4', san: 'e4', source: 'import' }], stats: { firstTry: 2, errors: 1, reveals: 0, completions: 3, totalMs: 1000 }, customName: 'My line', status: 'instructional' } as Variation
  const sources: Sources = { explorer: async fen => data(fen, []), analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => (searchMoves || legal(fen)).map(move => ({ cp: fen === start ? move === 'e2e4' ? 20 : -200 : -20, depth, line: [move] })).sort((a, b) => b.cp - a.cp).slice(0, count) }
  const result = await reverifyVariation(line, sources)
  expect(result.recommendation).toMatchObject({ verification: 'passed', objectiveCp: 20, depth: 24 })
  expect(result.moves).toBe(line.moves)
  expect(result.stats).toBe(line.stats)
  expect(result.customName).toBe('My line')
})

it('weights tested human replies by their actual game frequencies', async () => {
  const start = new Chess().fen(), after = new Chess(); after.move('e4')
  const e5 = new Chess(after.fen()); e5.move('e5')
  const c5 = new Chess(after.fen()); c5.move('c5')
  const sources: Sources = {
    explorer: async fen => fen === after.fen() ? data(fen, [{ uci: 'e7e5', games: 70 }, { uci: 'c7c5', games: 30 }]) : data(fen, []),
    analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => fen === start ? [{ cp: 20, depth, line: ['e2e4'] }] : (searchMoves || legal(fen)).slice(0, count).map(move => ({ cp: fen === e5.fen() ? 100 : fen === c5.fen() ? 0 : -20, depth, line: [move] })),
  }
  const result = await generateVerifiedVariation(options(), [], sources)
  expect(result.recommendation).toMatchObject({ verification: 'passed', humanExpectedCp: 70, humanCoverage: 1 })
})

it('reports when every root move is already covered', async () => {
  const sources: Sources = { explorer: async fen => data(fen, []), analyze: async (_fen, _count, depth) => [{ cp: 20, depth, line: ['e2e4'] }] }
  await expect(generateVerifiedVariation({ ...options(), excludeRootMoves: ['e2e4'] }, [], sources)).rejects.toThrow('No uncovered')
})

it('does not recommend a Black continuation that fails deeper analysis', async () => {
  const game = new Chess(); game.move('e4'); const start = game.fen()
  const sources: Sources = {
    explorer: async fen => data(fen, []),
    analyze: async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => fen === start ? [{ cp: searchMoves ? -400 : 30, depth, line: ['e7e5'] }] : (searchMoves || legal(fen)).slice(0, count).map(move => ({ cp: 100, depth, line: [move] })),
  }
  const result = await generateVerifiedVariation(options(start, 'black'), [], sources)
  expect(result.recommendation?.verification).toBe('failed')
  expect(result.status).toBe('incomplete')
})

it('keeps a saved line pending when re-verification is stopped below the required depth', async () => {
  const start = new Chess().fen()
  const line: Variation = { id: 'partial', endPosition: '', fallback: false, name: 'Partial', opening: 'Test', startFen: start, moves: [{ uci: 'e2e4', san: 'e4', source: 'engine' }], side: 'white', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, pgn: '1. e4', created: 1, stats: { firstTry: 1, errors: 2, reveals: 0, completions: 3, totalMs: 100 }, status: 'incomplete' }
  const src: Sources = { explorer: async fen => data(fen, []), analyze: async (_fen, _count, depth) => [{ cp: 20, depth: depth - 1, line: ['e2e4'], search: { requestedDepth: depth, achievedDepth: depth - 1, durationMs: 30000, queueMs: 0, multiPVComplete: true, endedNaturally: false, stoppedByBudget: true } }] }
  const result = await reverifyVariation(line, src)
  expect(result.moves).toEqual(line.moves)
  expect(result.stats).toEqual(line.stats)
  expect(result.recommendation).toMatchObject({ verification: 'pending', preliminary: true })
  expect(result.status).toBe('incomplete')
})
