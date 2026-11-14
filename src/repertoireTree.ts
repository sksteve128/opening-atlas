import { Chess } from 'chess.js'
import { identity, type Side } from './core'
import { positions } from './gameAnalysis'
import { openingAt, openingFamily, type OpeningRecord } from './openings'
import type { Variation } from './learning'

export const UNCLASSIFIED = 'Other / Unclassified'
export const PREFERENCES_KEY = 'opening-atlas-repertoire-preferences-v1'
export type Preferences = Record<string, string>
export const preferenceKey = (side: Side, fen: string) => `${side}|${identity(fen)}`
export function readPreferences(raw: string | null): Preferences {
  try { const value = JSON.parse(raw || '{}'); return value && !Array.isArray(value) && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key, move]) => /^(white|black)\|/.test(key) && typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) as Preferences : {} } catch { return {} }
}
export function preferMove(saved: Preferences, side: Side, fen: string, uci: string): Preferences {
  const game = new Chess(fen)
  if (game.turn() !== side[0] || !game.moves({ verbose: true }).some(m => m.from + m.to + (m.promotion || '') === uci)) return saved
  const key = preferenceKey(side, fen), next = { ...saved }
  if (next[key] === uci) delete next[key]; else next[key] = uci
  return next
}
export type RepertoireEntry = { line: Variation; family: string; eco?: string; search: string }
const catalogIndexes = new WeakMap<OpeningRecord[], Map<string, OpeningRecord>>()
const entries = new WeakMap<Variation, { catalog: OpeningRecord[]; entry: RepertoireEntry }>()
export function repertoireEntries(lines: Variation[], catalog: OpeningRecord[]): RepertoireEntry[] {
  let byName = catalogIndexes.get(catalog)
  if (!byName) { byName = new Map(catalog.map(record => [record.name, record])); catalogIndexes.set(catalog, byName) }
  return lines.map(line => {
    const cached = entries.get(line)
    if (cached?.catalog === catalog) return cached.entry
    let known = byName.get(line.opening)
    if (!known) {
      try { const fens = positions(line); for (let i = fens.length - 1; i >= 0 && !known; i--) known = openingAt(catalog, fens[i]) } catch { /* Keep invalid legacy records visible, without inventing a position. */ }
    }
    const family = known ? openingFamily(known) : UNCLASSIFIED
    const entry = { line, family, eco: known?.eco, search: `${family} ${line.opening} ${line.name} ${line.customName || ''} ${known?.eco || ''} ${line.pgn} ${line.moves.map(m => m.san).join(' ')}`.toLowerCase() }
    entries.set(line, { catalog, entry }); return entry
  })
}
export function filterRepertoire(entries: RepertoireEntry[], query: string, side: Side | 'both') {
  const needles = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return entries.filter(entry => (side === 'both' || !entry.line.sideUnconfirmed && entry.line.side === side) && needles.every(word => entry.search.includes(word)))
}
export type RepertoireNode = { key: string; fen: string; ply: number; side: Side; unconfirmed: boolean; move?: string; san?: string; parent?: RepertoireNode; children: Map<string, RepertoireNode>; ends: RepertoireEntry[]; count: number; representative: Variation }
export function buildRepertoireTree(entries: RepertoireEntry[]) {
  const roots = new Map<string, RepertoireNode>(), paths = new Map<string, RepertoireNode[]>(), transpositions = new Map<string, RepertoireNode[]>(), invalid: RepertoireEntry[] = []
  for (const entry of entries) {
    const line = entry.line
    let fens: string[]
    try { fens = positions(line) } catch { invalid.push(entry); continue }
    const rootKey = `${line.sideUnconfirmed ? 'unknown' : line.side}|${line.startFen}`
    let node = roots.get(rootKey)
    if (!node) { node = { key: rootKey, fen: fens[0], ply: 0, side: line.side, unconfirmed: !!line.sideUnconfirmed, children: new Map(), ends: [], count: 0, representative: line }; roots.set(rootKey, node) }
    const path = [node]
    line.moves.forEach((move, i) => {
      let child = node!.children.get(move.uci)
      if (!child) {
        child = { key: `${node!.key}/${move.uci}`, fen: fens[i + 1], ply: i + 1, side: line.side, unconfirmed: !!line.sideUnconfirmed, move: move.uci, san: move.san, parent: node, children: new Map(), ends: [], count: 0, representative: line }
        node!.children.set(move.uci, child)
      }
      path.push(child); node = child
    })
    node!.ends.push(entry); paths.set(line.id, path)
  }
  const visit = (node: RepertoireNode): number => {
    node.count = Number(node.ends.length > 0) + [...node.children.values()].reduce((sum, child) => sum + visit(child), 0)
    const key = `${node.unconfirmed ? 'unknown' : node.side}|${identity(node.fen)}`
    const matches = transpositions.get(key) || []; matches.push(node); transpositions.set(key, matches)
    return node.count
  }
  roots.forEach(visit)
  return { roots: [...roots.values()], paths, transpositions, invalid }
}
export function compressed(node: RepertoireNode) {
  const chain = [node]
  while (!node.ends.length && node.children.size === 1) { node = [...node.children.values()][0]; chain.push(node) }
  return chain
}
export function branchType(node: RepertoireNode) {
  return node.unconfirmed || !node.parent || node.parent.children.size < 2 ? undefined : node.parent.fen.split(' ')[1] === node.side[0] ? 'Repertoire alternative' : 'Opponent variation'
}
export function descendantEntries(node: RepertoireNode): RepertoireEntry[] {
  const result = [...node.ends]
  for (const child of node.children.values()) result.push(...descendantEntries(child))
  return result
}
export function sequenceLabel(nodes: RepertoireNode[]) {
  return nodes.filter(n => n.parent).map((node, index) => { const fields = node.parent!.fen.split(' '); return `${fields[1] === 'w' ? fields[5] + '.' : index === 0 ? fields[5] + '...' : ''}${node.san}` }).join(' ')
}

/** Display only: never rewrite a saved or user-edited title. */
export function repertoireTitle(line: Variation, family: string, fallback = 'Saved line') {
  if (line.customName) return line.customName
  let title = line.name?.trim() || ''
  if (line.opening && title.startsWith(line.opening + ' — ')) title = title.slice(line.opening.length + 3)
  else if (family !== UNCLASSIFIED && title.startsWith(family + ': ')) title = title.slice(family.length + 2)
  return title ? title.replace(/\bvariation$/, 'Variation') : fallback
}
export function repertoireBadge(node: RepertoireNode, preferences: Preferences) {
  if (node.unconfirmed || !node.parent) return ''
  if (node.parent.fen.split(' ')[1] !== node.side[0]) return node.parent.children.size > 1 ? 'Opponent response' : ''
  const preferred = preferences[preferenceKey(node.side, node.parent.fen)]
  return preferred === node.move ? '★ Preferred' : preferred && node.parent.children.size > 1 ? 'Alternative' : ''
}
export function repertoireGroupTitle(chain: RepertoireNode[], catalog: OpeningRecord[], family: string) {
  const known = chain.map(node => openingAt(catalog, node.fen)).filter(record => record && record.name !== family).at(-1)
  const name = known?.name.startsWith(family + ': ') ? known.name.slice(family.length + 2) : known?.name
  return `${sequenceLabel(chain)}${name ? ` · ${name}` : ''}`
}
