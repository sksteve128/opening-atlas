import type { ChildProcess } from 'node:child_process'
import type { RemoteRequest, RemoteResult } from './shared-fetch.mjs'
export type Batch = { status: string; revision: number; updated: number; stop: () => void; [key: string]: unknown }
export function batchManager(options?: { attachEngine?: (worker: ChildProcess) => void; spawn?: () => ChildProcess; remote?: (request: RemoteRequest, active?: () => boolean) => Promise<RemoteResult> }): {
  get: (id: string) => Batch | undefined
  start: (id: string, input: unknown) => Batch
  active: () => boolean
  close: () => void
  prune: () => void
}
