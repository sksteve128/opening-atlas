import { afterEach, expect, test, vi } from 'vitest'
import { backgroundGeneration, pendingGeneration } from './backgroundGeneration'
import type { Generation, Variation } from './learning'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function storage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
}
const options = { seed: 42 } as Generation, line = { id: 'saved-line', moves: [] } as unknown as Variation
const done = () => new Response(JSON.stringify({ status: 'complete', revision: 2, phase: 'Saved', line, evaluations: {} }))
test('reload reattaches by job ID without restarting or changing options', async () => {
  storage()
  const job = { id: crypto.randomUUID(), options }, request = vi.fn(async () => done()), progress = vi.fn()
  vi.stubGlobal('fetch', request)
  expect(await backgroundGeneration(options, [], new AbortController().signal, progress, job)).toEqual(line)
  expect(request).toHaveBeenCalledTimes(1)
  expect(request.mock.calls[0]).toEqual([`/api/generation/${job.id}`, { signal: expect.any(AbortSignal) }])
  expect(progress).toHaveBeenCalledWith('Saved', line, {}, undefined)
  expect(pendingGeneration()).toBeUndefined()
})
test('lost start response retries same job and explicit Stop cancels the server job', async () => {
  storage(); vi.useFakeTimers()
  const controller = new AbortController(), progress = vi.fn()
  const request = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(new Response(JSON.stringify({ status: 'running', revision: 0, phase: 'Working', evaluations: {} })))
  vi.stubGlobal('fetch', request)
  const running = backgroundGeneration(options, [], controller.signal, progress)
  const result = expect(running).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(1600)
  expect(request.mock.calls[0][0]).toBe(request.mock.calls[1][0])
  expect(JSON.parse(request.mock.calls[1][1].body).options.seed).toBe(42)
  expect(pendingGeneration()?.options.seed).toBe(42)
  controller.abort()
  await vi.advanceTimersByTimeAsync(1000); await result
  expect(request.mock.calls.at(-1)?.[1].method).toBe('DELETE')
  expect(pendingGeneration()).toBeUndefined()
})

test('delivers incoming analysis even when the generated line has not changed', async () => {
  storage(); vi.useFakeTimers()
  const shallow = [{ cp: 20, depth: 8, line: ['e2e4'] }], deep = [{ cp: 25, depth: 16, line: ['e2e4', 'e7e5'] }]
  const response = (revision: number, analyses: unknown, status = 'running') => new Response(JSON.stringify({ status, revision, phase: 'Searching', line, evaluations: {}, analyses }))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(1, { position: shallow })).mockResolvedValueOnce(response(2, { position: deep }, 'complete')))
  const progress = vi.fn(), running = backgroundGeneration(options, [], new AbortController().signal, progress)
  await vi.advanceTimersByTimeAsync(800)
  await running
  expect(progress.mock.calls[0][1]).toEqual(line)
  expect(progress.mock.calls[1][1]).toBeUndefined()
  expect(progress.mock.calls[1][3]).toEqual({ position: deep })
})
