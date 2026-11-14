import { runGameAnalysis, type AnalysisPoint, type SavedGameAnalysis } from './gameAnalysis'
import type { Evaluation } from './engine'
import type { Variation } from './learning'

type Start = { type: 'start'; line: Variation; existing?: SavedGameAnalysis; level: 'fast' | 'deep'; budgetMs: number }
type Result = { type: 'engine-result'; id: number; lines?: Evaluation[]; error?: string }
type Outgoing = { type: 'engine'; id: number; fen: string; count: number; depth: number; timeoutMs: number } | { type: 'point'; point: AnalysisPoint; done: number; total: number } | { type: 'complete' } | { type: 'error'; message: string }

let nextId = 0
const pending = new Map<number, { resolve: (lines: Evaluation[]) => void; reject: (error: Error) => void }>()
const send = (message: Outgoing) => self.postMessage(message)

self.onmessage = (event: MessageEvent<Start | Result>) => {
  const message = event.data
  if (message.type === 'engine-result') {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error))
    else request.resolve(message.lines || [])
    return
  }
  const controller = new AbortController()
  runGameAnalysis(message.line, message.existing, message.level, {
    cached: () => undefined,
    analyze: (fen, count, depth, _signal, timeoutMs) => new Promise<Evaluation[]>((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      send({ type: 'engine', id, fen, count, depth, timeoutMs: timeoutMs || message.budgetMs })
    }),
  }, controller.signal, (point, done, total) => send({ type: 'point', point, done, total }), message.budgetMs)
    .then(() => send({ type: 'complete' }))
    .catch(error => send({ type: 'error', message: (error as Error).message }))
}
