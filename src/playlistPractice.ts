import type { Variation } from './learning'
import { lineSignature } from './familyPractice'
export type Practice = { lineId: string; started: number; firstTry: number; errors: number; reveals: number; clean: boolean; message: string; from?: number; endIndex?: number; followGeneration?: boolean; alternative?: string; retryIndex?: number }
export type PausedPractice = { signature: string; index: number; practice: Practice; complete: boolean }
export type PracticeHistory = Record<string, PausedPractice[]>
export const PLAYLIST_PRACTICE_STORAGE = 'opening-atlas-line-practice-history-v1'
export function readPracticeHistory(raw: string | null): PracticeHistory {
  if (!raw) return {}
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid practice history')
  for (const [id, attempts] of Object.entries(value) as [string,PausedPractice[]][]) {
    if (!Array.isArray(attempts) || attempts.some(a => !a || typeof a.signature !== 'string' || !Number.isInteger(a.index) || a.index < 0 || typeof a.complete !== 'boolean' || !a.practice || a.practice.lineId !== id || !Number.isFinite(a.practice.started) || ![a.practice.firstTry,a.practice.errors,a.practice.reveals].every(n => Number.isInteger(n) && n >= 0) || typeof a.practice.clean !== 'boolean' || typeof a.practice.message !== 'string' || (a.practice.from !== undefined && (!Number.isInteger(a.practice.from) || a.practice.from < 0)) || (a.practice.endIndex !== undefined && (!Number.isInteger(a.practice.endIndex) || a.index > a.practice.endIndex)))) throw Error('Invalid practice attempt')
  }
  return value
}
export function rememberPractice(history: PracticeHistory, line: Variation, practice: Practice, index: number): PracticeHistory {
  const attempts = history[line.id] || [], attempt = { signature: lineSignature(line), practice, index, complete: index >= (practice.endIndex ?? line.moves.length) }
  const found = attempts.some(a => a.practice.started === practice.started)
  return { ...history, [line.id]: found ? attempts.map(a => a.practice.started === practice.started ? attempt : a) : [...attempts,attempt] }
}
export function pausedPractice(history: PracticeHistory, line: Variation, from: number) {
  return history[line.id]?.findLast(a => !a.complete && a.signature === lineSignature(line) && (a.practice.from || 0) === from && a.index < (a.practice.endIndex ?? line.moves.length))
}
export function queueNeighbor(ids: string[], id: string, delta: -1 | 1, continuous = false) {
  const index = ids.indexOf(id)
  if (index < 0 || !ids.length) return undefined
  const next = index + delta
  return ids[next] || (delta === 1 && continuous ? ids[0] : undefined)
}

export const PAUSED_RECALL_STORAGE = 'opening-atlas-paused-recall-v1'
export type RecallHistory = Record<string, { signature: string; memory: import('./memorize').MemorySession }>
export function readRecallHistory(raw: string | null): RecallHistory {
  if (!raw) return {}
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid recall history')
  for (const [id, entry] of Object.entries(value) as [string,RecallHistory[string]][]) {
    const m = entry?.memory
    if (typeof entry?.signature !== 'string' || !m || m.lineId !== id || !Number.isFinite(m.started) || ![m.from,m.index,m.to,m.wrong,m.reveals].every(n=>Number.isInteger(n) && n>=0) || m.index<m.from || m.index>m.to || !['active','complete'].includes(m.phase)) throw Error('Invalid recall attempt')
  }
  return value
}
