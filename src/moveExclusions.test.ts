import { Chess } from 'chess.js'
import { afterEach, expect, it, vi } from 'vitest'
import { exclusionKey, legalGenerationMoves, readExclusions, EXCLUSIONS_STORAGE } from './moveExclusions'
import { generateSimpleRepertoire } from './simpleGeneration'
import { lineFen, type Generation, type Sources } from './learning'

const root = new Chess().fen()
const opts: Generation = { opening: 'Fresh board', startFen: root, prefix: [], freshOpening: true, side: 'white', database: 'lichess', filters: { ratings: [2000], speeds: ['rapid'] }, maxPlies: 4, maxMs: 20000, engineDepth: 16, tolerance: 35, mode: 'here', seed: 42, humanPolicy: 'simulation' }
const uci = (fen: string) => legalGenerationMoves(fen, 'white').map(m => m.uci)
function sources(): Sources {
  return {
    analyze: vi.fn<Sources['analyze']>(async (fen, count, depth, _signal, _timeout, _refresh, searchMoves) => (searchMoves || uci(fen)).slice(0, count).map(move => ({ cp: searchMoves ? -100 : 20, depth, line: [move] }))),
    explorer: vi.fn<Sources['explorer']>(async fen => {
      const moves = uci(fen)
      const preferred = fen === root ? ['e2e4', 'd2d4', 'c2c4', 'g1f3'] : fen.split(' ')[1] === 'b' ? ['e7e5', 'c7c5', 'e7e6', 'c7c6'] : moves.slice(0, 4)
      return { source: 'lichess', white: 100, draws: 0, black: 0, moves: preferred.filter(m => moves.includes(m)).map((move, i) => ({ uci: move, san: '', white: [50, 35, 10, 5][i], draws: 0, black: 0 })) }
    }),
  }
}
afterEach(() => vi.unstubAllGlobals())

it.each(['white', 'black'] as const)('samples only the first user opening decision for %s, then single-PV Stockfish', async side => {
  const src = sources(), line = await generateSimpleRepertoire({ ...opts, side }, [], src)
  expect(line.moves).toHaveLength(4)
  expect(line.moves[side === 'white' ? 0 : 1]).toMatchObject({ openingChoice: true, source: 'lichess' })
  expect(line.moves[side === 'white' ? 2 : 3].source).toBe('engine')
  expect(line.moves.filter(m => m.openingChoice)).toHaveLength(1)
  expect(src.analyze).toHaveBeenCalledTimes(1)
  expect(lineFen(line)).toBeTruthy()
})

it('keeps the fresh-board human opening choice before applying a requested style', async () => {
  const src = sources()
  const line = await generateSimpleRepertoire({ ...opts, style: 'aggressive', maxPlies: 1 }, [], src)
  expect(line.moves[0]).toMatchObject({ openingChoice: true, source: 'lichess' })
  expect(src.analyze).not.toHaveBeenCalled()
})

it('renormalizes actual counts and preserves seeded randomness', async () => {
  const exclusions = { [exclusionKey(root, 'white')]: ['e2e4'] }
  const a = await generateSimpleRepertoire({ ...opts, exclusions, maxPlies: 1 }, [], sources())
  const b = await generateSimpleRepertoire({ ...opts, exclusions, maxPlies: 1 }, [], sources())
  expect(a.moves).toEqual(b.moves)
  expect(a.moves[0].uci).not.toBe('e2e4')
  expect(a.moves[0].sampling?.eligibleGames).toBe(50)
  expect(a.moves[0].sampling?.probability).toBeCloseTo(({ d2d4: .7, c2c4: .2, g1f3: .1 } as Record<string, number>)[a.moves[0].uci])
  expect(a.exclusions).toEqual(exclusions)
})

it('excludes Black e5 only at the configured position and playing side', async () => {
  const game = new Chess(); game.move('e4')
  const exclusions = { [exclusionKey(game.fen(), 'black')]: ['e7e5', 'c7c5'] }
  const src = sources(), original = src.explorer
  src.explorer = async (...args) => args[0] === root ? { white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'e2e4', san: 'e4', white: 100, draws: 0, black: 0 }] } : original(...args)
  const result = await generateSimpleRepertoire({ ...opts, side: 'black', exclusions, maxPlies: 2 }, [], src)
  expect(result.moves[0].uci).toBe('e2e4')
  expect(['e7e6', 'c7c6']).toContain(result.moves[1].uci)
  expect(result.moves[1].sampling?.eligibleGames).toBe(15)
  expect(legalGenerationMoves(game.fen(), 'white', exclusions).some(m => m.uci === 'e7e5')).toBe(true)
  const other = new Chess(); other.move('d4')
  expect(legalGenerationMoves(other.fen(), 'black', exclusions).some(m => m.uci === 'e7e5')).toBe(true)
})

