import type { Generation, Variation } from './learning'
import { lichessToken } from './lichessAuth'
import { syncExplorerCache } from './data'

const KEY = 'opening-atlas-batch-job-v1'
export type BatchHandle = { id: string; options: Generation; count: 3 | 5 | 10; workers: 1 | 2 | 4 | 6; seed: number }
export type GenerationEvent = { type: string; batchId: string; jobId: string; sequence: number; timestamp: number; ply: number; fen: string; move?: { uci: string; san: string; source: string }; stage: string; status: string }
export type BatchJob = { id: string; status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'; phase: string; attempts: number; sequence: number; events: GenerationEvent[]; ply: number; fen?: string; line?: Variation; lineId?: string; error?: string }
export type BatchStatus = { id: string; opening: string; side: 'white' | 'black'; status: 'running' | 'stopping' | 'complete' | 'failed' | 'cancelled'; startedAt: number; revision: number; total: number; completed: number; running: number; failed: number; cancelled: number; workers: number; jobs: BatchJob[] }
export type RecentBatch = Pick<BatchStatus, 'id' | 'opening' | 'side' | 'startedAt' | 'status' | 'total' | 'completed' | 'failed' | 'cancelled'> & { jobs: Pick<BatchJob, 'id' | 'status' | 'lineId' | 'error'>[] }
const HISTORY_KEY = 'opening-atlas-batch-history-v1'
export function recentBatches(): RecentBatch[] { try { const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(value) ? value.slice(0, 20) : [] } catch { return [] } }
export function rememberBatch(status: BatchStatus) {
  const record: RecentBatch = { id: status.id, opening: status.opening, side: status.side, startedAt: status.startedAt, status: status.status, total: status.total, completed: status.completed, failed: status.failed, cancelled: status.cancelled, jobs: status.jobs.map(job => ({ id: job.id, status: job.status, lineId: job.line?.id || job.lineId, error: job.error })) }
  const history = [record, ...recentBatches().filter(item => item.id !== record.id)].slice(0, 20)
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)) } catch { /* Current queue still works without storage. */ }
  return history
}
export function newerBatch(previous: BatchStatus | null, incoming: BatchStatus) { return previous?.id === incoming.id && previous.revision > incoming.revision ? previous : incoming }
export function spectatorPly(current: number, latest: number, following: boolean) { return Math.min(current + Number(following && current < latest), latest) }
export function pendingBatch(): BatchHandle | undefined {
  try { const value = JSON.parse(localStorage.getItem(KEY) || 'null'); return value?.id && value?.options ? value : undefined } catch { return undefined }
}
export function autoWorkers(cores: number): 1 | 2 | 4 | 6 { return cores >= 8 ? 4 : cores >= 4 ? 2 : 1 }
export async function backgroundBatch(handle: BatchHandle, lines: Variation[], signal: AbortSignal, progress: (status: BatchStatus) => void, recovery = false) {
  if (!recovery) try { await syncExplorerCache(signal) } catch { /* Generation still works without the warm cache. */ }
  const url = `/api/generation/batch/${handle.id}`
  localStorage.setItem(KEY, JSON.stringify(handle))
  const clear = () => { if (pendingBatch()?.id === handle.id) localStorage.removeItem(KEY) }
  let start = !recovery, revision = -1, stopped = false, finished = false
  try {
    for (;;) {
      if (signal.aborted && !stopped) {
        const response = await fetch(url, { method: 'DELETE', keepalive: true })
        progress(await response.json() as BatchStatus)
        stopped = true
      }
      let response: Response
      try {
        response = await fetch(url, start && !stopped ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...handle, lines, token: lichessToken() }), signal } : {})
      } catch (error) {
        if (signal.aborted) continue
        await new Promise(resolve => setTimeout(resolve, 1500)); continue
      }
      const state = await response.json() as BatchStatus & { error?: string }
      if (!response.ok) { finished = true; throw new Error(state.error || `Batch server error (${response.status}).`) }
      start = false
      if (state.revision !== revision) { progress(state); revision = state.revision }
      if (state.status !== 'running' && state.status !== 'stopping') { finished = true; return state }
      await new Promise(resolve => setTimeout(resolve, 750))
    }
  } finally { if (finished) clear() }
}
