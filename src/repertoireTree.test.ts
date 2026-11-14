import { Chess } from 'chess.js'
import { expect, test } from 'vitest'
import { identity } from './core'
import { positions } from './gameAnalysis'
import type { Variation } from './learning'
import type { OpeningRecord } from './openings'
import { repertoireTitle, repertoireBadge, repertoireGroupTitle, branchType, buildRepertoireTree, compressed, descendantEntries, filterRepertoire, preferenceKey, preferMove, readPreferences, repertoireEntries, UNCLASSIFIED } from './repertoireTree'
const start = new Chess().fen()
function saved(pgn: string, id = pgn, side: 'white' | 'black' = 'white', fen = start): Variation {
  const game = new Chess(fen); game.loadPgn(pgn)
  return { id, opening: 'Custom position', name: `Line ${id}`, startFen: fen, moves: game.history({ verbose: true }).map(m => ({ uci: m.from + m.to + (m.promotion || ''), san: m.san, source: 'import' })), pgn, side, database: 'lichess', filters: { ratings: [1600], speeds: ['rapid'] }, created: 1, endPosition: identity(game.fen()), fallback: false, stats: { firstTry: 7, errors: 1, reveals: 2, completions: 3, totalMs: 1000 } }
}
const italian = saved('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5'), french = saved('1. e4 e6')
const catalog: OpeningRecord[] = [italian, french].map((line, i) => ({ name: i ? 'French Defense' : 'Italian Game: Classical Variation', eco: i ? 'C00' : 'C50', pgn: line.pgn, uci: line.moves.map(m => m.uci).join(' '), fen: positions(line).at(-1)! }))
const tree = (lines: Variation[]) => buildRepertoireTree(repertoireEntries(lines, catalog))
test('single path is compressed, duplicate records are endpoints, and shorter endpoints are preserved', () => {
  const long = saved(italian.pgn + ' 4. c3 Nf6'), duplicate = { ...long, id: 'duplicate' }
  const model = tree([italian, long, duplicate]), root = model.roots[0]
  expect(root.count).toBe(2)
  const first = compressed([...root.children.values()][0])
  expect(first).toHaveLength(6)
  const endpoint = first.at(-1)!
  expect(endpoint.ends[0].line).toBe(italian)
  expect(endpoint.children.size).toBe(1)
  expect(branchType([...endpoint.children.values()][0])).toBeUndefined()
  expect(descendantEntries(root)).toHaveLength(3)
  expect(tree([long, duplicate]).roots[0].count).toBe(1)
  expect(compressed([...tree([long]).roots[0].children.values()][0])).toHaveLength(8)
})
test('three-way and nested branches classify White and Black decisions correctly', () => {
  const a = saved(italian.pgn + ' 4. c3 Nf6 5. d4', 'a'), b = saved(italian.pgn + ' 4. c3 Nf6 5. d3', 'b'), c = saved(italian.pgn + ' 4. d3 Nf6', 'c'), d = saved(italian.pgn + ' 4. O-O Nf6', 'd')
  const model = tree([a,b,c,d]), decision = model.paths.get('a')![6]
  expect(decision.children.size).toBe(3)
  expect(decision.children.get('c2c3')!.count).toBe(2)
  expect(branchType(decision.children.get('c2c3')!)).toBe('Repertoire alternative')
  expect(model.paths.get('a')![8].children.size).toBe(2)
  const black = tree([a,b,c].map(line => ({ ...line, side: 'black' })))
  expect(branchType(black.paths.get('a')![7])).toBe('Opponent variation')
})
test('classification, ECO/name/move search, side filters, and custom positions use actual metadata', () => {
  const entries = repertoireEntries([italian, { ...french, side: 'black', imported: true }, saved('1. a3 h6')], catalog)
  expect(entries.map(e => e.family)).toEqual(['Italian Game', 'French Defense', UNCLASSIFIED])
  expect(filterRepertoire(entries, 'C50 Bc4', 'white')).toHaveLength(1)
  expect(filterRepertoire(entries, 'french', 'black')).toHaveLength(1)
  expect(filterRepertoire(entries, '', 'both')).toHaveLength(3)
  const custom = { ...italian, id: 'custom', startFen: '8/8/8/4k3/8/8/4K3/8 w - - 0 1', moves: [], opening: '' }
  expect(repertoireEntries([custom], catalog)[0].family).toBe(UNCLASSIFIED)
  expect(tree([custom]).roots[0].fen).toBe(custom.startFen)
})
test('preferred move is opt-in, legal, persistent, and scoped to playing side and position rights', () => {
  let preferences = preferMove({}, 'white', start, 'e2e4')
  expect(readPreferences(JSON.stringify(preferences))).toEqual(preferences)
  preferences = preferMove(preferences, 'white', start, 'd2d4')
  expect(Object.values(preferences)).toEqual(['d2d4'])
  expect(preferMove(preferences, 'black', start, 'd2d4')).toBe(preferences)
  expect(preferMove(preferences, 'white', start, 'e2e5')).toBe(preferences)
  expect(preferMove(preferences, 'white', start, 'd2d4')).toEqual({})
  expect(preferenceKey('white', start)).not.toBe(preferenceKey('white', start.replace('KQkq', '-')))
  expect(readPreferences('{oops')).toEqual({})
})
test('transpositions retain both full paths, and different castling/en-passant rights stay distinct', () => {
  const a = saved('1. Nf3 Nf6 2. g3 g6', 'a'), b = saved('1. g3 g6 2. Nf3 Nf6', 'b')
  const model = tree([a,b]), endA = model.paths.get('a')!.at(-1)!, endB = model.paths.get('b')!.at(-1)!
  expect(endA.key).not.toBe(endB.key)
  expect(model.transpositions.get('white|' + identity(endA.fen))).toContain(endB)
  const ep = '8/8/8/3pP3/3k4/8/8/4K3 w - d6 0 1'
  const roots = tree([{ ...a, id: 'ep', startFen: ep, moves: [] }, { ...a, id: 'noep', startFen: ep.replace('d6', '-'), moves: [] }]).roots
  expect(identity(roots[0].fen)).not.toBe(identity(roots[1].fen))
})
test('preview lookup preserves exact FEN, full history, side, and original records', () => {
  const line = { ...italian, side: 'black' as const }, before = JSON.stringify(line), model = tree([line]), preview = model.paths.get(line.id)![4]
  expect(preview.fen).toBe(positions(line)[4])
  expect(preview.representative).toBe(line)
  expect(preview.side).toBe('black')
  expect(JSON.stringify(line)).toBe(before)
  expect(preview.representative.stats.firstTry).toBe(7)
})
test('100, 1000 and 10000 records reuse cached histories and keep duplicate paths compact', () => {
  for (const count of [100,1000,10000]) {
    const lines = Array.from({ length: count }, (_, i) => ({ ...italian, id: String(i), opening: catalog[0].name }))
    const at = performance.now(), model = tree(lines), ms = performance.now() - at
    console.log(`Repertoire ${count} saved records: ${Math.round(ms)}ms; ${model.paths.size} records, ${model.roots[0].count} unique path`)
    expect(model.paths.size).toBe(count)
    expect(model.roots[0].count).toBe(1)
    expect(model.roots[0].children.size).toBe(1)
  }
})
test('10000 distinct legal continuations remain separate, with measured cold and warm construction', () => {
  const game = new Chess(), lines: Variation[] = []
  function walk(depth: number, moves: Variation['moves']) {
    if (lines.length >= 10000) return
    if (depth === 4) { lines.push({ ...italian, id: String(lines.length), opening: catalog[0].name, moves, pgn: moves.map(m => m.san).join(' ') }); return }
    for (const legal of game.moves({ verbose: true })) {
      game.move(legal); walk(depth + 1, [...moves, { uci: legal.from + legal.to + (legal.promotion || ''), san: legal.san, source: 'import' }]); game.undo()
      if (lines.length >= 10000) break
    }
  }
  walk(0, [])
  const times = []
  for (const count of [100, 1000, 10000]) {
    const subset = lines.slice(0, count), at = performance.now(), model = tree(subset), cold = performance.now() - at, warmAt = performance.now()
    tree(subset); times.push({ count, coldMs: Math.round(cold), warmMs: Math.round(performance.now() - warmAt) })
    expect(model.roots[0].count).toBe(count)
    expect(model.paths.size).toBe(count)
  }
  console.log(JSON.stringify({ repertoireDistinctPaths: times }))
}, 60000)
test('invalid records remain visible and newly saved branches update without mutating training metadata', () => {
  const original = saved(italian.pgn + ' 4. c3'), extra = saved(italian.pgn + ' 4. d3'), invalid = { ...original, id: 'invalid', moves: [...original.moves, { uci: 'a1a8', san: 'Ra8', source: 'import' as const }] }
  const before = JSON.stringify(original)
  expect(tree([original]).roots[0].count).toBe(1)
  const updated = tree([original, extra, invalid])
  expect(updated.roots[0].count).toBe(2)
  expect(updated.invalid[0].line).toBe(invalid)
  expect(JSON.stringify(original)).toBe(before)
  expect(updated.paths.get(original.id)![0].representative.stats).toBe(original.stats)
  const game = new Chess(); game.move('e4')
  const black = preferMove({}, 'black', game.fen(), 'e7e5')
  expect(black[preferenceKey('black', game.fen())]).toBe('e7e5')
  expect(readPreferences(JSON.stringify(black))).toEqual(black)
})

