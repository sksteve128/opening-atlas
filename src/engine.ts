import { read, write } from './data'
import { Chess } from 'chess.js'

export type SearchInfo = { cancelled?: boolean; bestMove?: string; requestedDepth: number; achievedDepth: number; durationMs: number; queueMs: number; nodes?: number; multiPVComplete: boolean; endedNaturally: boolean; stoppedByBudget: boolean }
export type Evaluation = { source?: 'local' | 'cloud'; cloud?: { knodes: number; candidates: number }; search?: SearchInfo; wdl?: [number, number, number]; cp: number; line: string[]; depth: number; mate?: number }
let worker: Worker | undefined
export type SearchOptions = { priority?: 'interaction' | 'explicit' | 'visible' | 'background'; onDepth?: (lines: Evaluation[]) => void }
const priorities = { interaction: 0, explicit: 1, visible: 2, background: 3 }
const pending: { at: number; priority: number; run: () => Promise<void> }[] = []
let running = false
let yieldBackground: (() => void) | undefined
function schedule<T>(run: () => Promise<T>, priority: SearchOptions['priority'] = 'explicit'): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.push({ at: performance.now(), priority: priorities[priority], run: async () => { try { resolve(await run()) } catch (error) { reject(error) } } })
    if (priority !== 'background') yieldBackground?.()
    queueMicrotask(drain)
  })
}
async function drain() {
  if (running) return
  running = true
  while (pending.length) {
    // Age queued work one priority tier every five seconds to prevent starvation.
    const now = performance.now()
    pending.sort((a, b) => (a.priority - Math.floor((now-a.at)/5000)) - (b.priority - Math.floor((now-b.at)/5000)) || a.at-b.at)
    await pending.shift()!.run()
  }
  running = false
}
const persistentKey = 'engine-cache:stockfish-19-lite-single:default-hash:wdl:v1'
let cacheLoad: Promise<void> | undefined
export function loadEngineCache() {
  return cacheLoad ||= (typeof indexedDB === 'undefined' ? Promise.resolve() : read<[string, Evaluation[]][]>(persistentKey).then(saved => {
    if (!Array.isArray(saved)) return
    for (const row of saved.slice(-200)) if (Array.isArray(row) && typeof row[0] === 'string' && Array.isArray(row[1]) && row[1].every(e => e && Array.isArray(e.line) && e.line.every(m => typeof m === 'string') && Number.isFinite(e.depth) && Number.isFinite(e.cp) && e.source !== 'cloud')) {
      if (!evaluations.has(row[0])) evaluations.set(row[0], row[1])
    }
    while(evaluations.size > 200) evaluations.delete(evaluations.keys().next().value!)
  }).catch(() => {}))
}
let saveTimer: ReturnType<typeof setTimeout> | undefined
function persistCache() {
  if (typeof indexedDB === 'undefined' || saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = undefined; void write(persistentKey, [...evaluations]).catch(() => {}) }, 500)
}
const evaluations = new Map<string, Evaluation[]>()
// Each map belongs to one fixed engine/configuration (or one generation's Sources).
// Never share it across engine instances with different options or versions.
export function reusableAnalysis(cache: Map<string, Evaluation[]>, fen: string, count: number, depth: number, searchMoves?: string[]) {
  let legal: Set<string> | undefined, best: Evaluation[] | undefined
  const restriction = [...(searchMoves || [])].sort().join(',')
  for (const [key, lines] of [...cache].reverse()) {
    const [position, multiPV, requestedDepth, restricted = ''] = key.split('|')
    if (position !== fen || restricted.split(',').filter(Boolean).sort().join(',') !== restriction || Number(multiPV) < count || Number(requestedDepth) < depth) continue
    if (best && Number(requestedDepth) <= best[0].depth) continue
    legal ||= new Set(new Chess(fen).moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || '')))
    const allowed = restriction ? new Set(searchMoves!.filter(move => legal!.has(move))) : legal
    const completeCount = Math.min(Number(multiPV), allowed.size)
    if (!completeCount || lines.length !== completeCount || new Set(lines.map(line => line.line[0])).size !== completeCount) continue
    if (lines.some(line => line.source === 'cloud' || line.depth !== lines[0].depth || !allowed.has(line.line[0]) || !Number.isFinite(line.cp) || line.depth < Number(requestedDepth))) continue
    best = lines
  }
  return best ? [...best].sort((a, b) => b.cp - a.cp).slice(0, count) : undefined
}
export function cachedAnalysis(fen: string, count: number, depth: number) {
  return reusableAnalysis(evaluations, fen, count, depth)
}
function getWorker() {
  if (!worker) { worker = new Worker('/engine/stockfish-19-lite-single.js'); worker.postMessage('uci') }
  return worker
}
const metrics = { searches: 0, cacheHits: 0, queueMs: 0, searchMs: 0, nodes: 0, gracefullyStopped: 0, discarded: 0, crashes: 0 }
export const engineMetrics = () => ({ ...metrics })

