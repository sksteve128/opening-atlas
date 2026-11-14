import { Chess } from 'chess.js'
import { expect, it } from 'vitest'
import { branchVariation, branchLabel, divergenceLabel, buildOpeningTree, migrateVariations, restoreKnownHistory } from './openingTree'
import { lineFen, saveVariation, type Variation } from './learning'
import { identity } from './core'
import { positions, validPoint, measuredPoint } from './gameAnalysis'
import { beginMemory, emptyMemoryStats } from './memorize'
const start = new Chess().fen()
function line(sans: string[], id = 'parent', fen = start): Variation {
  const game = new Chess(fen)
  const moves = sans.map(san => { const m = game.move(san); return { uci: m.from + m.to + (m.promotion || ''), san: m.san, source: 'engine' as const } })
  return { id, startFen: fen, moves, opening: 'Accelerated London', name: 'London', side: 'black', filters: { ratings: [1600], speeds: ['rapid'] }, database: 'lichess', pgn: game.pgn(), created: 1, endPosition: identity(game.fen()), fallback: false, stats: { firstTry: 2, errors: 3, reveals: 1, completions: 4, totalMs: 1234 } }
}
it('keeps full history and distinguishes generation point from actual divergence', () => {
  const parent = line(['d4','d5','Bf4','e6','e3','c5','c3','Nc6','Nf3','Nf6'])
  const child = line(['d4','d5','Bf4','e6','e3','c5','c3','Nf6'], 'child')
  const result = branchVariation(child, { startFen: start, prefix: parent.moves.slice(0, 4), opening: parent.opening, parentId: parent.id }, parent)
  expect(result.moves).toEqual(child.moves)
  expect(result.branch?.ply).toBe(4)
  expect(result.branch?.divergencePly).toBe(7)
  expect(result.branch?.kind).toBe('alternative repertoire move')
  expect(branchLabel(result)).toBe('Generated from move 3')
  expect(divergenceLabel(result)).toBe('First deviation: 4...Nf6')
  expect(result.name).toBe('Accelerated London — 4...Nf6 variation')
  expect(lineFen(result, 0)).toBe(start)
  expect(beginMemory(emptyMemoryStats(), result.id, 0, result.moves.length, 1, result.moves.length).session.index).toBe(0)
})
it.each([0, 8, 28])('preserves generation history at ply %i including late positions', ply => {
  const base = line(Array.from({ length: 8 }, () => ['Nf3','Nf6','Ng1','Ng8']).flat())
  const result = branchVariation(base, { startFen: start, prefix: base.moves.slice(0, ply), opening: base.opening })
  expect(result.branch?.fen).toBe(lineFen(base, ply))
  expect(result.moves.slice(0, ply)).toEqual(base.moves.slice(0, ply))
  expect(result.moves.slice(result.branch!.ply)).toHaveLength(32 - ply)
})
it('links transpositions without merging distinct move orders', () => {
  const a = line(['Nf3','Nf6','g3','g6'], 'a'), b = line(['g3','g6','Nf3','Nf6'], 'b')
  const node = buildOpeningTree([a,b]).get(identity(lineFen(a)))!
  expect(node.visits.map(v => v.lineId)).toEqual(['a','b'])
  expect(a.moves[0].uci).not.toBe(b.moves[0].uci)
  expect(saveVariation([a], b)).toHaveLength(2)
  expect(saveVariation([a], {...a,id:'duplicate'})).toHaveLength(1)
})
it('restores known manual history only when it matches the displayed FEN', () => {
  const a = line(['d4','d5','Bf4'])
  const h = { startFen: start, moves: a.moves.map(m => m.uci), index: 3, opening: a.opening }
  expect(restoreKnownHistory(JSON.parse(JSON.stringify(h)), lineFen(a))).toEqual(h)
  expect(restoreKnownHistory(h, start)).toBeUndefined()
  expect(restoreKnownHistory({...h,moves:['e2e9']})).toBeUndefined()
  expect(restoreKnownHistory(undefined, lineFen(a))).toBeUndefined()
})
it('rejects a generator suffix that loses its prefix', () => {
  const a = line(['d4','d5','Bf4'])
  expect(() => branchVariation(a, { startFen: start, prefix: line(['e4']).moves, opening:'London' })).toThrow('inherited history')
})
it('migrates an explicit unique parent path without resetting stats or inventing analysis', () => {
  const parent = line(['d4','d5','Bf4','e6'])
  const child = {...line(['e3','c5'], 'child',lineFen(parent)), opening:'Custom position', parentId:parent.id}
  child.analysis = {version:1,points:[measuredPoint(child.startFen,0,[], 'fast')]}
  const migrated = migrateVariations([parent,child])[1]
  expect(migrated.startFen).toBe(start)
  expect(migrated.moves.map(m=>m.san)).toEqual(['d4','d5','Bf4','e6','e3','c5'])
  expect(migrated.stats).toBe(child.stats)
  expect(migrated.id).toBe(child.id)
  expect(migrated.opening).toBe(parent.opening)
  expect(migrated.analysis!.points.slice(0,4)).toEqual([null,null,null,null])
  expect(validPoint(migrated.analysis!.points[4], positions(migrated)[4],4)).toBeDefined()
  expect(migrateVariations([parent,migrated])[1]).toBe(migrated)
  expect(child.moves).toHaveLength(2)
})
it('leaves unknown or ambiguous histories unchanged', () => {
  const parent = line(['Nf3','Nf6','Ng1','Ng8'])
  const custom = line(['e4'], 'custom', start)
  expect(migrateVariations([custom])[0]).toBe(custom)
  const linked = {...custom,parentId:parent.id}
  expect(migrateVariations([parent,linked])[1].branch).toBeUndefined()
})
it('numbers Black-to-move custom roots correctly without inventing earlier moves', () => {
  const fen = lineFen(line(['d4','d5','Bf4']))
  const custom = line(['e6','e3'],'custom',fen)
  const result = branchVariation(custom,{startFen:fen,prefix:[],opening:'Custom position'})
  expect(result.name).toBe('Custom position — 2...e6 variation')
  expect(result.moves).toHaveLength(2)
  expect(result.branch?.ply).toBe(0)
})
it('classifies opponent deviations separately', () => {
  const parent = line(['d4','d5','Bf4','e6','e3'])
  const child = line(['d4','d5','Bf4','e6','Nf3'],'child')
  expect(branchVariation(child,{startFen:start,prefix:parent.moves.slice(0,3),opening:parent.opening,parentId:parent.id},parent).branch?.kind).toBe('opponent variation')
})
it('restores a multigeneration parent chain regardless of storage order', () => {
  const root = line(['d4','d5'],'root')
  const middle = {...line(['Bf4','e6'],'middle',lineFen(root)),parentId:root.id}
  const last = {...line(['e3','c5'],'last',lineFen(middle)),parentId:middle.id}
  expect(migrateVariations([last,middle,root])[0].moves.map(m=>m.san)).toEqual(['d4','d5','Bf4','e6','e3','c5'])
})
it('saves generation from an explored alternative as a separate child with the entire explored prefix',()=>{
 const parent=line(['e4','e5','Nf3','Nc6','Bb5','a6'])
 const explored=line(['e4','e5','Nf3','Nc6','Bc4'])
 const generated=line(['e4','e5','Nf3','Nc6','Bc4','Bc5','d3'],'new-line')
 const before=JSON.stringify(parent)
 const child=branchVariation(generated,{startFen:explored.startFen,prefix:explored.moves,opening:parent.opening,parentId:parent.id},parent)
 const saved=saveVariation([parent],child)
 expect(saved).toHaveLength(2)
 expect(child.id).not.toBe(parent.id)
 expect(child.moves.slice(0,5)).toEqual(explored.moves)
 expect(child.branch).toMatchObject({ply:5,divergencePly:4,fen:lineFen(explored)})
 expect(child.parentId).toBe(parent.id)
 expect(JSON.stringify(parent)).toBe(before)
})
