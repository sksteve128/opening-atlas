import { expect, test } from 'vitest'
// @ts-expect-error Node adapter is deliberately plain JavaScript.
import { EngineWorker, cleanup } from './stockfish-process.mjs'
test('unexpected Stockfish death reports failure without taking down generation; intentional termination is quiet', async () => {
  const worker = new EngineWorker(), messages: string[] = []
  let error: Error | undefined
  worker.addEventListener('message', ({ data }: { data: string }) => messages.push(data))
  worker.onerror = (value: Error) => { error = value }
  worker.process.kill('SIGKILL')
  await new Promise(resolve => worker.process.once('close', resolve))
  worker.postMessage('stop') // The former unhandled EPIPE path.
  expect(error?.message).toContain('SIGKILL')
  expect(messages.some(line => line.startsWith('info string CRITICAL ERROR'))).toBe(true)
  const stopped = new EngineWorker()
  let unexpected = false
  stopped.onerror = () => { unexpected = true }
  stopped.terminate()
  await new Promise(resolve => stopped.process.once('close', resolve))
  expect(unexpected).toBe(false)
  cleanup()
})