export function analyze(fen: string, multiPV = 3, depth = 12, signal?: AbortSignal, timeoutMs = 25000, refresh = false, searchMoves?: string[], options: SearchOptions = {}): Promise<Evaluation[]> {
  const budgetAbort = () => signal?.reason?.name === 'TimeoutError'
  if (signal?.aborted) return Promise.reject(budgetAbort() ? new Error('Generation budget expired') : new DOMException('Cancelled', 'AbortError'))
  // Terminal positions have no candidate moves or MultiPV set to collect.
  try { if (!new Chess(fen).moves().length) return Promise.resolve([]) } catch (error) { return Promise.reject(error) }
  const cached = !refresh && reusableAnalysis(evaluations, fen, multiPV, depth, searchMoves)
  if (cached) { metrics.cacheHits++; return Promise.resolve(cached) }
  const queued = performance.now(), deadline = queued + Math.max(1, timeoutMs)
  let started = false, expired = false, cancelled = false, queueRecorded = false
  const recordQueue = () => { const ms = performance.now() - queued; if (!queueRecorded) { metrics.queueMs += ms; queueRecorded = true } return ms }
  let rejectCaller: (error: Error) => void
  const caller = new Promise<Evaluation[]>((_, reject) => { rejectCaller = reject })
  const cancel = () => {
    if (!started) recordQueue()
    if (budgetAbort()) { if (!started) { expired = true; rejectCaller(new Error('Generation budget expired while queued')) } return }
    cancelled = true; rejectCaller(new DOMException('Cancelled', 'AbortError'))
  }
  signal?.addEventListener('abort', cancel, { once: true })
  const queueTimer = setTimeout(() => {
    if (!started) { recordQueue(); expired = true; rejectCaller(new Error('Engine timed out (including queue waiting): queue budget expired')) }
  }, Math.max(1, timeoutMs))
  const task = schedule(() => new Promise<Evaluation[]>((resolve, reject) => {
    const queueMs = recordQueue()
    clearTimeout(queueTimer)
    if (cancelled || signal?.aborted) { reject(budgetAbort() ? new Error('Generation budget expired') : new DOMException('Cancelled', 'AbortError')); return }
    if (expired || performance.now() >= deadline) { reject(new Error('Engine timed out (including queue waiting): queue budget expired')); return }
    started = true
    const ready = !refresh && reusableAnalysis(evaluations, fen, multiPV, depth, searchMoves)
    if (ready) { metrics.cacheHits++; resolve(ready); return }
    const engine = getWorker(), at = performance.now()
    const legal = new Set(new Chess(fen).moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || '')))
    const allowed = searchMoves ? new Set(searchMoves.filter(m => legal.has(m))) : legal
    const count = Math.min(multiPV, allowed.size)
    metrics.searches++
    let currentDepth = 0, complete: Evaluation[] = [], stoppedByBudget = false, stopping = false, finished = false, bestMove: string | undefined, nodes = 0
    const iteration = new Map<number, Evaluation>()
    const singleMoves = new Map<string, Evaluation>()
    let grace: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => stop(true), Math.max(1, deadline - performance.now()))
    function finish(error?: Error) {
      if (finished) return
      finished = true
      if (options.priority === 'background') yieldBackground = undefined
      clearTimeout(timer); clearTimeout(grace)
      metrics.searchMs += performance.now() - at; metrics.nodes += nodes
      engine.removeEventListener('message', onMessage); engine.onerror = null
      signal?.removeEventListener('abort', onAbort)
      if (error && !(error.name === 'AbortError' && complete.length && bestMove && allowed.has(bestMove))) { metrics.discarded++; reject(error); return }
      if (stopping) metrics.gracefullyStopped++
      const search: SearchInfo = { ...(error ? { cancelled: true } : {}), bestMove, requestedDepth: depth, achievedDepth: complete[0]?.depth ?? 0, durationMs: performance.now() - at, queueMs, nodes, multiPVComplete: true, endedNaturally: !stopping, stoppedByBudget }
      const result = complete.map(entry => ({ ...entry, search }))
      // Cache at achieved depth: a stopped search cannot satisfy a deeper request.
      evaluations.set(`${fen}|${multiPV}|${search.achievedDepth}|${searchMoves?.join(',') || ''}`, result)
      if (evaluations.size > 200) evaluations.delete(evaluations.keys().next().value!)
      persistCache()
      if (error) reject(error)
      else resolve(result)
    }
    function kill(error: Error) {
      engine.terminate(); if (worker === engine) worker = undefined
      finish(error)
    }
    function stop(budget: boolean) {
      if (finished || stopping) return
      stopping = true; stoppedByBudget = budget
      // Keep the queue occupied until bestmove; a late response must never reach the next search.
      grace = setTimeout(() => kill(new Error('Engine timed out: no bestmove within 500ms of stop')), 500)
      engine.postMessage('stop')
    }
    function onAbort() { stop(budgetAbort()) }
    function onMessage(event: MessageEvent<string>) {
      const line = String(event.data)
      if (line.startsWith('info string CRITICAL ERROR')) { metrics.crashes++; kill(new Error('Engine crash: ' + line)); return }
      const info = line.match(/^info depth (\d+).*? multipv (\d+).*? score (cp|mate) (-?\d+).*? pv (.+)$/)
      if (info && !/ (lowerbound|upperbound) /.test(line)) {
        nodes = Math.max(nodes, Number(line.match(/ nodes (\d+)/)?.[1] || 0))
        const d = Number(info[1]), rank = Number(info[2]), mate = info[3] === 'mate' ? Number(info[4]) : undefined
        if (rank === 1 || d !== currentDepth) { iteration.clear(); currentDepth = d }
        const wdl = line.match(/ wdl (\d+) (\d+) (\d+)/)
        const entry: Evaluation = { wdl: wdl ? [Number(wdl[1]), Number(wdl[2]), Number(wdl[3])] : undefined, depth: d, cp: mate === undefined ? Number(info[4]) : Math.sign(mate) * (100000 - Math.abs(mate)), mate, line: info[5].split(' ') }
        if (rank >= 1 && rank <= count && allowed.has(entry.line[0]) && Number.isFinite(entry.cp)) iteration.set(rank, entry)
        const entries = [...iteration.values()]
        if (count > 0 && entries.length === count && new Set(entries.map(e => e.line[0])).size === count && d >= (complete[0]?.depth ?? 0)) { complete = entries.sort((a, b) => b.cp - a.cp); if (count === 1) singleMoves.set(complete[0].line[0], complete[0]);
          if (!signal?.aborted && options.onDepth) options.onDepth(complete.map(entry => ({ ...entry, source: 'local', search: { requestedDepth: depth, achievedDepth: d, durationMs: performance.now()-at, queueMs, nodes, multiPVComplete: true, endedNaturally: false, stoppedByBudget: false } })))
        }
      }
      if (line.startsWith('bestmove')) {
        bestMove = line.split(/\s+/)[1]
        if (count === 1 && singleMoves.has(bestMove)) complete = [singleMoves.get(bestMove)!]
        if (cancelled || signal?.aborted && !budgetAbort()) { finish(new DOMException('Cancelled', 'AbortError')); return }
        if (!complete.length && stoppedByBudget) { finish(new Error('Search budget expired: no coherent complete MultiPV analysis')); return }
        if (!allowed.has(line.split(/\s+/)[1]) || !complete.length) { finish(new Error('Invalid engine output: no coherent complete MultiPV analysis')); return }
        finish()
      }
    }
    if (options.priority === 'background') yieldBackground = () => stop(true)
    engine.addEventListener('message', onMessage)
    engine.onerror = () => { metrics.crashes++; kill(new Error('Engine crash')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    engine.postMessage('setoption name UCI_ShowWDL value true')
    engine.postMessage(`setoption name MultiPV value ${multiPV}`)
    engine.postMessage(`position fen ${fen}`)
    // Depth target plus an external graceful time limit, including queue waiting.
    engine.postMessage(`go depth ${depth}${searchMoves?.length ? ` searchmoves ${searchMoves.join(' ')}` : ''}`)
    if (signal?.aborted) onAbort()
  }), options.priority)
  void task.finally(() => { clearTimeout(queueTimer); signal?.removeEventListener('abort', cancel) }).catch(() => {})
  return Promise.race([task, caller])
}

export function scoreMove(uci: string, evaluations: Evaluation[]) {
  const best = evaluations[0]
  const picked = evaluations.find(e => e.line[0] === uci)
  return best && picked ? best.cp - picked.cp : null
}
export function lineSan(fen: string, line: string[]) {
  const game = new Chess(fen)
  return line.slice(0, 6).map(uci => {
    try { return game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san } catch { return uci }
  }).join(' ')
}
