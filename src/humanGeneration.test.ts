import { generateDeepHumanRepertoire as generateHumanRepertoire } from './deepHumanGeneration'
import { describe, expect, it, vi } from 'vitest'
import { Chess } from 'chess.js'
import { expectedBounds, expectedScore, humanDistribution, sampleHuman, seededRandom } from './humanGeneration'
import { lineFen, saveVariation, type Generation, type Sources } from './learning'
import { type ExplorerData } from './core'

const root = new Chess().fen()
const data = (fen: string): ExplorerData => ({ white: 50, draws: 25, black: 25, source: 'lichess', moves: new Chess(fen).moves({ verbose: true }).slice(0, 4).map((m, i) => ({ uci: m.from + m.to + (m.promotion || ''), san: m.san, white: [30, 15, 10, 5][i], draws: 0, black: 0 })) })
const options: Generation = { opening: 'Test', startFen: root, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [1600], speeds: ['rapid'] }, maxPlies: 2, engineDepth: 18, verificationDepth: 24, tolerance: 35, mode: 'main', seed: 42, humanPolicy: 'simulation' }
const sources = (cp = 0): Sources => ({
  explorer: vi.fn(async fen => data(fen)),
  analyze: vi.fn(async (fen, n, depth, _s, _t, _fresh, restrict) => (restrict || new Chess(fen).moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''))).slice(0, n).map((uci: string) => ({ cp: fen.split(' ')[1] === 'w' ? cp : -cp, line: [uci], depth, wdl: [300, 400, 300] }))),
})
describe('human probability evidence', () => {
  it('normalizes every eligible move and records omitted position mass', () => {
    const d = humanDistribution(root, data(root))!
    expect(d.moves).toHaveLength(4)
    expect(d.moves.reduce((a, m) => a + m.probability, 0)).toBeCloseTo(1)
    expect(d.moves[0].probability).toBe(.5)
    expect(d.omittedMass).toBeCloseTo(.4)
    expect(humanDistribution(root, data(root), 20, 20)?.omittedMass).toBe(.7)
  })
  it('rejects unavailable, malformed, zero and low samples', () => {
    expect(humanDistribution(root)).toBeUndefined()
    expect(humanDistribution(root, { ...data(root), source: 'book' as const })).toBeUndefined()
    expect(humanDistribution(root, data(root), 101)).toBeUndefined()
    expect(humanDistribution(root, { ...data(root), white: -1 })).toBeUndefined()
    expect(humanDistribution(root, { ...data(root), white: 0, draws: 0, black: 0 })).toBeUndefined()
  })
  it('samples weights and reproduces the same seed', () => {
    const d = humanDistribution(root, data(root))!, random = seededRandom(42)
    const samples = Array.from({ length: 10000 }, () => sampleHuman(d.moves, random).uci)
    expect(samples.filter(m => m === d.moves[0].uci).length / samples.length).toBeCloseTo(.5, 1)
    const replay = seededRandom(42)
    expect(Array.from({ length: 100 }, () => sampleHuman(d.moves, replay).uci)).toEqual(samples.slice(0, 100))
    expect(sampleHuman(d.moves, () => .999).uci).toBe(d.moves[3].uci)
  })
  it('aggregates WDL without interpreting centipawns as probabilities', () => {
    expect(expectedScore({ cp: 999, depth: 20, line: [], wdl: [600, 300, 100] }, true)).toBe(.75)
    expect(expectedScore({ cp: 999, depth: 20, line: [], wdl: [600, 300, 100] }, false)).toBe(.25)
    expect(expectedScore({ cp: 999, depth: 20, line: [] }, true)).toBeUndefined()
    expect(expectedBounds([{ mass: .6, utility: .75 }, { mass: .2, utility: .5 }])).toEqual({ coverage: .8, lower: .5499999999999999, upper: .7499999999999999, utility: .6874999999999999 })
  })
})
describe('human generation', () => {
  it('returns unavailable without any engine fallback', async () => {
    const src = sources(); src.explorer = vi.fn(async () => ({ ...data(root), source: 'book' as const, unavailableReason: 'HTTP 401' }))
    const line = await generateHumanRepertoire(options, [], src)
    expect(line.human?.status).toBe('HUMAN DATA UNAVAILABLE')
    expect(line.termination).toContain('HTTP 401')
    expect(src.analyze).not.toHaveBeenCalled()
    expect(line.moves).toHaveLength(0)
  })
  it.each(['white', 'black'] as const)('generates and verifies %s with persisted sampling evidence', async side => {
    const src = sources()
    const a = await generateHumanRepertoire({ ...options, side }, [], src)
    const b = await generateHumanRepertoire({ ...options, side }, [], sources())
    expect(a.moves.map(m => m.uci)).toEqual(b.moves.map(m => m.uci))
    expect(a.recommendation?.verification).toBe('passed')
    expect(a.human?.status).toBe('SOUND HUMAN CONTINUATION')
    expect(a.moves.filter(m => m.sampling)).toHaveLength(1)
    expect(a.moves.find(m => m.sampling)?.source).toBe('lichess')
    expect(JSON.parse(JSON.stringify(a)).human).toEqual(a.human)
    expect(saveVariation([a], b)).toHaveLength(1)
    expect(a.endPosition).toBe(lineFen(a).split(' ').slice(0, 4).join(' '))
  })
  it('ends on missing human data and verifies instead of extending with engine moves', async () => {
    const src = sources(); src.explorer = vi.fn(async fen => fen === root ? data(root) : { ...data(fen), source: 'book' as const })
    const line = await generateHumanRepertoire({ ...options, side: 'black', maxPlies: 40 }, [], src)
    expect(line.moves).toHaveLength(1)
    expect(line.termination).toContain('Human data ended')
    expect(line.recommendation?.verification).toBe('passed')
  })
  it('prefers uncovered replies in expansion without changing their recorded probabilities', async () => {
    const a = await generateHumanRepertoire({ ...options, side: 'black', humanPolicy: 'expansion', maxPlies: 1 }, [], sources())
    const b = await generateHumanRepertoire({ ...options, side: 'black', humanPolicy: 'expansion', maxPlies: 1 }, [a], sources())
    expect(b.moves[0].uci).not.toBe(a.moves[0].uci)
    expect(a.moves[0].sampling?.probability).toBe(.5)
    expect(b.moves[0].sampling?.probability).toBe(.25)
  })
  it('confirms a flexible stable advantage from either perspective', async () => {
    for (const side of ['white', 'black'] as const) {
      const line = await generateHumanRepertoire({ ...options, side }, [], sources(side === 'white' ? 170 : -170))
      expect(line.human?.status).toBe('ADVANTAGE ACHIEVED')
      expect(line.recommendation?.objectiveCp).toBe(170)
      expect(line.recommendation?.depth).toBe(24)
    }
  })
  it('does not label a one-move advantage stable', async () => {
    const src = sources(170), analyze = src.analyze
    src.analyze = async (...args) => (await analyze(...args)).map((e, i) => ({ ...e, cp: e.cp - i * 100 }))
    const line = await generateHumanRepertoire({ ...options, maxPlies: 1 }, [], src)
    expect(line.human?.status).not.toBe('ADVANTAGE ACHIEVED')
  })
  it('rejects incomplete engine evidence and supports cancellation', async () => {
    const src = sources(); src.analyze = async () => []
    const line = await generateHumanRepertoire(options, [], src)
    expect(line.recommendation?.verification).toBe('failed')
    const control = new AbortController(); control.abort()
    await expect(generateHumanRepertoire(options, [], sources(), control.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('uses expected outcomes for MAX while excluding objectively unsound candidates', async () => {
    const src = sources(), analyze = src.analyze
    const roots = new Chess(root).moves({ verbose: true }).slice(0, 3).map(m => m.from + m.to)
    src.analyze = async (...args) => {
      const result = await analyze(...args)
      if (args[0] === root && args[1] === 6) return result.map((e, i) => ({ ...e, cp: -i * 20 }))
      const board = new Chess(args[0])
      const second = !!board.get(roots[1].slice(2, 4) as 'a4')
      const third = !!board.get(roots[2].slice(2, 4) as 'b3')
      return result.map(e => ({ ...e, wdl: third ? [1000, 0, 0] : second ? [800, 100, 100] : [100, 100, 800] }))
    }
    const line = await generateHumanRepertoire({ ...options, maxPlies: 1 }, [], src)
    expect(line.moves[0].uci).toBe(roots[1])
    expect(line.human?.decisions[0].coverage).toBeCloseTo(.55)
  })
  it('records filters and database on every human lookup', async () => {
    const src = sources()
    await generateHumanRepertoire({ ...options, database: 'masters' }, [], src)
    for (const call of vi.mocked(src.explorer).mock.calls) {
      expect(call[1]).toEqual(options.filters)
      expect(call[3]).toBe('masters')
    }
  })
  it('repairs the earliest unsound user decision and discards dependent moves', async () => {
    const src = sources(), analyze = src.analyze
    src.analyze = async (...args) => {
      const result = await analyze(...args)
      if (args[5] && args[6]) return result.map(e => ({ ...e, cp: -200 }))
      if (args[5] && args[0] === root && args[1] === 1) return [{ ...result[0], line: [legalSecond()] }]
      return result
    }
    const line = await generateHumanRepertoire(options, [], src)
    expect(line.human?.repair).toContain('earliest unsound')
    expect(line.moves).toHaveLength(1)
    expect(line.moves[0].uci).toBe(legalSecond())
    expect(line.recommendation?.verification).toBe('passed')
  })
})
function legalSecond() { const m = new Chess(root).moves({ verbose: true })[1]; return m.from + m.to }