it('keeps castling, en passant and halfmove rules in canonical keys', () => {
  const position = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 3'
  expect(exclusionKey(position, 'white')).not.toBe(exclusionKey(position.replace('d6', '-'), 'white'))
  expect(exclusionKey(root, 'white')).not.toBe(exclusionKey(root.replace('KQkq', '-'), 'white'))
  expect(exclusionKey(root, 'white')).not.toBe(exclusionKey(root.replace('0 1', '4 1'), 'white'))
  expect(exclusionKey(root, 'white')).toBe(exclusionKey(root.replace('0 1', '0 5'), 'white'))
  const a = new Chess(); ['Nf3', 'Nf6', 'Nc3', 'Nc6'].forEach(move => a.move(move))
  const b = new Chess(); ['Nc3', 'Nc6', 'Nf3', 'Nf6'].forEach(move => b.move(move))
  expect(exclusionKey(a.fen(), 'white')).toBe(exclusionKey(b.fen(), 'white'))
  const e4 = new Chess(); e4.move('e4')
  expect(exclusionKey(e4.fen(), 'black')).toBe(exclusionKey(e4.fen().replace(' e3 ', ' - '), 'black'))
})

it('does not restrict the opponent human model when playing Black from a fresh board', async () => {
  const src = sources(); src.explorer = async () => ({ white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'e2e4', san: 'e4', white: 100, draws: 0, black: 0 }] })
  const line = await generateSimpleRepertoire({ ...opts, side: 'black', exclusions: { [exclusionKey(root, 'black')]: ['e2e4'] }, maxPlies: 2 }, [], src)
  expect(line.moves[0].uci).toBe('e2e4')
  expect(line.moves[0].source).toBe('lichess')
})

it('uses searchmoves for the excluded best engine move and records actual comparison depth', async () => {
  const src = sources(), excluded = uci(root)[0]
  const line = await generateSimpleRepertoire({ ...opts, freshOpening: false, exclusions: { [exclusionKey(root, 'white')]: [excluded] }, maxPlies: 1 }, [], src)
  expect(line.moves[0].uci).not.toBe(excluded)
  expect(vi.mocked(src.analyze).mock.calls[1][6]).toEqual(uci(root).filter(m => m !== excluded))
  expect(line.moves[0]).toMatchObject({ depth: 16, restriction: { bestOverall: excluded, lossCp: 120, overallDepth: 16 } })
})

it('does not invent a loss comparison when depths differ', async () => {
  const src = sources(), original = src.analyze
  src.analyze = async (...args) => (await original(...args)).map(e => ({ ...e, depth: args[6] ? 12 : 16 }))
  const line = await generateSimpleRepertoire({ ...opts, freshOpening: false, exclusions: { [exclusionKey(root, 'white')]: [uci(root)[0]] }, maxPlies: 1 }, [], src)
  expect(line.moves[0].depth).toBe(12)
  expect(line.moves[0].restriction?.lossCp).toBeUndefined()
})

it('stops explicitly if all legal moves are excluded', async () => {
  const src = sources()
  const line = await generateSimpleRepertoire({ ...opts, exclusions: { [exclusionKey(root, 'white')]: uci(root) } }, [], src)
  expect(line.moves).toHaveLength(0)
  expect(line.termination).toContain('exclusions leave no legal moves')
  expect(src.analyze).not.toHaveBeenCalled(); expect(src.explorer).not.toHaveBeenCalled()
})

