import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { patriciaService } from './patricia.mjs'
const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
function fake(mode = 'normal') {
  const commands: string[] = []; let live = 0, peak = 0
  const launch = vi.fn(() => {
    const child = new EventEmitter() as any; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => child.emit('close')
    child.stdin.on('data', (chunk: Buffer) => {
      const command = String(chunk).trim(); commands.push(command)
      if (command === 'uci') queueMicrotask(() => child.stdout.write('id name Patricia fake\nuciok\n'))
      if (command === 'isready') queueMicrotask(() => child.stdout.write('readyok\n'))
      if (command.startsWith('go ')) {
        live++; peak=Math.max(peak,live)
        if (mode==='crash') return queueMicrotask(()=>child.emit('error',new Error('crash')))
        if (mode==='silent') return
        if (mode==='stop') return
        setTimeout(()=>{ live--; child.stdout.write(mode==='invalid' ? 'bestmove bad\n' : 'bestmove e2e4\n') }, 5)
      }
      if (command==='stop' && mode==='stop') { live--; child.stdout.write('bestmove e2e4\n') }
    })
    return child
  })
  return { launch, commands, peak:()=>peak }
}
it('serializes four concurrent searches and reuses one full-strength process', async () => {
  const f=fake(), service=patriciaService({ launch:f.launch } as never)
  try { const results=await Promise.all(Array.from({length:4},()=>service.propose(fen,50))); expect(results.every(r=>r.move==='e2e4')).toBe(true); expect(f.peak()).toBe(1); expect(f.launch).toHaveBeenCalledTimes(1); expect(f.commands).toContain('setoption name Skill_Level value 21') } finally { service.close() }
})
it.each(['invalid','crash','silent'])('handles %s output without hanging the queue', async mode => {
  const f=fake(mode), service=patriciaService({ launch:f.launch } as never)
  try { await expect(service.propose(fen,50)).rejects.toThrow(); await expect(service.propose(fen,50)).rejects.toThrow() } finally { service.close() }
})
it('gracefully stops a bounded search and rejects user cancellation after draining bestmove', async () => {
  const f=fake('stop'), service=patriciaService({ launch:f.launch } as never)
  try { expect((await service.propose(fen,50)).move).toBe('e2e4'); const abort=new AbortController(); const task=service.propose(fen,50,abort.signal); setTimeout(()=>abort.abort(),10); await expect(task).rejects.toBeDefined(); expect((await service.propose(fen,50)).move).toBe('e2e4'); expect(f.launch).toHaveBeenCalledTimes(1) } finally { service.close() }
})
it('falls back cleanly for a missing optional executable', async () => {
  const service=patriciaService({executable:'/nonexistent/patricia'} as never)
  try { await expect(service.propose(fen,50)).rejects.toThrow() } finally { service.close() }
})
