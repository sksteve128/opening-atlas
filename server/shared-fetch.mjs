import { Chess } from 'chess.js'

const BUDGET = 100 * 1024 * 1024
const FRESH = 7 * 86400000
function explorerKey(url) {
  const query = new URL(url), database = query.pathname.split('/').at(-1)
  if (!['lichess', 'masters'].includes(database)) return url
  const fen = query.searchParams.get('fen')
  if (!fen) return url
  let game
  try { game = new Chess(fen) } catch { return url }
  const parts = fen.split(' ')
  if (parts[3] !== '-' && !game.moves({ verbose: true }).some(move => move.flags.includes('e'))) parts[3] = '-'
  const ratings = database === 'masters' ? '' : [...new Set((query.searchParams.get('ratings') || '').split(',').filter(Boolean))].sort((a, b) => Number(a) - Number(b)).join(',')
  const speeds = database === 'masters' ? '' : [...new Set((query.searchParams.get('speeds') || '').split(',').filter(Boolean))].sort().join(',')
  const other = [...query.searchParams].filter(([name]) => !['fen', 'ratings', 'speeds', 'variant', 'moves'].includes(name)).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
  return `${query.origin}/${database}:${query.searchParams.get('variant') || 'standard'}:${parts.slice(0, 4).join(' ')}:${ratings}:${speeds}:${query.searchParams.get('moves') || '12'}:${JSON.stringify(other)}`
}

// One scheduler and cache for all generation processes attached to this local server.
export function sharedGenerationFetch(fetcher = fetch) {
  let explorerQueue = Promise.resolve(), maiaQueue = Promise.resolve(), lastExplorer = 0, limitedUntil = 0, bytes = 0, epoch = 0
  let hits = 0, misses = 0, deduplicated = 0, networkRequests = 0, rateLimits = 0
  const cache = new Map(), pending = new Map(), refreshAttempts = new Map()
  const keyOf = request => request.url.startsWith('https://explorer.lichess.org/') ? explorerKey(request.url) : `${request.method || 'GET'}:${request.url}:${request.body || ''}`
  const save = (key, result, at = Date.now()) => {
    if (result.status !== 200) return
    if (key.startsWith('https://explorer.lichess.org/')) {
      try { const data = JSON.parse(result.body); if (!Array.isArray(data.moves) || ![data.white, data.draws, data.black].every(n => Number.isSafeInteger(n) && n >= 0)) return }
      catch { return }
    }
    if (cache.has(key)) bytes -= cache.get(key).bytes
    const size = new TextEncoder().encode(key + result.body).length
    cache.delete(key); cache.set(key, { result: { status: result.status, body: result.body }, at, bytes: size }); bytes += size
    while (bytes > BUDGET && cache.size > 1) { const oldest = cache.keys().next().value; bytes -= cache.get(oldest).bytes; cache.delete(oldest) }
  }
  const network = async (request, active) => {
    const explorer = request.url.startsWith('https://explorer.lichess.org/')
    if (!active()) return { status: 499, body: 'Cancelled' }
    if (explorer) {
      if (Date.now() < limitedUntil) return { status: 429, body: 'Shared Explorer rate limit cooldown' }
      const wait = Math.max(0, 1100 - (Date.now() - lastExplorer))
      if (wait) await new Promise(resolve => setTimeout(resolve, wait))
      if (!active()) return { status: 499, body: 'Cancelled' }
      lastExplorer = Date.now()
    }
    networkRequests++
    let result
    try {
      const response = await fetcher(request.url, { method: request.method || 'GET', headers: request.headers, body: request.body, signal: AbortSignal.timeout(explorer ? 8000 : 5000) })
      const retry = response.headers.get('Retry-After')
      const retryAfter = retry ? /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now() : 0
      result = { status: response.status, body: await response.text(), retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0 }
    } catch (error) { result = { status: 503, body: String(error) } }
    if (explorer && result.status === 429) { rateLimits++; limitedUntil = Date.now() + Math.max(60000, result.retryAfter || 0) }
    return result
  }
  const enqueue = (request, active, key, explorer) => {
    const started = epoch
    const queue = explorer ? explorerQueue : maiaQueue
    const task = queue.then(() => network(request, active))
    if (explorer) explorerQueue = task.then(() => {}, () => {})
    else maiaQueue = task.then(() => {}, () => {})
    const entry = { task, consumers: [active] }
    pending.set(key, entry)
    void task.then(result => { if (!explorer || started === epoch) save(key, result); if (pending.get(key) === entry) pending.delete(key) }, () => { if (pending.get(key) === entry) pending.delete(key) })
    return task.then(result => active() ? result : { status: 499, body: 'Cancelled' })
  }
  const remote = (request, active = () => true) => {
    const explorer = request.url.startsWith('https://explorer.lichess.org/')
    const key = keyOf(request), saved = cache.get(key)
    if (saved && (explorer || Date.now() - saved.at < 60000)) {
      hits++; cache.delete(key); cache.set(key, saved)
      const age = Date.now() - saved.at
      if (explorer && age > FRESH && Date.now() >= limitedUntil && Date.now() - (refreshAttempts.get(key) || 0) > 86400000 && !pending.has(key)) {
        refreshAttempts.set(key, Date.now())
        setTimeout(() => { if (Date.now() >= limitedUntil && !pending.has(key)) void enqueue(request, () => true, key, true) }, 0).unref?.()
      }
      return Promise.resolve({ ...saved.result, cache: { state: age > FRESH ? 'stale' : 'cached', retrievedAt: saved.at } })
    }
    if (pending.has(key)) { deduplicated++; const pendingRequest = pending.get(key); pendingRequest.consumers.push(active); return pendingRequest.task.then(result => active() ? result : { status: 499, body: 'Cancelled' }) }
    misses++
    const consumers = [active]
    const task = enqueue(request, () => consumers.some(consumer => consumer()), key, explorer)
    pending.get(key).consumers = consumers
    return task.then(result => active() ? result : { status: 499, body: 'Cancelled' })
  }
  remote.seed = (request, result, at) => {
    if (!request.url.startsWith('https://explorer.lichess.org/') || result.status !== 200 || !Number.isFinite(at) || at <= 0) return false
    try { const data = JSON.parse(result.body); if (!Array.isArray(data.moves) || ![data.white, data.draws, data.black].every(n => Number.isSafeInteger(n) && n >= 0)) return false }
    catch { return false }
    const key = keyOf(request), current = cache.get(key)
    if (!current || current.at < at) save(key, result, at)
    return true
  }
  remote.metrics = () => ({ hits, misses, deduplicated, networkRequests, rateLimits, entries: cache.size, bytes })
  remote.clear = () => { epoch++; for (const [key, entry] of cache) if (key.startsWith('https://explorer.lichess.org/')) { cache.delete(key); bytes -= entry.bytes }; for (const key of pending.keys()) if (key.startsWith('https://explorer.lichess.org/')) pending.delete(key); refreshAttempts.clear() }
  return remote
}
