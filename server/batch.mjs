import { fork } from 'node:child_process'
import { resolve } from 'node:path'
import { sharedGenerationFetch } from './shared-fetch.mjs'
import { committedEvents } from './generation-events.mjs'

const signature = line => `${line.opponentModel || 'legacy'}|${line.side}|${line.startFen?.split(' ').slice(0, 4).join(' ')}|${line.moves?.map(move => move.uci).join(',')}`
const terminal = status => status === 'complete' || status === 'failed' || status === 'cancelled'

export function batchManager({ spawn = () => fork(resolve('server/generation-worker.mjs'), { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), remote = sharedGenerationFetch(), attachEngine = () => {} } = {}) {
  const batches = new Map()
  function start(id, input) {
    const { count, workers, options, lines, token } = input
    if (![3, 5, 10].includes(count) || ![1, 2, 4, 6].includes(workers)) throw new Error('Invalid batch size or worker count.')
    const jobs = Array.from({ length: count }, (_, index) => ({ id: `${id}:${index + 1}`, status: 'pending', phase: 'Waiting', attempts: 0, sequence: 0, events: [], ply: 0 }))
    const batch = { id, opening: options.opening, side: options.side, status: 'running', revision: 0, startedAt: Date.now(), updated: Date.now(), total: count, completed: 0, failed: 0, cancelled: 0, running: 0, workers, jobs }
    const engineCache = new Map()
    const children = new Set(), saved = [...lines], signatures = new Set(lines.map(signature))
    const touch = () => {
      batch.completed = jobs.filter(job => job.status === 'complete').length
      batch.failed = jobs.filter(job => job.status === 'failed').length
      batch.cancelled = jobs.filter(job => job.status === 'cancelled').length
      batch.running = jobs.filter(job => job.status === 'running').length
      if (!batch.running && jobs.every(job => terminal(job.status))) batch.status = batch.cancelled ? 'cancelled' : batch.failed ? 'failed' : 'complete'
      batch.updated = Date.now(); batch.revision++
    }
    const stopChild = child => { children.delete(child); child.kill() }
    const event = (job, type, extra = {}) => {
      job.events.push({ type, batchId: id, jobId: job.id, sequence: ++job.sequence, timestamp: Date.now(), ply: job.ply, fen: job.fen || options.startFen, stage: job.phase, status: job.status, ...extra })
      if (job.events.length > 128) job.events.splice(0, job.events.length - 128)
    }
    const begin = child => {
      const index = jobs.findIndex(job => job.status === 'pending')
      if (index < 0 || batch.status !== 'running') { stopChild(child); return }
      const job = jobs[index]
      job.status = 'running'; job.phase = 'Starting worker…'; job.attempts++; job.line = undefined; job.ply = options.prefix.length; job.fen = options.rootFen || options.startFen; job.startedAt = Date.now(); job.firstProgressAt = undefined
      event(job, 'job_started')
      child.current = index
      const seed = ((options.seed ?? input.seed) + index * 2654435761 + (job.attempts - 1) * 2246822519) >>> 0
      child.send({ options: { ...options, seed, explorationBatchSeed: options.seed ?? input.seed, batchIndex: index, batchAttempt: job.attempts }, lines: options.exploration?.mode === 'explore' ? lines : saved, sharedAnalyses: options.exploration?.mode === 'explore' ? [...engineCache] : [], token })
      touch()
    }
    const launch = () => {
      const child = spawn(); children.add(child); attachEngine(child)
      let diagnostic = ''
      child.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-1500) })
      child.on('message', message => {
        if (message.engineCache) {
          const {key, entries} = message.engineCache
          if (typeof key === 'string' && Array.isArray(entries) && entries.length && entries.every(e => e.depth > 0 && Number.isFinite(e.cp) && e.line?.length && !e.search?.stoppedByBudget && !e.search?.cancelled && e.search?.multiPVComplete !== false)) {
            engineCache.set(key, entries); if (engineCache.size > 200) engineCache.delete(engineCache.keys().next().value)
            for (const peer of children) if (peer !== child && peer.connected) peer.send({ sharedEngineAnalysis: {key, entries} })
          }
          return
        }
        if (message.patriciaRequest || message.patriciaCancel) return
        if (message.remoteRequest) {
          void remote(message.remoteRequest, () => batch.status === 'running').then(result => {
            if (child.connected) child.send({ remoteResponse: { id: message.remoteRequest.id, ...result } })
          })
          return
        }
        const index = child.current, job = jobs[index]
        if (message.ready) { child.current = undefined; begin(child); return }
        if (!job || job.status !== 'running') return
        const previousPhase = job.phase
        if (message.phase) { job.phase = message.phase; job.firstProgressAt ??= Date.now() }
        if (message.line) {
          try { committedEvents(job, id, message.line, job.phase); job.line = message.line }
          catch (error) { job.status = 'failed'; job.error = `Invalid committed line: ${error.message}`; job.finishedAt = Date.now(); touch(); return }
        }
        if (message.status === 'complete') {
          if(message.engineMetrics) { job.engineMetrics ||= {}; for(const [key,value] of Object.entries(message.engineMetrics)) if(Number.isFinite(value)) job.engineMetrics[key]=(job.engineMetrics[key]||0)+value }
          const line = message.line, key = line && signature(line)
          if (key && !signatures.has(key)) { signatures.add(key); saved.push(line); job.status = 'complete'; job.phase = 'Saved' }
          else if (job.attempts < 4 && batch.status === 'running') { job.status = 'pending'; job.phase = 'Retrying duplicate branch…'; job.line = undefined }
          else { job.status = 'failed'; job.error = 'No distinct continuation after four attempts.'; job.line = undefined }
        } else if (message.status === 'failed' || message.status === 'cancelled') {
          job.status = message.status; job.error = message.error || 'Generation stopped.'
        }
        if (terminal(job.status)) { job.finishedAt = Date.now(); event(job, `job_${job.status}`) }
        else if (message.phase && previousPhase !== job.phase && Date.now() - (job.lastStageEvent || 0) > 500) { event(job, 'stage_changed'); job.lastStageEvent = Date.now() }
        if (message.line || message.status || Date.now() - (job.lastPublished || 0) > 500) { touch(); job.lastPublished = Date.now() }
      })
      child.on('close', (code, signal) => {
        children.delete(child)
        const job = jobs[child.current]
        if (job?.status === 'running') { job.status = batch.status === 'running' ? 'failed' : 'cancelled'; job.error = `Worker stopped (${signal || code}). ${diagnostic}`; job.finishedAt = Date.now(); event(job, `job_${job.status}`); touch() }
        if (batch.status === 'running' && jobs.some(job => job.status === 'pending')) launch()
      })
      child.on('error', error => { diagnostic = error.message; stopChild(child) })
      begin(child)
    }
    batch.stop = () => {
      if (batch.status !== 'running') return
      batch.status = 'stopping'
      for (const job of jobs) if (job.status === 'pending') { job.status = 'cancelled'; job.phase = 'Cancelled'; event(job, 'job_cancelled') }
      for (const child of children) { child.send({ cancel: true }); setTimeout(() => { if (children.has(child)) stopChild(child) }, 2000).unref() }
      touch()
    }
    batches.set(id, batch)
    for (let i = 0; i < Math.min(count, workers); i++) launch()
    return batch
  }
  return {
    get: id => batches.get(id),
    start,
    active: () => [...batches.values()].some(batch => batch.status === 'running' || batch.status === 'stopping'),
    close: () => { for (const batch of batches.values()) batch.stop?.() },
    prune: () => { for (const [id, batch] of batches) if (terminal(batch.status) && Date.now() - batch.updated > 86400000) batches.delete(id) },
  }
}
