import { positions } from './gameAnalysis'
import type { Variation } from './learning'
import { beginMemory, emptyMemoryStats, type MemorySession } from './memorize'
import type { Side } from './core'
export const FAMILY_STORAGE = 'opening-atlas-family-practice-v1'
export const BRANCH_SETTINGS = 'opening-atlas-branch-settings-v1'
export const ACTIVE_PRACTICE = 'opening-atlas-active-practice-v1'
// ponytail: keep the old opponent field so stored branch sessions remain readable; new sessions use uniform.
export type BranchOptions = { order: 'mixed' | 'sequential'; coverage: 'once' | 'continuous'; opponent: 'uniform' | 'human'; start: 'branch' | 'full' }
export function branchOptions(value: unknown): BranchOptions {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<BranchOptions>
  return { order: v.order === 'sequential' ? 'sequential' : 'mixed', coverage: v.coverage === 'continuous' ? 'continuous' : 'once', opponent: v.opponent === 'human' ? 'human' : 'uniform', start: v.start === 'full' ? 'full' : 'branch' }
}
export type BranchSession = { key: string; options: BranchOptions; seed: number; cycle: number; starts: Record<string, number>; weights: Record<string, number>; weighting: string; encountered: string[]; playlist?: string[]; allIds?: string[] }
export const sessionKey = (session: FamilySession) => session.branch?.key || familyKey(session.family, session.side)
export const familyKey = (family: string, side: Side) => JSON.stringify([family, side])
export function branchSessionKey(family: string, side: Side, nodeKey: string, records: Record<string, FamilyRecord>) {
  const legacy = `branch:${nodeKey}`, previous = records[legacy]?.session
  return previous?.side === side && previous.family.startsWith(`${family} — `) ? legacy : `branch:${familyKey(family, side)}:${nodeKey}`
}
export const lineSignature = (line: Variation) => `${line.side}|${line.startFen}|${line.moves.map(move => move.uci).join(' ')}`
export type FamilyAttempt = { id: string; success: boolean; wrong: number; hints: number; at: number }
export type FamilySession = { playlistId?: string; reviewMode?: boolean; stopped?: boolean; branch?: BranchSession; family: string; side: Side; ids: string[]; signatures: Record<string, string>; completed: string[]; remaining: string[]; unavailable: string[]; attempts: FamilyAttempt[]; memory: MemorySession | null; started: number; finished?: number; review?: string }
export type FamilyRecord = { session: FamilySession; sessionsStarted: number; sessionsCompleted: number; linesCompleted: number; totalAttempts: number; incorrectAttempts: number; lastCompleted?: number }
export function eligibleFamily(lines: Variation[], side: Side) {
  const unique = new Map<string, Variation>()
  for (const line of lines) {
    if (line.sideUnconfirmed || line.side !== side || !line.moves.length) continue
    try { if (!positions(line).slice(0, -1).some(fen => fen.split(' ')[1] === side[0])) continue } catch { continue }
    const signature = lineSignature(line)
    if (!unique.has(signature)) unique.set(signature, line)
  }
  return [...unique.values()]
}
export function newFamily(family: string, side: Side, lines: Variation[], previous?: FamilyRecord, random = Math.random, now = Date.now()): FamilyRecord {
  const eligible = eligibleFamily(lines, side), ids = eligible.map(line => line.id)
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]] }
  return { sessionsStarted: (previous?.sessionsStarted || 0) + 1, sessionsCompleted: previous?.sessionsCompleted || 0, linesCompleted: previous?.linesCompleted || 0, totalAttempts: previous?.totalAttempts || 0, incorrectAttempts: previous?.incorrectAttempts || 0, lastCompleted: previous?.lastCompleted, session: { family, side, ids, signatures: Object.fromEntries(eligible.map(line => [line.id, lineSignature(line)])), completed: [], remaining: ids.slice(), unavailable: [], attempts: [], memory: null, started: now } }
}
export function branchOrder(ids: string[], branch: BranchSession, previous?: string) {
  let state = (branch.seed + branch.cycle) >>> 0
  const random = () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  // Exponential keys implement weighted sampling without replacement in O(n log n).
  const result = branch.options.order === 'sequential' ? ids.slice() : ids.map(id => ({ id, key: -Math.log(Math.max(Number.MIN_VALUE, random())) / branch.weights[id] })).sort((a,b) => a.key-b.key).map(v => v.id)
  if (result.length > 1 && result[0] === previous) [result[0],result[1]] = [result[1],result[0]]
  return result
}
export function branchLines(lines: Variation[], side: Side, ply: number, options: BranchOptions) {
  return eligibleFamily(lines, side).filter(line => positions(line).slice(options.start === 'full' ? 0 : ply, -1).some(fen => fen.split(' ')[1] === side[0]))
}
export function newBranch(key: string, label: string, side: Side, lines: Variation[], ply: number, options: BranchOptions, seed: number, previous?: FamilyRecord, now = Date.now(), population?: { filters?: Variation['filters']; targetRating?: number }): FamilyRecord {
  const eligible = branchLines(lines, side, ply, options)
  const record = newFamily(label, side, eligible, previous, () => .999999, now), ids = record.session.ids
  const starts = Object.fromEntries(ids.map(id => [id, options.start === 'full' ? 0 : ply]))
  const profile = (filters: Variation['filters'] | undefined) => filters ? JSON.stringify([[...filters.ratings].sort((a,b)=>a-b),[...filters.speeds].sort()]) : ''
  const logs: number[] = [], profiles = new Set<string>()
  let available = true
  if (options.opponent === 'human') for (const line of eligible) {
    let log = 0
    if (population?.filters && profile(line.filters)!==profile(population.filters)) available=false
    positions(line).slice(starts[line.id], -1).forEach((fen, offset) => {
      if (fen.split(' ')[1] === side[0]) return
      const move = line.moves[starts[line.id]+offset]
      const prediction = move.prediction
      if (move.source==='model' && population?.targetRating!==undefined && prediction?.rating!==population.targetRating) available=false
      const p = move.source === 'model' && prediction?.model && prediction.version && Number.isFinite(prediction.rating) ? prediction.probability
        : move.source === 'lichess' && move.games && line.filters ? move.frequency : undefined
      if (p === undefined || !Number.isFinite(p) || p <= 0 || p > 1) available = false
      else {
        log += Math.log(p)
        profiles.add(move.source === 'model' ? JSON.stringify(['model',prediction!.model,prediction!.version,prediction!.rating,profile(line.filters)]) : JSON.stringify(['lichess',profile(line.filters)]))
      }
    })
    logs.push(log)
  }
  // ponytail: mixed/missing provenance falls back as a whole; fetch fresh branch weights only if needed later.
  const weighted = options.opponent === 'human' && available && profiles.size === 1
  const max = logs.length ? Math.max(...logs) : 0
  const branch: BranchSession = { key, options, seed, cycle: 0, starts, weights: Object.fromEntries(ids.map((id,i) => [id, weighted ? Math.exp(Math.max(-700,logs[i]-max)) : 1])), weighting: options.opponent !== 'human' ? 'Uniform selection.' : weighted ? `Saved opponent probabilities, conditional on this branch. Ratings ${eligible[0]?.filters?.ratings.join(', ') || 'recorded model'}; time controls ${eligible[0]?.filters?.speeds.join(', ') || 'recorded model'}. No new moves are generated.` : 'Uniform fallback: complete, compatible saved human probabilities are unavailable.', encountered: [], allIds: previous?.session.branch?.allIds || ids.slice() }
  if (options.order === 'sequential') branch.weighting += ' Sequential order takes precedence over weighting.'
  const remaining = branchOrder(ids,branch)
  return { ...record, session: { ...record.session, branch: { ...branch, playlist: remaining.slice() }, remaining } }
}
export function startFamilyAttempt(record: FamilyRecord, lines: Map<string, Variation>, now = Date.now()): FamilyRecord {
  const s = record.session
  if (s.memory || s.finished) return record
  const available = (id: string) => { const line = lines.get(id); return !!line && lineSignature(line) === s.signatures[id] }
  let remaining = s.remaining.filter(available)
  let branch = s.branch
  if (!remaining.length && branch?.options.coverage === 'continuous') {
    branch = { ...branch, cycle: branch.cycle + 1 }
    remaining = branchOrder(s.ids.filter(available), branch, s.attempts.at(-1)?.id)
    branch.playlist = remaining.slice()
  }
  const unavailable = [...new Set([...s.unavailable, ...s.ids.filter(id => !available(id))])]
  const line = lines.get(remaining[0])
  return { ...record, totalAttempts: record.totalAttempts + Number(!!line), session: { ...s, branch, remaining, unavailable, review: undefined, memory: line ? beginMemory(emptyMemoryStats(), line.id, branch?.starts[line.id] || 0, line.moves.length, now).session : null } }
}
export function finishFamilyAttempt(record: FamilyRecord, memory: MemorySession, now = Date.now()): FamilyRecord {
  const s = record.session
  if (memory.phase !== 'active' || !s.memory || s.memory.started !== memory.started || s.memory.lineId !== memory.lineId || s.review || memory.index < memory.to) return record
  const success = memory.index === memory.to && !memory.wrong && !memory.reveals
  const completed = success ? [...new Set([...s.completed, memory.lineId])] : s.completed
  const remaining = s.remaining.filter(id => id !== memory.lineId)
  const branch = s.branch ? { ...s.branch, encountered: [...new Set([...s.branch.encountered, memory.lineId])] } : undefined
  const finished = branch ? branch.options.coverage === 'once' && branch.encountered.length === s.ids.length ? now : undefined : new Set([...s.attempts.map(attempt => attempt.id), memory.lineId]).size === s.ids.length ? now : undefined
  return { ...record, sessionsCompleted: record.sessionsCompleted + Number(!!finished && !s.finished), linesCompleted: record.linesCompleted + Number(success), incorrectAttempts: record.incorrectAttempts + Number(!success), lastCompleted: finished || record.lastCompleted, session: { ...s, branch, completed, remaining, finished, memory: { ...memory, phase: 'complete' }, review: memory.lineId, attempts: [...s.attempts, { id: memory.lineId, success, wrong: memory.wrong, hints: memory.reveals, at: now }] } }
}
export function practicePlaylist(record: FamilyRecord, stats: Record<string, { perfect?: number; target?: number }> = {}) {
  const s = record.session, latest = new Map(s.attempts.map(attempt => [attempt.id, attempt]))
  const order = s.branch?.playlist || [...new Set([...s.attempts.map(attempt => attempt.id), ...s.remaining])]
  const ids = [...new Set([...order, ...s.ids])]
  const attempted = new Set(s.attempts.map(attempt => attempt.id)).size
  const passed = s.ids.filter(id => latest.get(id)?.success).length
  const mastered = s.ids.filter(id => (stats[id]?.perfect || 0) >= (stats[id]?.target || 5)).length
  return { ids, attempted, passed, mastered, total: s.ids.length, attemptCount: s.attempts.length, successfulAttempts: s.attempts.filter(attempt => attempt.success).length, status: (id: string) => s.unavailable.includes(id) ? 'Skipped' : s.memory?.lineId === id && s.memory.phase === 'active' ? 'Current' : latest.has(id) ? latest.get(id)!.success ? 'Passed' : 'Needs review' : 'Upcoming' }
}
export function parseFamilies(raw: string | null): Record<string, FamilyRecord> {
  if (!raw) return {}
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid family practice storage')
  for (const record of Object.values(value) as FamilyRecord[]) {
    const s = record?.session
    if (!s || !['white', 'black'].includes(s.side) || typeof s.family !== 'string' || ![s.ids,s.completed,s.remaining,s.unavailable].every(list => Array.isArray(list) && list.every(id => typeof id === 'string')) || !Array.isArray(s.attempts) || !s.signatures || !Number.isFinite(s.started)) throw Error('Invalid family practice session')
    const ids = new Set(s.ids)
    if (![record.sessionsStarted,record.sessionsCompleted,record.linesCompleted,record.totalAttempts,record.incorrectAttempts].every(n => Number.isInteger(n) && n >= 0) || !s.ids.every(id => typeof s.signatures[id] === 'string') || ![...s.completed,...s.remaining,...s.unavailable].every(id => ids.has(id)) || ids.size !== s.ids.length) throw Error('Invalid family progress')
    const m = s.memory
    if (m && (!ids.has(m.lineId) || !Number.isInteger(m.from) || m.from < 0 || !Number.isInteger(m.index) || m.index < m.from || !Number.isInteger(m.to) || m.index > m.to || !Number.isFinite(m.started) || !['active','complete'].includes(m.phase) || ![m.wrong,m.reveals].every(n => Number.isInteger(n) && n >= 0))) throw Error('Invalid recall position')
    const b = s.branch
    if (b && (typeof b.key !== 'string' || !Number.isInteger(b.seed) || !Number.isInteger(b.cycle) || b.cycle < 0 || !b.options || Object.entries(branchOptions(b.options)).some(([key,value]) => b.options[key as keyof BranchOptions] !== value) || !Array.isArray(b.encountered) || !b.encountered.every(id => ids.has(id)) || !b.starts || !b.weights || !s.ids.every(id => Number.isInteger(b.starts[id]) && b.starts[id] >= 0 && Number.isFinite(b.weights[id]) && b.weights[id] > 0))) throw Error('Invalid branch practice session')

  }
  return value
}

// Explicitly retry only a practiced entry; upcoming entries retain their queue order.
export function retryPracticedLine(record: FamilyRecord, id: string, lines: Map<string, Variation>, now = Date.now()): FamilyRecord {
  const s = record.session, line = lines.get(id)
  if (s.memory?.phase === 'active' || !s.attempts.some(attempt => attempt.id === id) || !line || lineSignature(line) !== s.signatures[id]) return record
  const memory = beginMemory(emptyMemoryStats(), id, s.branch?.starts[id] || 0, line.moves.length, now).session
  return { ...record, totalAttempts: record.totalAttempts + 1, session: { ...s, memory, review: undefined, stopped: false } }
}

// Retain prior attempt history when a new session replaces the current family/branch session.
export function rememberSession(records: Record<string, FamilyRecord>, record: FamilyRecord) {
  const key = sessionKey(record.session), previous = records[key]
  return { ...records, ...(previous && previous.session.started !== record.session.started ? { [`${key}@${previous.session.started}`]: previous } : {}), [key]: record }
}
