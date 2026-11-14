import { buildRepertoireTree, type RepertoireNode } from './repertoireTree'
import type { Variation } from './learning'
import { sessionKey, type FamilyRecord, type BranchOptions } from './familyPractice'
import type { MemorySession } from './memorize'

export const PLAYLIST_STORAGE = 'opening-atlas-playlists-v1'
export type CollectionType = 'ALL_SAVED_LINES' | 'TEMPORARY_BRANCH' | 'TEMPORARY_FAMILY' | 'SAVED_CUSTOM' | 'REVIEW'
export type Collection = { id: string; type: Exclude<CollectionType, 'ALL_SAVED_LINES'>; name: string; ids: string[]; selected: string; accessed: number; family: string; side: 'white' | 'black'; sessionKey: string; sessionStarted: number; branch?: { key: string; ply: number; fen?: string; options: BranchOptions } }
export type PlaylistStore = { active: string | null; recent: Collection[]; saved: Collection[]; review?: Collection }
export const emptyPlaylists = (): PlaylistStore => ({ active: null, recent: [], saved: [] })
export function parsePlaylists(raw: string | null): PlaylistStore {
  try {
    const value = JSON.parse(raw || 'null')
    const valid = (p: Collection) => p && typeof p.id === 'string' && typeof p.name === 'string' && ['TEMPORARY_BRANCH','TEMPORARY_FAMILY','SAVED_CUSTOM','REVIEW'].includes(p.type) && Array.isArray(p.ids) && p.ids.every(id => typeof id === 'string') && typeof p.selected === 'string' && Number.isFinite(p.accessed) && typeof p.family === 'string' && ['white','black'].includes(p.side) && typeof p.sessionKey === 'string' && Number.isFinite(p.sessionStarted) && (!p.branch || typeof p.branch.key === 'string' && Number.isInteger(p.branch.ply) && p.branch.ply >= 0 && (p.branch.fen === undefined || typeof p.branch.fen === 'string') && p.branch.options && ['mixed','sequential'].includes(p.branch.options.order) && ['once','continuous'].includes(p.branch.options.coverage) && ['uniform','human'].includes(p.branch.options.opponent) && ['branch','full'].includes(p.branch.options.start))
    if (!value || !Array.isArray(value.recent) || !Array.isArray(value.saved)) return emptyPlaylists()
    const recent = value.recent.filter(valid).filter((p: Collection) => p.type === 'TEMPORARY_BRANCH' || p.type === 'TEMPORARY_FAMILY').slice(0,3), saved = value.saved.filter(valid).filter((p: Collection) => p.type === 'SAVED_CUSTOM')
    const review = valid(value.review) && value.review.type === 'REVIEW' ? value.review as Collection : undefined
    return { recent, saved, ...(review ? {review} : {}), active: [...recent,...saved,...(review ? [review] : [])].some(p => p.id === value.active) ? value.active : null }
  } catch { return emptyPlaylists() }
}
export function fromSession(record: FamilyRecord, now = Date.now()): Collection {
  const s = record.session, key = sessionKey(s), ids = s.branch?.playlist || s.ids
  return { id: `session:${key}:${s.started}`, type: s.reviewMode ? 'REVIEW' : s.branch ? 'TEMPORARY_BRANCH' : 'TEMPORARY_FAMILY', name: `${s.family} — ${s.reviewMode ? 'Review' : s.branch ? 'Branch Playlist' : 'Family Playlist'}`, family: s.family, side: s.side, ids: [...ids], selected: s.memory?.lineId || ids[0] || '', accessed: now, sessionKey: key, sessionStarted: s.started, ...(s.branch ? { branch: { key: s.branch.key, ply: s.branch.starts[ids[0]] || 0, options: { ...s.branch.options } } } : {}) }
}
export function rememberPlaylist(store: PlaylistStore, playlist: Collection): PlaylistStore {
  if (playlist.type === 'REVIEW') return { ...store, active: playlist.id, review: playlist }
  const review = store.review?.id === playlist.id ? undefined : store.review
  const saved = store.saved.filter(p => p.id !== playlist.id), recent = store.recent.filter(p => p.id !== playlist.id)
  return playlist.type === 'SAVED_CUSTOM' ? { active: playlist.id, recent, saved: [playlist,...saved], ...(review ? {review} : {}) } : { active: playlist.id, saved, recent: [playlist,...recent].slice(0,3), ...(review ? {review} : {}) }
}
export function playlistEntries(playlist: Collection, lines: Variation[]) {
  const byId = new Map(lines.map(line => [line.id,line]))
  return playlist.ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
}
export function matchingSession(playlist: Collection, records: Record<string, FamilyRecord>) {
  const current = records[playlist.sessionKey]
  const record = current?.session.started === playlist.sessionStarted ? current : records[`${playlist.sessionKey}@${playlist.sessionStarted}`]
  return record?.session.started === playlist.sessionStarted ? record : null
}
export function resumableSession(record: FamilyRecord | null) {
  return !!record && !record.session.finished && !record.session.stopped && !!record.session.memory
}
export function playlistLabel(line: Variation) {
  return line.customName || line.name || `${line.opening || 'Saved variation'} — ${line.moves.slice(0,6).map(move => move.san).join(' ') || 'Starting position'}`
}
export function recallConcealed(memory: MemorySession | null, revealedFor: number | null) { return memory?.phase === 'active' && revealedFor !== memory.started }

export function playlistLabels(lines: Variation[]) {
  return lines.map(line => {
    const title = playlistLabel(line), peers = lines.filter(other => playlistLabel(other) === title)
    if (peers.length < 2) return title
    const differing = line.moves.findIndex((move,i) => peers.some(other => other.moves[i]?.uci !== move.uci))
    if (differing >= 0) {
      const fen = line.startFen.split(' '), first = Number(fen[5]) || 1, offset = fen[1] === 'b' ? 1 : 0
      const number = first + Math.floor((differing + offset) / 2), dots = (differing + offset) % 2 ? '...' : '.'
      return `${title} · ${number}${dots}${line.moves.slice(differing,differing+3).map(move=>move.san).join(' ')}`
    }
    return `${title} · ${line.moves.length} plies · ${line.id.slice(0,8)}`
  })
}

/** Follow the selected history, never merge nodes merely because their FENs transpose. */
export function playlistFromPosition(lines: Variation[], position: { startFen: string; moves: string[]; side: 'white' | 'black'; name: string }, now = Date.now()): Collection | null {
  const tree = buildRepertoireTree(lines.map(line => ({ line, family: line.opening, search: '' })))
  let node = tree.roots.find(root => root.key === `${position.side}|${position.startFen}`)
  for (const move of position.moves) node = node?.children.get(move)
  if (!node?.children.size) return null
  const ids: string[] = []
  const visit = (child: RepertoireNode) => {
    // One terminal node per distinct complete path; duplicate saved records share that node.
    if (!child.children.size && child.ends.length) ids.push(child.ends[0].line.id)
    else child.children.forEach(visit)
  }
  node.children.forEach(visit)
  if (!ids.length) return null
  const key = `position:${node.key}`
  return { id: key, type: 'TEMPORARY_BRANCH', name: `${position.name || 'Position'} — Playlist`, ids, selected: ids[0], accessed: now, family: position.name || 'Position', side: node.side, sessionKey: key, sessionStarted: now, branch: { key: node.key, ply: node.ply, fen: node.fen, options: { start: 'branch', order: 'sequential', coverage: 'once', opponent: 'uniform' } } }
}
