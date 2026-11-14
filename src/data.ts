import type { ExplorerData } from './core'
import { identity } from './core'
import { lichessToken } from './lichessAuth'

const DB = 'opening-atlas-v1'
const STORE = 'items'
let dbPromise: Promise<IDBDatabase> | undefined
export function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function read<T>(key: string): Promise<T | undefined> {
  const database = await db()
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}
export async function write(key: string, value: unknown) {
  const database = await db()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export type Filters = { ratings: number[]; speeds: string[] }
const CACHE_VERSION = 2
const CACHE_BUDGET = 100 * 1024 * 1024
const FRESH_MS = 7 * 86400000
const cacheRange = () => IDBKeyRange.bound('explorer:', 'explorer:\uffff')
type CacheEntry = { version?: number; at: number; accessed?: number; bytes?: number; data: ExplorerData }
let lastRequest = 0, serviceUnavailableUntil = 0, unavailableReason = '', lastToken: string | undefined
let queue = Promise.resolve(), cacheWrites = Promise.resolve(), cacheEpoch = 0
let storedBytes: number | undefined
let hits = 0, misses = 0, avoided = 0, deduplicated = 0, networkRequests = 0, rateLimits = 0
const refreshAttempts = new Map<string, number>()
const refreshedKeys = new Set<string>()
const inFlight = new Map<string, Promise<ExplorerData>>()
const explorerMemory = new Map<string, CacheEntry>()
type BookEntry = { name?: string; moves: { uci: string; san: string }[] }
let bookPromise: Promise<Record<string, BookEntry>> | undefined
async function openingBook(fen: string): Promise<ExplorerData> {
  bookPromise ||= fetch('/book.json').then(response => { if (!response.ok) throw new Error('Opening book unavailable'); return response.json() })
  const entry = (await bookPromise)[identity(fen)]
  return { white: 0, draws: 0, black: 0, opening: entry?.name ? { name: entry.name } : undefined, moves: (entry?.moves || []).map(m => ({ ...m, white: 0, draws: 0, black: 0 })), source: 'book', unavailableReason }
}
export function explorerCacheKey(fen: string, filters: Filters, database: 'lichess' | 'masters') {
  const ratings = database === 'masters' ? [] : [...new Set(filters.ratings)].sort((a, b) => a - b)
  const speeds = database === 'masters' ? [] : [...new Set(filters.speeds)].sort()
  return `explorer:v${CACHE_VERSION}:${database}:standard:12:${identity(fen)}:${ratings.join(',')}:${speeds.join(',')}`
}
function legacyKey(fen: string, filters: Filters, database: 'lichess' | 'masters') {
  return `explorer:${database}:${identity(fen)}:${filters.ratings.join(',')}:${filters.speeds.join(',')}`
}
function validEntry(entry: unknown): entry is CacheEntry {
  if (!entry || typeof entry !== 'object') return false
  const value = entry as CacheEntry, data = value.data
  return Number.isFinite(value.at) && value.at > 0 && !!data && ['lichess', 'masters'].includes(data.source || '') && [data.white, data.draws, data.black].every(n => Number.isSafeInteger(n) && n >= 0) && Array.isArray(data.moves) && data.moves.every(m => typeof m.uci === 'string' && typeof m.san === 'string' && [m.white, m.draws, m.black].every(n => Number.isSafeInteger(n) && n >= 0))
}
function entryBytes(key: string, entry: CacheEntry) { return new TextEncoder().encode(key + JSON.stringify(entry)).length }
function remember(key: string, entry: CacheEntry) {
  explorerMemory.delete(key); explorerMemory.set(key, entry)
  if (explorerMemory.size > 200) explorerMemory.delete(explorerMemory.keys().next().value!)
}
async function cacheRows(): Promise<{ key: string; entry: CacheEntry; bytes: number }[]> {
  const database = await db()
  return new Promise((resolve, reject) => {
    const store = database.transaction(STORE).objectStore(STORE)
    const keys = store.getAllKeys(cacheRange()), values = store.getAll(cacheRange())
    values.onsuccess = () => resolve((keys.result as string[]).map((key, i) => ({ key, entry: values.result[i] as CacheEntry, bytes: entryBytes(key, values.result[i] as CacheEntry) })))
    values.onerror = () => reject(values.error)
    keys.onerror = () => reject(keys.error)
  })
}
async function pruneExplorerCache(limit = CACHE_BUDGET, protectedKey?: string) {
  const rows = await cacheRows()
  let bytes = rows.reduce((sum, row) => sum + row.bytes, 0)
  if (bytes <= limit) { storedBytes = bytes; return }
  const removable = rows.filter(row => row.key !== protectedKey && !inFlight.has(row.key)).sort((a, b) => (a.entry.accessed || a.entry.at || 0) - (b.entry.accessed || b.entry.at || 0))
  const database = await db()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE)
    for (const row of removable) { if (bytes <= limit) break; store.delete(row.key); explorerMemory.delete(row.key); bytes -= row.bytes }
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
  })
  storedBytes = bytes
}
function enqueueCacheWrite(task: () => Promise<void>) { const pending = cacheWrites.then(task); cacheWrites = pending.catch(() => {}); return pending }
async function persistEntry(key: string, entry: CacheEntry, obsolete?: string) {
  return enqueueCacheWrite(async () => {
    const database = await db()
    if (storedBytes === undefined) storedBytes = (await cacheRows()).reduce((sum, row) => sum + row.bytes, 0)
    const previous = await read<CacheEntry>(key).catch(() => undefined)
    if (validEntry(previous) && previous.at > entry.at) return
    const old = obsolete ? await read<CacheEntry>(obsolete).catch(() => undefined) : undefined
    const delta = entryBytes(key, entry) - (previous === undefined ? 0 : entryBytes(key, previous)) - (old === undefined || !obsolete ? 0 : entryBytes(obsolete, old))
    const save = () => new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE)
      store.put(entry, key); if (obsolete) store.delete(obsolete)
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
    let retried = false
    try { await save() }
    catch (error) { if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error; await pruneExplorerCache(CACHE_BUDGET * .8, key); await save(); retried = true }
    storedBytes = retried ? undefined : storedBytes + delta
    if (storedBytes === undefined || storedBytes > CACHE_BUDGET) await pruneExplorerCache(CACHE_BUDGET, key)
  })
}
async function cached(key: string, oldKey: string): Promise<CacheEntry | undefined> {
  const memory = explorerMemory.get(key)
  if (memory && validEntry(memory)) return memory
  const entry = await read<CacheEntry>(key).catch(() => undefined)
  if (validEntry(entry) && (!entry.version || entry.version === CACHE_VERSION)) { remember(key, entry); return entry }
  const legacy = await read<CacheEntry>(oldKey).catch(() => undefined)
  if (validEntry(legacy)) {
    const migrated = { ...legacy, version: CACHE_VERSION, accessed: legacy.accessed || legacy.at }
    remember(key, migrated); void persistEntry(key, migrated, oldKey).catch(() => {})
    return migrated
  }
}
function useCached(key: string, entry: CacheEntry): ExplorerData {
  hits++; avoided++
  const age = Math.max(0, Date.now() - entry.at)
  const accessed = Date.now()
  if (accessed - (entry.accessed || entry.at) > 3600000) {
    entry.accessed = accessed
    void persistEntry(key, entry).catch(() => {})
  }
  remember(key, entry)
  return { ...entry.data, cache: { state: age > FRESH_MS ? 'stale' : refreshedKeys.has(key) ? 'refreshed' : 'cached', retrievedAt: entry.at } }
}
function waitFor<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('Cancelled', 'AbortError'))
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || new DOMException('Cancelled', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    task.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
function requestExplorer(fen: string, filters: Filters, database: 'lichess' | 'masters', key: string, refresh = false): Promise<ExplorerData> {
  const existing = inFlight.get(key)
  if (existing) { deduplicated++; return existing }
  const epoch = cacheEpoch
  const job = queue.then(async () => {
    const token = lichessToken()
    if (token !== lastToken) { serviceUnavailableUntil = 0; unavailableReason = ''; lastToken = token }
    if (Date.now() < serviceUnavailableUntil) return openingBook(fen)
    const wait = Math.max(0, 1100 - (Date.now() - lastRequest))
    if (wait) await new Promise(resolve => setTimeout(resolve, wait))
    lastRequest = Date.now(); networkRequests++
    const url = new URL(`https://explorer.lichess.org/${database}`)
    if (database === 'lichess') url.searchParams.set('variant', 'standard')
    url.searchParams.set('fen', fen)
    if (database === 'lichess') { url.searchParams.set('ratings', filters.ratings.join(',')); url.searchParams.set('speeds', filters.speeds.join(',')) }
    url.searchParams.set('moves', '12')
    let response: Response
    try {
      const options = { ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}), signal: AbortSignal.timeout(8000) }
      response = typeof window !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
        ? await fetch(`/api/generation/explorer?url=${encodeURIComponent(url.toString())}`, options)
        : await fetch(url, options)
      if (response.status === 404) response = await fetch(url, options)
    }
    catch (error) { serviceUnavailableUntil = Date.now() + 300000; unavailableReason = 'Live Explorer is temporarily unavailable: ' + (error as Error).message; return openingBook(fen) }
    if (response.status === 429) { rateLimits++; const retry = response.headers.get('Retry-After'); const delay = retry ? /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now() : 0; serviceUnavailableUntil = Date.now() + Math.max(60000, Number.isFinite(delay) ? delay : 0); unavailableReason = 'Lichess rate limit reached. Retrying after cooldown.'; return openingBook(fen) }
    if (response.status === 401 || response.status === 403) { serviceUnavailableUntil = Date.now() + 300000; unavailableReason = `Lichess Explorer access denied (HTTP ${response.status}). Connect or reconnect Lichess.`; return openingBook(fen) }
    if (response.status >= 500) { serviceUnavailableUntil = Date.now() + 300000; unavailableReason = `Live Explorer is temporarily unavailable (HTTP ${response.status}).`; return openingBook(fen) }
    if (!response.ok) throw new Error(`Lichess request failed (${response.status})`)
    const retrievedAt = Number(response.headers.get('X-Explorer-Retrieved-At'))
    const serverState = response.headers.get('X-Explorer-Cache')
    const data = { ...await response.json() as ExplorerData, source: database }
    if (!validEntry({ at: Date.now(), data })) throw new Error('Malformed Explorer response')
    const at = Number.isFinite(retrievedAt) && retrievedAt > 0 ? retrievedAt : Date.now(), entry = { version: CACHE_VERSION, at, accessed: Date.now(), data }
    if (epoch === cacheEpoch) { remember(key, entry); if (refresh) refreshedKeys.add(key); void persistEntry(key, entry).catch(() => {}); if (refresh && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('explorer-refreshed', { detail: key })) }
    return { ...data, cache: { state: serverState === 'stale' ? 'stale' as const : serverState === 'cached' ? 'cached' as const : 'live' as const, retrievedAt: at } }
  })
  queue = job.then(() => undefined, () => undefined)
  inFlight.set(key, job)
  void job.finally(() => inFlight.delete(key)).catch(() => {})
  return job
}
function scheduleRefresh(fen: string, filters: Filters, database: 'lichess' | 'masters', key: string, age: number) {
  if (Date.now() < serviceUnavailableUntil || inFlight.has(key)) return
  const interval = age < 30 * 86400000 ? 86400000 : age < 180 * 86400000 ? 6 * 3600000 : 3600000
  if (Date.now() - (refreshAttempts.get(key) || 0) < interval) return
  refreshAttempts.set(key, Date.now())
  setTimeout(() => { if (Date.now() >= serviceUnavailableUntil) void requestExplorer(fen, filters, database, key, true).catch(() => {}) }, 0)
}
export async function explorer(fen: string, filters: Filters, signal?: AbortSignal, database: 'lichess' | 'masters' = 'lichess'): Promise<ExplorerData> {
  filters = database === 'masters' ? { ratings: [], speeds: [] } : { ratings: [...new Set(filters.ratings)].sort((a, b) => a - b), speeds: [...new Set(filters.speeds)].sort() }
  const key = explorerCacheKey(fen, filters, database)
  if (signal?.aborted) throw signal.reason || new DOMException('Cancelled', 'AbortError')
  const available = await cached(key, legacyKey(fen, filters, database))
  if (signal?.aborted) throw signal.reason || new DOMException('Cancelled', 'AbortError')
  if (available) { const result = useCached(key, available); if (Date.now() - available.at > FRESH_MS) scheduleRefresh(fen, filters, database, key, Date.now() - available.at); return result }
  misses++
  return waitFor(requestExplorer(fen, filters, database, key), signal)
}
export async function explorerCacheStats() {
  const rows = await cacheRows()
  return { positions: rows.filter(row => validEntry(row.entry)).length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), oldest: rows.reduce((oldest, row) => validEntry(row.entry) ? Math.min(oldest, row.entry.at) : oldest, Infinity), hits, misses, hitRate: hits + misses ? hits / (hits + misses) : 0, networkAvoided: avoided, deduplicated, networkRequests, rateLimits }
}
export async function clearExplorerCache() {
  cacheEpoch++
  if (typeof window !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) await fetch('/api/generation/cache', { method: 'DELETE' }).catch(() => {})
  await cacheWrites
  const database = await db()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite')
    const cursor = tx.objectStore(STORE).openKeyCursor(cacheRange())
    cursor.onsuccess = () => { if (cursor.result) { tx.objectStore(STORE).delete(cursor.result.primaryKey); cursor.result.continue() } }
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
  })
  explorerMemory.clear(); refreshAttempts.clear(); refreshedKeys.clear(); storedBytes = 0
}
function requestFromCacheKey(key: string) {
  const parts = key.split(':'), modern = parts[1] === `v${CACHE_VERSION}`
  const database = parts[modern ? 2 : 1]
  if (database !== 'lichess' && database !== 'masters') return
  const position = parts[modern ? 5 : 2], ratings = parts[modern ? 6 : 3], speeds = parts[modern ? 7 : 4]
  if (!position || ratings === undefined || speeds === undefined) return
  const url = new URL(`https://explorer.lichess.org/${database}`)
  if (database === 'lichess') url.searchParams.set('variant', 'standard')
  url.searchParams.set('fen', position + ' 0 1')
  if (database === 'lichess') { url.searchParams.set('ratings', ratings); url.searchParams.set('speeds', speeds) }
  url.searchParams.set('moves', '12')
  return url.toString()
}
export async function syncExplorerCache(signal?: AbortSignal) {
  await cacheWrites
  const rows = (await cacheRows()).filter(row => validEntry(row.entry)).sort((a, b) => (a.entry.accessed || a.entry.at) - (b.entry.accessed || b.entry.at))
  let chunk: { url: string; at: number; data: ExplorerData }[] = [], size = 0, accepted = 0
  const send = async () => {
    if (!chunk.length) return
    const response = await fetch('/api/generation/cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: chunk }), signal })
    if (!response.ok) throw new Error(`Explorer cache sync failed (${response.status})`)
    accepted += (await response.json() as { accepted: number }).accepted
    chunk = []; size = 0
  }
  for (const row of rows) {
    signal?.throwIfAborted()
    const url = requestFromCacheKey(row.key)
    if (!url) continue
    if (size + row.bytes > 1000000) await send()
    chunk.push({ url, at: row.entry.at, data: row.entry.data }); size += row.bytes
  }
  await send()
  return accepted
}
// Exposed for deterministic storage-budget tests; normal writes use the 100 MB default.
export const enforceExplorerCacheBudget = (bytes: number) => enqueueCacheWrite(() => pruneExplorerCache(bytes))

// Incremental records keep graph points and practice updates from cloning the entire
// library. The original array remains a migration backup; the manifest commits atomically.
const manifestKey = 'generated-lines-manifest-v2'
let recordsLoaded = false
let savedRecords = new Map<string, import('./learning').Variation>()
let saving = Promise.resolve()
export async function readVariations(): Promise<import('./learning').Variation[] | undefined> {
  const database = await db()
  return new Promise((resolve, reject) => {
    const tx=database.transaction(STORE), store=tx.objectStore(STORE)
    let result: import('./learning').Variation[] | undefined, invalid=false, legacy=false
    const manifest=store.get(manifestKey)
    manifest.onsuccess=()=>{
      const ids: unknown=manifest.result
      if(ids===undefined){legacy=true;const request=store.get('generated-lines-v1');request.onsuccess=()=>{result=request.result};return}
      if(!Array.isArray(ids) || !ids.every(id=>typeof id==='string')){invalid=true;return}
      const records=store.getAll(IDBKeyRange.bound('variation-v2:', 'variation-v2:\uffff'))
      records.onsuccess=()=>{
        const byId=new Map((records.result as import('./learning').Variation[]).map(line=>[line.id,line]))
        invalid=ids.some(id=>!byId.has(id))
        result=ids.map(id=>byId.get(id)!)
      }
    }
    tx.oncomplete=()=>{if(invalid){reject(new Error('Incomplete saved variation library'));return} savedRecords=new Map((legacy?[]:result||[]).map(line=>[line.id,line]));recordsLoaded=true;resolve(result)}
    tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('Loading variations aborted'))
  })
}
export function writeVariations(lines: import('./learning').Variation[]) {
  const task=saving.then(async()=>{
    if (!recordsLoaded) await readVariations()
    const database=await db(), next=new Map(lines.map(line=>[line.id,line]))
    await new Promise<void>((resolve,reject)=>{
      const tx=database.transaction(STORE,'readwrite'), store=tx.objectStore(STORE)
      for(const line of lines)if(savedRecords.get(line.id)!==line)store.put(line,`variation-v2:${line.id}`)
      for(const id of savedRecords.keys())if(!next.has(id))store.delete(`variation-v2:${id}`)
      store.put(lines.map(line=>line.id),manifestKey)
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('Saving variations aborted'))
    })
    savedRecords=next
  })
  saving=task.catch(()=>{})
  return task
}
