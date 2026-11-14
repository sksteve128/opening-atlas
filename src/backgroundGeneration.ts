import type { Generation, Variation } from './learning'
import type { Evaluation } from './engine'
import { lichessToken } from './lichessAuth'
import { syncExplorerCache } from './data'
const KEY = 'opening-atlas-generation-job-v1'
export type PendingGeneration = { id: string; options: Generation }
type Status = { status: 'running' | 'complete' | 'failed' | 'cancelled'; revision: number; phase: string; line?: Variation; evaluations: Record<string, Evaluation>; analyses?: Record<string, Evaluation[]>; error?: string }
export function pendingGeneration(): PendingGeneration | undefined {
  try { const value = JSON.parse(localStorage.getItem(KEY) || 'null'); return value?.id && value?.options ? value : undefined } catch { return undefined }
}
export async function backgroundGeneration(options: Generation, lines: Variation[], signal: AbortSignal, progress: (phase: string, line?: Variation, evaluations?: Record<string, Evaluation>, analyses?: Record<string, Evaluation[]>) => void, recovery?: PendingGeneration, initialId: string = crypto.randomUUID()): Promise<Variation> {
  if (!recovery) try { await syncExplorerCache(signal) } catch { /* Generation still works without the warm cache. */ }
  const job = recovery || { id: initialId, options }, url = `/api/generation/${job.id}`
  // Save the handle before starting. Refresh reconnects to this exact job and seed.
  localStorage.setItem(KEY, JSON.stringify(job))
  let finished = false
  const cancel = () => { void fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {}); clear() }
  function clear() { if (pendingGeneration()?.id === job.id) localStorage.removeItem(KEY) }
  signal.addEventListener('abort', cancel, { once: true })
  let start = !recovery, revision = -1, lastLine = ''
  try {
    while (!signal.aborted) {
      let response: Response
      try {
        response = await fetch(url, start ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options, lines, token: lichessToken() }), signal } : { signal })
      } catch (error) {
        if (signal.aborted) throw error
        progress('Cannot reach the generation server — live progress is unavailable. Reconnecting…')
        await new Promise(resolve => setTimeout(resolve, 1500)); continue
      }
      const state = await response.json() as Status
      if (!response.ok) { finished = true; throw new Error(state.error || `Generation server error (${response.status}).`) }
      start = false
      if (state.revision !== revision) {
        const serialized = JSON.stringify(state.line)
        progress(state.phase, serialized !== lastLine ? state.line : undefined, state.evaluations, state.analyses)
        lastLine = serialized; revision = state.revision
      }
      if (state.status !== 'running') {
        finished = true
        if (state.status === 'cancelled') throw new DOMException('Generation cancelled.', 'AbortError')
        if (state.status === 'failed' || !state.line) throw new Error(state.error || 'Generation failed.')
        return state.line
      }
      await new Promise(resolve => setTimeout(resolve, 750))
    }
    throw new DOMException('Generation cancelled.', 'AbortError')
  } finally { signal.removeEventListener('abort', cancel); if (finished || signal.aborted) clear() }
}
