export type RemoteRequest = { id: number; url: string; method?: string; body?: string; headers?: Record<string, string> }
export type RemoteResult = { status: number; body: string; retryAfter?: number; cache?: { state: 'cached' | 'stale'; retrievedAt: number } }
export type SharedRemote = ((request: RemoteRequest, active?: () => boolean) => Promise<RemoteResult>) & {
  seed: (request: { url: string }, result: RemoteResult, at: number) => boolean
  metrics: () => { hits: number; misses: number; deduplicated: number; networkRequests: number; rateLimits: number; entries: number; bytes: number }
  clear: () => void
}
export function sharedGenerationFetch(fetcher?: typeof fetch): SharedRemote
