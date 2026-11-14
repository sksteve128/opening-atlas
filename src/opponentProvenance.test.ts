import { Chess } from 'chess.js'
import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { Variation, LineMove } from './learning'
import { OpponentSource } from './OpponentSource'
import { buildRepertoireTree, repertoireEntries } from './repertoireTree'
import { branchProvenance, opponentProvenance } from './repertoireSummary'

function line(pgn: string, sources: LineMove['source'][], side: Variation['side'] = 'white', startFen?: string): Variation {
  const game = new Chess(startFen)
  game.loadPgn(pgn)
  const moves = game.history({ verbose: true }).map((move, index) => ({ uci: move.from + move.to + (move.promotion || ''), san: move.san, source: sources[index] }))
  return { id: pgn, startFen: startFen || new Chess().fen(), moves, side, opening: 'Test', name: pgn, pgn, database: 'lichess', filters: { ratings: [], speeds: [] }, created: 1, endPosition: game.fen(), fallback: false, stats: { firstTry: 0, errors: 0, reveals: 0, completions: 0, totalMs: 0 } }
}

test('opponent sources use saved move metadata, ignore player moves, and number black moves', () => {
  expect(opponentProvenance(line('1. e4 e5 2. Nf3 Nc6', ['engine', 'lichess', 'engine', 'lichess'])).label).toBe('Opponent: Lichess throughout')
  const maia = line('1. e4 c5 2. Nf3 d6', ['preset', 'preset', 'engine', 'model'])
  expect(opponentProvenance(maia).label).toBe('Opponent: Maia throughout')
  expect(opponentProvenance(maia).details).toContain('Opening context: 1.e4 1...c5')
  const mixed = line('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5', ['engine', 'lichess', 'engine', 'model', 'engine', 'model'])
  expect(opponentProvenance(mixed).label).toBe('Opponent: Lichess → Maia from 2...Nc6')
  expect(opponentProvenance(mixed).category).toBe('maia')
  const back = line('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5', ['engine', 'lichess', 'engine', 'model', 'engine', 'lichess'])
  expect(opponentProvenance(back).label).toBe('Opponent: Lichess → Maia → Lichess')
  expect(opponentProvenance(back).transitions).toBe(2)
})

test('fallback reasons come only from the recorded ply and remain distinct', () => {
  const base = line('1. e4 c5 2. Nf3 d6', ['preset', 'preset', 'engine', 'model'])
  const rate = { ...base, recommendation: { verification: 'pending' as const, populationAttempts: [{ ply: 3, database: 'lichess' as const, ratings: [], speeds: [], tier: 'selected' as const, issue: 'rate-limit' as const, error: 'HTTP 429' }] } }
  expect(opponentProvenance(rate).reason).toBe('Explorer rate limited')
  expect(opponentProvenance(base).reason).toBeUndefined()
  const sparse = { ...base, recommendation: { verification: 'pending' as const, populationAttempts: [{ ply: 3, database: 'lichess' as const, ratings: [], speeds: [], tier: 'selected' as const, issue: 'insufficient' as const, games: 10 }] } }
  expect(opponentProvenance(sparse).reason).toBe('human game coverage below configured threshold')
})

test('custom starts, imported/manual moves, and white opponent numbering stay honest', () => {
  const game = new Chess(); game.move('e4'); const start = game.fen()
  const continuation = line('1. e4 c5 2. Nf3', ['preset', 'model', 'engine'])
  expect(opponentProvenance({ ...continuation, startFen: start, moves: continuation.moves.slice(1) }).firstMaia).toBe('1...c5')
  expect(opponentProvenance(line('1. e4 e5 2. Nf3', ['model', 'engine', 'model'], 'black')).firstMaia).toBe('1.e4')
  expect(opponentProvenance(line('1. e4 e5', ['import', 'import'])).label).toBe('Opponent source unavailable')
  expect(opponentProvenance(line('1. e4 e5', ['preset', 'preset'])).category).toBe('unknown')
})

test('branch counts unique records and shared summaries remain stable for large repertoires', () => {
  const observed = line('1. e4 e5', ['engine', 'lichess'])
  const maia = { ...line('1. e4 c5', ['engine', 'model']), id: 'maia' }
  const unknown = { ...line('1. e4 e6', ['import', 'import']), id: 'unknown' }
  const entries = repertoireEntries([observed, { ...observed }, maia, unknown], [])
  const root = buildRepertoireTree(entries).roots[0]
  expect(branchProvenance(root)).toBe('1 Lichess-based · 1 Maia-based · 1 unknown')
  const many = Array.from({ length: 1000 }, (_, i) => ({ ...observed, id: String(i) }))
  const at = performance.now()
  expect(branchProvenance(buildRepertoireTree(repertoireEntries(many, [])).roots[0])).toBe('1000 Lichess-based · 0 Maia-based')
  expect(performance.now() - at).toBeLessThan(5000)
})

test('shared source component and pure summary report the same evidence', () => {
  const saved = line('1. e4 c5 2. Nf3 d6', ['preset', 'preset', 'engine', 'model'])
  const markup = renderToStaticMarkup(createElement(OpponentSource, { line: saved }))
  expect(markup).toContain(opponentProvenance(saved).label)
  expect(markup).toContain('2...d6 — Maia')
})
