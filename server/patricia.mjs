import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { Chess } from 'chess.js'

// One process and FIFO queue for all generation workers; no per-job native engines.
export function patriciaService({ executable = process.env.PATRICIA_PATH || resolve('.engines/patricia-5.1/engine/patricia'), launch = spawn } = {}) {
  let child, pending, starting, version = '', tail = Promise.resolve(), closed = false, queuedCount = 0, unavailableUntil = 0
  const controllers = new Map()
  const kill = () => { const old = child; child = undefined; starting = undefined; old?.kill() }
  const send = command => child?.stdin.write(command + '\n')
  const wait = (match, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = undefined; kill(); reject(new Error('Patricia did not respond')) }, ms)
    pending = { match, resolve: value => { clearTimeout(timer); pending = undefined; resolve(value) }, reject: error => { clearTimeout(timer); pending = undefined; reject(error) } }
  })
  const ready = async () => {
    if (child) return starting
    if (Date.now() < unavailableUntil) throw new Error('Patricia unavailable; retry later')
    child = launch(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const current = child
    const failed = error => { if (child !== current) return; if (error.code === 'ENOENT' || error.code === 'EACCES') unavailableUntil = Date.now() + 30000; pending?.reject(error); kill() }
    child.on('error', failed); child.stdin.on('error', failed)
    child.on('close', () => failed(new Error('Patricia process exited')))
    child.stderr.on('data', () => {})
    createInterface({ input: child.stdout }).on('line', line => {
      if (child !== current) return
      if (line.startsWith('id name ')) version = line.slice(8)
      if (pending?.match(line)) pending.resolve(line)
    })
    starting = (async () => {
      let response = wait(line => line === 'uciok', 3000); send('uci'); await response
      send('setoption name Threads value 1'); send('setoption name Hash value 32'); send('setoption name Skill_Level value 21'); send('setoption name MultiPV value 1'); send('setoption name UCI_Chess960 value false')
      response = wait(line => line === 'readyok', 3000); send('isready'); await response
    })()
    return starting
  }
  const propose = (fen, ms, signal) => {
    if (queuedCount >= 32) return Promise.reject(new Error('Patricia queue is full'))
    queuedCount++
    const queued = Date.now()
    const task = tail.then(async () => {
      signal?.throwIfAborted()
      if (closed) throw new Error('Patricia unavailable')
      const game = new Chess(fen)
      if (!Number.isFinite(ms)) throw new Error('Invalid Patricia budget')
      await ready(); signal?.throwIfAborted()
      const started = Date.now(), duration = Math.max(50, Math.min(1000, ms))
      const abort = () => send('stop')
      const timer = setTimeout(abort, duration + 50)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const result = wait(line => line.startsWith('bestmove'), duration + 750)
        send('position fen ' + game.fen()); send(`go movetime ${duration}`)
        const line = await result
        signal?.throwIfAborted()
        const move = /^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)(?: ponder [a-h][1-8][a-h][1-8][qrbn]?)?$/.exec(line)?.[1]
        if (!move || !game.moves({ verbose: true }).some(m => m.from + m.to + (m.promotion || '') === move)) throw new Error('Invalid or illegal Patricia output')
        return { move, version, durationMs: Date.now() - started, queueMs: started - queued }
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    })
    const result = task.finally(() => queuedCount--)
    tail = result.catch(() => {})
    return result
  }
  const attach = worker => {
    const active = new Map(); controllers.set(worker, active)
    const cancel = () => { for (const c of active.values()) c.abort(); active.clear() }
    worker.on('close', () => { cancel(); controllers.delete(worker) })
    worker.on('message', message => {
      if (message.patriciaCancel) { active.get(message.patriciaCancel)?.abort(); return }
      if (!message.patriciaRequest) return
      const { id, fen, ms } = message.patriciaRequest, controller = new AbortController(); active.set(id, controller)
      propose(fen, ms, controller.signal).then(result => { if (worker.connected) worker.send({ patriciaResponse: { id, result } }) }, error => { if (worker.connected) worker.send({ patriciaResponse: { id, error: error.message } }) }).finally(() => active.delete(id))
    })
  }
  return { propose, attach, get pid() { return child?.pid }, close() { closed = true; for (const active of controllers.values()) for (const c of active.values()) c.abort(); pending?.reject(new Error('Patricia stopped')); kill() } }
}
