import type { ChildProcess } from 'node:child_process'
export function patriciaService(): { attach(worker: ChildProcess): void; close(): void; propose(fen: string, ms: number, signal?: AbortSignal): Promise<{ move: string; version: string; durationMs: number; queueMs: number }>; readonly pid?: number }
