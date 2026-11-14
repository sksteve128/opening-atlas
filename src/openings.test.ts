import { readFileSync } from 'node:fs'
import { Chess } from 'chess.js'
import { expect, it } from 'vitest'
import { identity } from './core'
import { familyFavoriteId, openingAt, openingFamily, openingFavoriteId, openingPath, openingPositions, readOpeningFavorites, searchOpenings, studyOpenings, toggleOpeningFavorite, type OpeningRecord } from './openings'

const catalog = JSON.parse(readFileSync('public/openings.json', 'utf8')) as OpeningRecord[]

it('ships the complete pinned Lichess catalog with legal representative positions', () => {
  expect(catalog).toHaveLength(3865)
  expect(new Set(catalog.map(record => record.eco)).size).toBe(500)
  for (const record of [catalog[0], catalog[1234], catalog.at(-1)!]) expect(identity(openingPositions(record).at(-1)!)).toBe(identity(record.fen))
})

it('searches names, ECO codes, and move sequences, then recognizes exact positions', () => {
  const italian = searchOpenings(catalog, 'Italian Game').find(record => record.name.includes('Two Knights Defense'))!
  expect(italian.eco).toMatch(/^C/)
  expect(searchOpenings(catalog, italian.eco)).toContainEqual(italian)
  expect(searchOpenings(catalog, 'e4 e5 Nf3 Nc6 Bc4')).toContainEqual(italian)
  expect(openingFamily(italian)).toBe('Italian Game')
  expect(openingPath(italian)[0]).toContain('Two Knights Defense')
  expect(openingAt(catalog, italian.fen, italian)).toEqual(italian)
  expect(openingAt(catalog, new Chess('8/8/8/8/8/8/7k/K7 w - - 0 1').fen())).toBeUndefined()
})

it('finds openings by keywords across omitted words and punctuation', () => {
  const exchange = catalog.find(record => record.name === 'French Defense: Exchange Variation')!
  expect(searchOpenings(catalog, 'french exchange')).toContainEqual(exchange)
  expect(searchOpenings(catalog, 'exchange french')).toContainEqual(exchange)
  expect(searchOpenings(catalog, 'french def exch')).toContainEqual(exchange)
  expect(searchOpenings(catalog, 'french exchange').every(record => record.name.includes('French') && record.name.includes('Exchange'))).toBe(true)
})

it('finds opening names with one misspelled word', () => {
  const sicilian = catalog.find(record => record.name === 'Sicilian Defense')!
  const exchange = catalog.find(record => record.name === 'French Defense: Exchange Variation')!
  expect(searchOpenings(catalog, 'scilian')).toContainEqual(sicilian)
  expect(searchOpenings(catalog, 'french exchagne')).toContainEqual(exchange)
  expect(searchOpenings(catalog, 'french defnese exchange')).toContainEqual(exchange)
  expect(searchOpenings(catalog, 'scilian').every(record => record.name.includes('Sicilian'))).toBe(true)
})

it('groups all London catalog labels and includes the representative standard setup', () => {
  const london = searchOpenings([...studyOpenings, ...catalog], 'London System')
  expect(london.some(record => record.name === "Queen's Pawn Game: London System")).toBe(true)
  expect(london.some(record => record.name.includes('London Defensive System'))).toBe(true)
  expect(london.filter(record => record.name.includes('London System')).every(record => openingFamily(record) === 'London System')).toBe(true)
  const setup = studyOpenings[0]
  expect(identity(openingPositions(setup).at(-1)!)).toBe(identity(setup.fen))
  const board = new Chess(setup.fen)
  expect(['d4', 'e3', 'c3'].map(square => board.get(square as 'd4' | 'e3' | 'c3')?.type)).toEqual(['p', 'p', 'p'])
  expect(['f4', 'd3', 'f3', 'd2'].map(square => board.get(square as 'f4' | 'd3' | 'f3' | 'd2')?.type)).toEqual(['b', 'b', 'n', 'n'])
})

it('keeps favorite positions and families distinct, ordered, and reloadable', () => {
  const london = catalog.find(record => record.name === "Queen's Pawn Game: Accelerated London System")!
  const child = catalog.find(record => record.name === "Queen's Pawn Game: Accelerated London System, Steinitz Countergambit")!
  const similar = catalog.find(record => record.name === 'Indian Defense: Accelerated London System')!
  const ids = [london, child, similar].map(openingFavoriteId)
  expect(new Set(catalog.map(openingFavoriteId)).size).toBe(catalog.length)
  expect(new Set(ids).size).toBe(3)
  const family = familyFavoriteId('London System')
  let favorites: string[] = []
  for (const id of [ids[0], family, ids[1]]) favorites = toggleOpeningFavorite(favorites, id)
  expect(favorites).toEqual([ids[1], family, ids[0]])
  expect(readOpeningFavorites(JSON.stringify(favorites))).toEqual(favorites)
  expect(readOpeningFavorites(JSON.stringify([ids[1], ids[1], family]))).toEqual([ids[1], family])
  expect(toggleOpeningFavorite(favorites, family)).toEqual([ids[1], ids[0]])
  expect(searchOpenings([london, child, similar].filter(record => favorites.includes(openingFavoriteId(record))), 'Steinitz')).toEqual([child])
  expect(readOpeningFavorites('broken JSON')).toEqual([])
})
