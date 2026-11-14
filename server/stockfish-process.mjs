import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
const engines = new Set()
export class EngineWorker {
  listeners = new Set()
  stopped = false
  failed = false
  constructor() {
    this.process = spawn(process.execPath, [createRequire(import.meta.url)('stockfish').findEngine('lite-single')], { stdio: ['pipe', 'pipe', 'pipe'] })
    engines.add(this)
    let diagnostic = ''
    this.process.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-1000) })
    createInterface({ input: this.process.stdout }).on('line', data => { for (const listener of this.listeners) listener({ data }) })
    const fail = error => {
      if (this.stopped || this.failed) return
      this.failed = true
      // Feed the engine's existing crash/rejection path instead of crashing the entire job.
      for (const listener of this.listeners) listener({ data: `info string CRITICAL ERROR ${error.message}` })
      this.onerror?.(error)
    }
    this.process.on('error', fail)
    this.process.stdin.on('error', fail)
    this.process.on('close', (code, signal) => fail(new Error(`Stockfish stopped (${signal || `exit ${code}`}) ${diagnostic.trim()}`)))
  }
  addEventListener(_, listener) { this.listeners.add(listener) }
  removeEventListener(_, listener) { this.listeners.delete(listener) }
  postMessage(command) {
    if (this.stopped || this.failed) return
    this.process.stdin.write(command + '\n')
  }
  terminate() { this.stopped = true; this.process.kill(); engines.delete(this) }
}
export function cleanup() { for (const engine of engines) engine.terminate() }
