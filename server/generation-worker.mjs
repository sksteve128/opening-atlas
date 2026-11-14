import 'fake-indexeddb/auto'
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
import { EngineWorker, cleanup } from './stockfish-process.mjs'

let server, modules, token, active, busy = false, nextRequest = 0
const sharedAnalyses = new Map()
const patriciaRequests = new Map()
const requests = new Map(), realFetch = globalThis.fetch
globalThis.Worker = EngineWorker
globalThis.localStorage = { getItem: key => key === 'opening-atlas-lichess-token' ? token || '' : null }
globalThis.fetch = (url, init = {}) => {
  const target = String(url)
  if (target === '/book.json') return readFile('public/book.json', 'utf8').then(body => new Response(body))
  if (target.startsWith('https://explorer.lichess.org/') || target === '/maia/predict') {
    const id = ++nextRequest
    return new Promise((resolve, reject) => {
      if (init.signal?.aborted) return reject(init.signal.reason)
      const abort = () => { requests.delete(id); reject(init.signal.reason) }
      init.signal?.addEventListener('abort', abort, { once: true })
      requests.set(id, result => { init.signal?.removeEventListener('abort', abort); resolve(new Response(result.body, { status: result.status, headers: result.cache ? { 'X-Explorer-Cache': result.cache.state, 'X-Explorer-Retrieved-At': String(result.cache.retrievedAt) } : undefined })) })
      process.send({ remoteRequest: { id, url: target === '/maia/predict' ? 'http://127.0.0.1:8765/predict' : target, method: init.method, body: init.body, headers: init.headers } })
    })
  }
  return realFetch(url, init)
}
async function ready() {
  if (!server) {
    server = await createServer({ configFile: false, cacheDir: 'node_modules/.vite-generation', server: { middlewareMode: true, hmr: false }, appType: 'custom' })
    const [engine, data, sharpness, maia, learning, simple, human] = await Promise.all([
      '/src/engine.ts', '/src/data.ts', '/src/sharpness.ts', '/src/maia2.ts', '/src/learning.ts', '/src/simpleGeneration.ts', '/src/humanGeneration.ts',
    ].map(path => server.ssrLoadModule(path)))
    modules = { engine, data, sharpness, maia, learning, simple, human }
  }
  return modules
}
async function generate({ options, lines, token: credential, sharedAnalyses: inheritedAnalyses = [] }) {
  if (busy) return
  sharedAnalyses.clear(); for (const [key, entries] of inheritedAnalyses) sharedAnalyses.set(key, entries)
  busy = true; token = credential
  active = new AbortController()
  try {
    const { engine, data, sharpness, maia, learning, simple, human } = await ready()
    const metricsBefore = engine.engineMetrics()
    let sharedCacheHits = 0
    let phase = 'Generating…'
    const analyses = {}, evaluations = {}
    const publish = (fen, result) => {
      if (!result.length) return
      analyses[fen] = result
      evaluations[fen] = result[0]
      process.send({ analyses, evaluations })
    }
    const sources = { patricia: (fen, ms, signal) => new Promise((resolve, reject) => {
      const id = ++nextRequest
      if (signal?.aborted) return reject(signal.reason)
      const abort = () => { patriciaRequests.delete(id); if (process.connected) process.send({ patriciaCancel: id }); reject(signal.reason) }
      signal?.addEventListener('abort', abort, { once: true })
      patriciaRequests.set(id, result => { signal?.removeEventListener('abort', abort); result.error ? reject(new Error(result.error)) : resolve(result.result) })
      process.send({ patriciaRequest: { id, fen, ms } })
    }), explorer: data.explorer, cached: (fen,count,depth) => { const shared = options.exploration?.mode === 'explore' && engine.reusableAnalysis(sharedAnalyses,fen,count,depth); if(shared) { sharedCacheHits++; return shared } return engine.cachedAnalysis(fen,count,depth) }, fastSharpness: sharpness.cachedFastSharpness, humanModel: maia.maia2, tablebase: learning.lookupTablebase,
      analyze: async (...args) => {
        const shared = options.exploration?.mode === 'explore' && !args[5] && engine.reusableAnalysis(sharedAnalyses,args[0],args[1],args[2],args[6])
        if (shared) { sharedCacheHits++; return shared }
        const original = args[7] || {}
        args[7] = { ...original, onDepth: result => {
          original.onDepth?.(result)
          if (!args[6] && result[0]) {
            publish(args[0], result)
            process.send({ phase: `${phase} · Stockfish depth ${result[0].depth}/${args[2]}` })
          }
        } }
        const result = await engine.analyze(...args)
        if (options.exploration?.mode === 'explore' && result.length && result.every(e=>e.depth>=args[2] && !e.search?.stoppedByBudget && !e.search?.cancelled && e.search?.multiPVComplete!==false)) {
          const key = `${args[0]}|${args[1]}|${args[2]}|${[...(args[6]||[])].sort().join(',')}`
          process.send({engineCache:{key,entries:result}})
        }
        if (!args[6]) publish(args[0], result)
        return result
      } }
    const progress = (next, line) => { phase = next; process.send({ phase, ...(line ? { line } : {}) }) }
    const line = options.playMode === 'complete'
      ? await learning.generateVariation(options, lines, sources, active.signal, line => progress(`Generated ${Math.max(0, line.moves.length - options.prefix.length)} plies · Generating complete game…`, line))
      : await (options.playMode === 'advanced' ? human.generateHumanRepertoire : simple.generateSimpleRepertoire)(options, lines, sources, active.signal, progress)
    const metricsAfter = engine.engineMetrics()
    process.send({ status: active.signal.aborted ? 'cancelled' : 'complete', line, engineMetrics: { searches: metricsAfter.searches - metricsBefore.searches, cacheHits: metricsAfter.cacheHits - metricsBefore.cacheHits, sharedCacheHits } })
  } catch (error) {
    if (process.connected) process.send({ status: active.signal.aborted ? 'cancelled' : 'failed', error: error.message })
  } finally {
    token = undefined; active = undefined; busy = false
    if (process.connected) process.send({ ready: true })
  }
}
process.on('message', message => {
  if (message.sharedEngineAnalysis) { const {key,entries}=message.sharedEngineAnalysis; sharedAnalyses.set(key,entries); if(sharedAnalyses.size>200)sharedAnalyses.delete(sharedAnalyses.keys().next().value); return }
  if (message.patriciaResponse) { const callback = patriciaRequests.get(message.patriciaResponse.id); patriciaRequests.delete(message.patriciaResponse.id); callback?.(message.patriciaResponse); return }
  if (message.remoteResponse) { const resolve = requests.get(message.remoteResponse.id); requests.delete(message.remoteResponse.id); resolve?.(message.remoteResponse); return }
  if (message.cancel) { active?.abort(); return }
  if (message.options) void generate(message)
})
process.on('exit', cleanup)
process.on('SIGTERM', () => { active?.abort(); cleanup(); process.exit(0) })
process.on('disconnect', () => { active?.abort(); cleanup(); process.exit(0) })
