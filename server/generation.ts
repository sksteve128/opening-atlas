import { fork, type ChildProcess } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { Chess } from 'chess.js'
import type { Plugin } from 'vite'
import { batchManager } from './batch.mjs'
import { patriciaService } from './patricia.mjs'
import { sharedGenerationFetch } from './shared-fetch.mjs'

type Job = { status: string; phase: string; revision: number; updated: number; line?: unknown; error?: string; evaluations: Record<string, unknown> }
export function generationServer() {
  // ponytail: jobs live as long as the local server; a durable queue is only needed for server restarts.
  const patricia = patriciaService()
  const jobs = new Map<string, Job>(), children = new Map<string, ChildProcess>(), remote = sharedGenerationFetch(), batches = batchManager({ remote, attachEngine: patricia.attach })
  const stop = (id: string) => { children.get(id)?.kill(); children.delete(id) }
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/generation/')) return next()
    const reply = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    const host = req.headers.host || ''
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`)) return reply(403, { error: 'Local same-origin access required.' })
    if (req.url.startsWith('/api/generation/personal-games?')) {
      if(req.method !== 'GET') return reply(405,{error:'GET required.'})
      const path = new URL(req.url, `http://${host}`).searchParams.get('path') || ''
      if(!/^\/(game\/export\/[a-zA-Z0-9]{8}|api\/games\/user\/[a-zA-Z0-9_-]{2,30})\?/.test(path)) return reply(400,{error:'Invalid game export path.'})
      const target = new URL(path,'https://lichess.org')
      if(target.origin !== 'https://lichess.org') return reply(400,{error:'Invalid game export host.'})
      for(const key of [...target.searchParams.keys()]) if(!['since','until','perfType','opening','clocks','evals','max','ongoing','finished','sort'].includes(key))target.searchParams.delete(key)
      target.searchParams.set('max','100');target.searchParams.set('ongoing','false');target.searchParams.set('finished','true')
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000)
      res.on('close',()=>controller.abort())
      try {
        const response=await fetch(target,{signal:controller.signal,headers:{Accept:'application/x-chess-pgn',...(req.headers.authorization?{Authorization:req.headers.authorization}:{})}})
        if(!response.ok) return reply(response.status,{error:`Lichess export failed (${response.status}).`})
        const reader=response.body?.getReader();if(!reader)throw Error('Empty export response.')
        const chunks:Uint8Array[]=[];let bytes=0
        while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>20_000_000){controller.abort();throw Error('Game export exceeds 20 MB. Narrow the date range.')}chunks.push(chunk.value)}
        res.writeHead(200,{'Content-Type':'application/x-chess-pgn','Cache-Control':'no-store'});res.end(Buffer.concat(chunks))
      } catch(error) { if(!res.destroyed)reply(502,{error:(error as Error).message}) }
      finally{clearTimeout(timer)}
      return
    }
    if (req.url.startsWith('/api/generation/explorer?')) {
      if (req.method !== 'GET') return reply(405, { error: 'GET required.' })
      const raw = new URL(req.url, `http://${host}`).searchParams.get('url')
      let target: URL
      try { target = new URL(raw || '') } catch { return reply(400, { error: 'Invalid Explorer URL.' }) }
      if (target.origin !== 'https://explorer.lichess.org' || !['/lichess', '/masters'].includes(target.pathname)) return reply(400, { error: 'Invalid Explorer URL.' })
      const token = req.headers.authorization
      const result = await remote({ id: 0, url: target.toString(), ...(token ? { headers: { Authorization: token } } : {}) }, () => !res.destroyed)
      res.writeHead(result.status, { 'Content-Type': result.status === 200 ? 'application/json' : 'text/plain', 'Cache-Control': 'no-store', ...(result.cache ? { 'X-Explorer-Cache': result.cache.state, 'X-Explorer-Retrieved-At': String(result.cache.retrievedAt) } : {}) })
      res.end(result.body)
      return
    }
    if (req.url === '/api/generation/cache') {
      if (req.method === 'DELETE') { remote.clear(); return reply(200, { cleared: true }) }
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') return reply(405, { error: 'JSON POST required.' })
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) return reply(413, { error: 'Cache chunk is too large.' }) }
      const entries = JSON.parse(body).entries
      if (!Array.isArray(entries) || entries.length > 1000) return reply(400, { error: 'Invalid cache entries.' })
      let accepted = 0
      for (const item of entries) if (typeof item?.url === 'string' && item.url.startsWith('https://explorer.lichess.org/') && remote.seed({ url: item.url }, { status: 200, body: JSON.stringify(item.data) }, item.at)) accepted++
      return reply(200, { accepted })
    }
    const batch = req.url.startsWith('/api/generation/batch/')
    const id = req.url.slice(batch ? '/api/generation/batch/'.length : '/api/generation/'.length)
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply(400, { error: 'Invalid job ID.' })
    try {
      if (req.method === 'POST') {
        if (batch && batches.get(id)) return reply(200, batches.get(id))
        if (!batch && jobs.has(id)) return reply(200, jobs.get(id)) // Retry safely after a lost response.
        if (req.headers['content-type'] !== 'application/json') return reply(415, { error: 'JSON required.' })
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 20_000_000) return reply(413, { error: 'Generation input is too large.' }) }
        const input = JSON.parse(body), o = input.options
        if (!o || !Array.isArray(input.lines) || !Array.isArray(o.prefix) || !['white', 'black'].includes(o.side) || !['advantage', 'mainline', 'advanced', 'complete'].includes(o.playMode) || !['lichess', 'masters'].includes(o.database) || !Array.isArray(o.filters?.ratings) || !Array.isArray(o.filters?.speeds)) throw new Error('Invalid generation options.')
        new Chess(o.startFen); new Chess(o.rootFen)
        if (o.aggressive && (o.aggressive.engine !== 'patricia' || typeof o.aggressive.relaxed !== 'boolean' || !Number.isFinite(o.aggressive.maxLossCp) || o.aggressive.maxLossCp < 0 || o.aggressive.maxLossCp > 50)) throw new Error('Invalid aggressive engine settings.')
        for (const [key, min, max] of [['maxPlies', 1, 400], ['engineDepth', 1, 30], ['verificationDepth', 1, 30], ['engineTimeoutMs', 1, 60000]] as const) if (!Number.isFinite(o[key]) || o[key] < min || o[key] > max) throw new Error(`Invalid ${key}.`)
        if (input.token !== undefined && (typeof input.token !== 'string' || !/^[A-Za-z0-9_]{1,512}$/.test(input.token))) throw new Error('Invalid credential.')
        for (const [key, job] of jobs) if (job.status !== 'running' && Date.now() - job.updated > 86400000) jobs.delete(key)
        batches.prune()
        if (batch) {
          if (batches.active() || children.size) return reply(409, { error: 'Another generation is running.' })
          return reply(202, batches.start(id, input))
        }
        if (batches.active() || children.size >= 2) return reply(409, { error: 'Another generation is already running.' })
        const job: Job = { status: 'running', phase: 'Starting server generation…', revision: 0, updated: Date.now(), evaluations: {} }
        jobs.set(id, job)
        const child = fork(resolve('server/generation-worker.mjs'), { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
        children.set(id, child); patricia.attach(child)
        let diagnostic = ''
        child.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4000) })
        child.on('message', (message: any) => {
          if (message.patriciaRequest || message.patriciaCancel) return
          if (message.remoteRequest) { void remote(message.remoteRequest, () => job.status === 'running').then(result => { if (child.connected) child.send({ remoteResponse: { id: message.remoteRequest.id, ...result } }) }); return }
          if (message.ready) { stop(id); return }
          if (job.status !== 'running') return
          if (message.evaluation) job.evaluations[message.evaluation.fen] = message.evaluation.value
          else Object.assign(job, message)
          job.revision++; job.updated = Date.now()
        })
        const exited = (detail: string) => {
          children.delete(id)
          if (job.status === 'running') {
            job.status = 'failed'
            const safeDiagnostic = input.token ? diagnostic.split(input.token).join('[redacted]') : diagnostic
            job.error = `Generation process stopped (${detail}). ${safeDiagnostic.trim()} The latest partial line is retained.`
            job.revision++
          }
        }
        child.on('error', error => exited(error.message))
        child.on('close', (code, signal) => exited(signal ? `signal ${signal}` : `exit code ${code}`))
        child.send(input)
        return reply(202, job)
      }
      if (batch) {
        const job = batches.get(id)
        if (!job) return reply(404, { error: 'Batch unavailable after server restart.' })
        if (req.method === 'DELETE') job.stop()
        else if (req.method !== 'GET') return reply(405, { error: 'Method not allowed.' })
        return reply(200, job)
      }
      const job = jobs.get(id)
      if (!job) return reply(404, { error: 'Generation job is unavailable. The server may have restarted; your saved partial line is retained.' })
      if (req.method === 'DELETE') { if (job.status === 'running') { job.status = 'cancelled'; job.revision++; stop(id) } }
      else if (req.method !== 'GET') return reply(405, { error: 'Method not allowed.' })
      reply(200, job)
    } catch (error) { reply(400, { error: (error as Error).message }) }
  }
  return { middleware, close: () => { batches.close(); patricia.close(); for (const id of children.keys()) stop(id) } }
}
export default function generationPlugin(): Plugin {
  const server = generationServer()
  return { name: 'background-generation', configureServer(vite) { vite.middlewares.use(server.middleware); vite.httpServer?.once('close', server.close) }, configurePreviewServer(vite) { vite.middlewares.use(server.middleware); vite.httpServer.once('close', server.close) } }
}