it('expands uncovered first opening choices without modifying saved lines or practice', async () => {
  const settings = { ...opts, humanPolicy: 'expansion' as const, maxPlies: 1 }
  const first = await generateSimpleRepertoire(settings, [], sources()); first.stats.completions = 7
  const before = JSON.stringify(first)
  const second = await generateSimpleRepertoire(settings, [first], sources())
  expect(second.moves[0].uci).not.toBe(first.moves[0].uci)
  expect(second.moves[0].sampling?.policy).toBe('expansion')
  expect(JSON.stringify(first)).toBe(before)
  const simulation = await generateSimpleRepertoire({ ...settings, humanPolicy: 'simulation' }, [first], sources())
  expect(simulation.moves[0].uci).toBe(first.moves[0].uci)
})

it('does not apply opening sampling with history, named-opening opt-out, or an arbitrary FEN', async () => {
  const game = new Chess(), prefix = ['d4', 'd5', 'Bf4'].map(san => { const m = game.move(san); return { uci: m.from + m.to, san, source: 'preset' as const } })
  const exclusions = { [exclusionKey(game.fen(), 'black')]: [uci(game.fen())[0]] }
  const named = await generateSimpleRepertoire({ ...opts, opening: 'Accelerated London', side: 'black', prefix, exclusions, maxPlies: 1 }, [], sources())
  expect(named.moves.slice(0, 3)).toEqual(prefix)
  expect(named.moves[3]).toMatchObject({ source: 'engine' }); expect(named.moves[3].restriction).toBeDefined()
  const arbitrary = await generateSimpleRepertoire({ ...opts, startFen: game.fen(), side: 'black', maxPlies: 1 }, [], sources())
  expect(arbitrary.moves[0].source).toBe('engine')
  expect((await generateSimpleRepertoire({ ...opts, freshOpening: false, maxPlies: 1 }, [], sources())).moves[0].source).toBe('engine')
})

it('stops on unavailable opening probabilities or explicitly labels engine fallback', async () => {
  const src = sources(); src.explorer = async () => ({ source: 'book', unavailableReason: 'HTTP 401', white: 0, draws: 0, black: 0, moves: [] })
  const stopped = await generateSimpleRepertoire(opts, [], src)
  expect(stopped.moves).toHaveLength(0); expect(stopped.fallback).toBe(false)
  const fallback = await generateSimpleRepertoire({ ...opts, limitedHumanData: 'engine', exclusions: { [exclusionKey(root, 'white')]: [uci(root)[0]] }, maxPlies: 1 }, [], src)
  expect(fallback.moves[0]).toMatchObject({ source: 'engine', engineFallback: true, openingChoice: true })
  expect(fallback.moves[0].sampling).toBeUndefined()
  expect(fallback.moves[0].uci).not.toBe(uci(root)[0])
})

it('persists exclusions independently of saved variations and rejects malformed storage', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k), setItem: (k: string, v: string) => values.set(k, v) })
  const rules = { [exclusionKey(root, 'white')]: ['e2e4'] }
  localStorage.setItem(EXCLUSIONS_STORAGE, JSON.stringify(rules))
  expect(readExclusions()).toEqual(rules)
  localStorage.setItem(EXCLUSIONS_STORAGE, '{broken'); expect(readExclusions()).toEqual({})
})

it('filters and renormalizes model predictions without inventing game counts', async () => {
  const src = sources(); src.explorer = async () => ({ source: 'book', white: 0, draws: 0, black: 0, moves: [] })
  src.humanModel = { id: 'fixture', version: '1', minRating: 1000, maxRating: 3000, predict: async (_fen, rating) => ({ model: 'fixture', version: '1', rating, calibrated: false, moves: [{ uci: 'e2e4', probability: .9 }, { uci: 'd2d4', probability: .1 }] }) }
  const result = await generateSimpleRepertoire({ ...opts, exclusions: { [exclusionKey(root, 'white')]: ['e2e4'] }, maxPlies: 1 }, [], src)
  expect(result.moves[0]).toMatchObject({ uci: 'd2d4', source: 'model', prediction: { probability: 1 }, openingChoice: true })
  expect(result.moves[0].games).toBeUndefined()
})

it('uses explicitly selected engine fallback when all returned human moves are excluded', async () => {
  const result = await generateSimpleRepertoire({ ...opts, exclusions: { [exclusionKey(root, 'white')]: ['e2e4', 'd2d4', 'c2c4', 'g1f3'] }, limitedHumanData: 'engine', maxPlies: 1 }, [], sources())
  expect(result.moves[0]).toMatchObject({ source: 'engine', engineFallback: true })
})
