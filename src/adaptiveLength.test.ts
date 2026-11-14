import { Chess } from 'chess.js'
import { expect, it, vi } from 'vitest'
import { instructionalEndpoint, material, materialPoint, middlegameEvidence, type ConversionEvidence } from './conversion'
import { generateSimpleRepertoire } from './simpleGeneration'
import type { Generation, Sources } from './learning'

const caro = 'e4 c6 d4 a6 Nd2 d5 e5 Bf5 g4 Bg6 Ne2 e6 Nf4 c5 h4 cxd4 h5 Be4 f3 Qg5 Nb3 Qxe5 fxe4 Nc6 Bg2 dxe4 O-O g5 Bxe4 Qxe4 Re1 Qxe1+ Qxe1 gxf4 Bxf4 Nh6 Bxh6 Bxh6 Qe4 Rd8'.split(' ')
const root = new Chess().fen()
const base: Generation = { opening: 'Caro-Kann', startFen: root, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [1800], speeds: ['rapid'] }, maxPlies: 40, maxMs: 20000, engineDepth: 18, tolerance: 35, mode: 'here', seed: 42 }

it('stops at a quiet, stable equal middlegame but extends tactical, sacrificed, exposed-king, or mating positions', () => {
  const game = new Chess()
  for (const san of 'e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6 d3 O-O Nc3 d6 h3 a6'.split(' ')) game.move(san)
  const fen = game.fen().replace(/ \d+$/, ' 21')
  const evidence: ConversionEvidence = { state: 'none', material: [materialPoint(fen, root, 'white', 40)], points: [0, 0, 10].map((cp, i) => ({ ply: 34 + i * 2, cp, depth: 18 })) }
  expect(instructionalEndpoint(fen, ['Nc3', 'd6', 'h3', 'a6'], evidence)).toBe(true)
  expect(instructionalEndpoint(fen, ['Nc3', 'd6', 'Bxh6', 'Bxh6'], evidence)).toBe(false)
  expect(instructionalEndpoint(fen, ['Nc3', 'd6', 'Qa4+', 'a6'], evidence)).toBe(false)
  expect(instructionalEndpoint(fen, ['Nc3', 'd6', 'h3', 'a6'], { ...evidence, material: [{ ...evidence.material[0], gain: -3 }] })).toBe(false)
  expect(instructionalEndpoint(fen, ['Nc3', 'd6', 'h3', 'a6'], { ...evidence, points: [{ cp: 0, depth: 18, ply: 34 }, { cp: 180, depth: 18, ply: 36 }, { cp: 10, depth: 18, ply: 38 }] })).toBe(false)
  expect(instructionalEndpoint(fen, ['Nc3', 'd6', 'h3', 'a6'], { ...evidence, points: [{ cp: 0, depth: 18, ply: 34 }, { cp: 0, depth: 18, ply: 36 }, { cp: 10000, mate: 3, depth: 18, ply: 38 }] })).toBe(false)
})

it('replays the Caro-Kann past move 20 without increasing the generation clock', async () => {
  const game = new Chess(), planned = new Map<string, string>()
  for (const san of caro) { const fen = game.fen(), move = game.move(san); planned.set(fen, move.from + move.to + (move.promotion || '')) }
  const checkpoint = game.fen()
  expect(instructionalEndpoint(checkpoint, caro, { state: 'none', material: [materialPoint(checkpoint, root, 'white', 40)], points: [89, 89, 89].map((cp, i) => ({ cp, depth: 18, ply: 34 + i * 2 })) })).toBe(false)
  const sources: Sources = {
    analyze: vi.fn(async (fen, _count, depth) => [{ cp: 89, depth, line: [planned.get(fen) || (() => { const move = new Chess(fen).moves({ verbose: true })[0]; return move.from + move.to + (move.promotion || '') })()] }]),
    explorer: vi.fn(async fen => { const move = planned.get(fen) || (() => { const first = new Chess(fen).moves({ verbose: true })[0]; return first.from + first.to + (first.promotion || '') })(); return { source: 'lichess' as const, white: 100, draws: 0, black: 0, moves: [{ uci: move, san: '', white: 100, draws: 0, black: 0 }] } }),
  }
  const old = await generateSimpleRepertoire(base, [], sources)
  const extended = await generateSimpleRepertoire({ ...base, initialPlies: 40, maxPlies: 42 }, [], sources)
  expect(old.moves).toHaveLength(40)
  expect(extended.moves.slice(0, 40).map(move => move.san)).toEqual(caro)
  expect(material(checkpoint)).toMatchObject({ white: 22, black: 22 })
  expect(middlegameEvidence(checkpoint).suitable).toBe(false)
  expect(new Chess(checkpoint).fen()).toBe(checkpoint)
  expect(extended.moves.length).toBeGreaterThan(40)
  expect(extended.recommendation?.adaptiveLength).toMatchObject({ initialPlies: 40, maximumPlies: 42, extendedPlies: 2 })
  expect(extended.termination).toBe('Unresolved — maximum move limit')
  expect(extended.recommendation?.conversion?.outcome).toBe('Unresolved')
  expect(extended.recommendation?.performance?.searches).toBeGreaterThan(old.recommendation!.performance!.searches)
  expect(extended.recommendation?.runtimeMs).toBeLessThan(20000)
})
