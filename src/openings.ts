import { Chess } from 'chess.js'
import { identity } from './core'

export type OpeningRecord = { eco: string; name: string; pgn: string; uci: string; fen: string; kind?: 'study' }
// The catalog has no IDs; ECO and the exact move sequence uniquely identify its bundled entries.
export const openingFavoriteId = (record: OpeningRecord) => `opening:${record.kind || 'catalog'}:${record.eco}:${record.uci}`
export const familyFavoriteId = (family: string) => `family:${family}`
export function readOpeningFavorites(value: string | null): string[] {
  try { const ids: unknown = JSON.parse(value || '[]'); return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && /^(opening|family):/.test(id)))] : [] } catch { return [] }
}
export const toggleOpeningFavorite = (ids: string[], id: string) => ids.includes(id) ? ids.filter(saved => saved !== id) : [id, ...ids]

// ponytail: one teaching setup fills a catalog gap without relabeling Lichess's official records.
export const studyOpenings: OpeningRecord[] = (() => {
  const pgn = '1. d4 d5 2. Nf3 Nf6 3. Bf4 e6 4. e3 c5 5. c3 Nc6 6. Bd3 Be7 7. Nbd2 O-O 8. O-O'
  const game = new Chess(); game.loadPgn(pgn)
  return [{ eco: 'D02', name: 'London System: Standard setup', pgn, uci: game.history({ verbose: true }).map(move => move.from + move.to + (move.promotion || '')).join(' '), fen: game.fen(), kind: 'study' }]
})()

let catalogRequest: Promise<OpeningRecord[]> | undefined
export function loadOpenings() {
  return catalogRequest ||= fetch('/openings.json').then(response => {
    if (!response.ok) throw new Error('Opening catalog unavailable')
    return response.json() as Promise<OpeningRecord[]>
  }).then(records => {
    return [...studyOpenings, ...records]
  }).catch(error => { catalogRequest = undefined; throw error })
}

export const openingFamily = (record: OpeningRecord) => record.name.includes('London System') ? 'London System' : record.name.split(':', 1)[0]
export const openingPath = (record: OpeningRecord) => record.name.includes(':') ? record.name.slice(record.name.indexOf(':') + 1).split(',').map(part => part.trim()) : []

function movesKey(text: string) {
  return text.toLowerCase().replace(/\d+\.(\.\.)?|[!?+#]/g, ' ').replace(/[^a-z0-9= -]/g, ' ').replace(/\s+/g, ' ').trim()
}

const nameWords = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

// ponytail: allow one typo in longer name words; short move and ECO queries stay exact.
function oneTypo(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    const differences = [...a].flatMap((letter, index) => letter === b[index] ? [] : [index])
    return differences.length === 1 || differences.length === 2 && differences[1] === differences[0] + 1 && a[differences[0]] === b[differences[1]] && a[differences[1]] === b[differences[0]]
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a]
  for (let index = 0; index < longer.length; index++) if (longer.slice(0, index) + longer.slice(index + 1) === shorter) return true
  return false
}

const searchKeys = new WeakMap<OpeningRecord, string[]>()
export function searchOpenings(records: OpeningRecord[], query: string, family = '') {
  const needle = query.trim().toLowerCase(), moveNeedle = movesKey(query), words = nameWords(query)
  return records.filter(record => {
    if (family && openingFamily(record) !== family) return false
    if (!needle) return true
    let keys = searchKeys.get(record)
    if (!keys) { keys = [record.name.toLowerCase(), record.eco.toLowerCase(), movesKey(record.pgn), record.uci.toLowerCase(), ` ${nameWords(record.name).join(' ')}`]; searchKeys.set(record, keys) }
    return keys[0].includes(needle) || !!words.length && words.every(word => keys[4].includes(` ${word}`) || word.length >= 5 && keys[4].split(' ').some(nameWord => oneTypo(word, nameWord))) || keys[1].includes(needle) || !!moveNeedle && (keys[2].includes(moveNeedle) || keys[3].includes(moveNeedle))
  })
}

const positionIndexes = new WeakMap<OpeningRecord[], Map<string, OpeningRecord[]>>()
export function openingAt(records: OpeningRecord[], fen: string, preferred?: OpeningRecord | null) {
  let index = positionIndexes.get(records)
  if (!index) {
    index = new Map()
    for (const record of records) {
      const key = record.fen.split(' ').slice(0, 4).join(' ')
      index.set(key, [...(index.get(key) || []), record])
    }
    positionIndexes.set(records, index)
  }
  const key = identity(fen)
  const matches = index.get(key) || []
  return matches.find(record => record.eco === preferred?.eco && record.name === preferred?.name && record.uci === preferred?.uci) || matches.sort((a, b) => a.name.length - b.name.length)[0]
}

export function openingPositions(record: OpeningRecord) {
  const game = new Chess(), positions = [game.fen()]
  for (const uci of record.uci.split(' ').filter(Boolean)) {
    game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    positions.push(game.fen())
  }
  if (identity(game.fen()) !== identity(record.fen)) throw new Error(`Opening sequence does not reach ${record.name}`)
  return positions
}