test('display titles preserve custom names and derive concise names without modifying records', () => {
  const line = { ...french, opening: 'French Defense: Advance Variation', name: 'French Defense: Advance Variation — 3...Bd7 variation' }
  const before = JSON.stringify(line)
  expect(repertoireTitle(line, 'French Defense')).toBe('3...Bd7 Variation')
  expect(repertoireTitle({ ...line, customName: '  My exact title  ' }, 'French Defense')).toBe('  My exact title  ')
  expect(repertoireTitle({ ...line, name: '' }, 'French Defense', '3...Bd7 Line')).toBe('3...Bd7 Line')
  expect(JSON.stringify(line)).toBe(before)
  const model = tree([italian])
  expect(repertoireGroupTitle(compressed([...model.roots[0].children.values()][0]), catalog, 'Italian Game')).toContain('Classical Variation')
})
test('alternative badges require an explicit preferred move and opponent badges require a branch', () => {
  for (const side of ['white', 'black'] as const) {
    const a = saved('1. e4 e5', 'a', side), b = saved('1. d4 d5', 'b', side)
    const model = tree([a, b]), e4 = model.paths.get('a')![1], d4 = model.paths.get('b')![1]
    expect(repertoireBadge(e4, {})).toBe(side === 'white' ? '' : 'Opponent response')
    if (side === 'white') {
      const prefs = preferMove({}, side, start, 'e2e4')
      expect(repertoireBadge(e4, prefs)).toBe('★ Preferred')
      expect(repertoireBadge(d4, prefs)).toBe('Alternative')
    }
    expect(repertoireBadge(model.paths.get('a')![2], {})).toBe('')
  }
})
