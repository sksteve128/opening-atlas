import { beforeEach, expect, it, vi } from 'vitest'
import { Chess } from 'chess.js'
const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, discover: vi.fn() }))
vi.mock('react', async original => ({ ...(await original<typeof import('react')>()), useState: (v: unknown) => [typeof v === 'function' ? v() : v, vi.fn()], useRef: () => ({ current: null }), useEffect: (fn: () => void | (() => void)) => hooks.effects.push(fn) }))
vi.mock('./planner', async original => ({ ...(await original<typeof import('./planner')>()), discoverPlans: hooks.discover }))
import Planner from './PlannerMode'
const fen = new Chess().fen()
beforeEach(() => { vi.useFakeTimers(); hooks.effects=[]; hooks.discover.mockReset() })
function mount(position = fen, depth = 24) {
  Planner({ fen: position, depth, onPreview: vi.fn() })
  return hooks.effects[0]() as () => void
}
it('debounces rapid navigation and cancels the obsolete position request', async () => {
  hooks.discover.mockImplementation(() => new Promise(() => {}))
  const cancelPending = mount(); await vi.advanceTimersByTimeAsync(200); cancelPending()
  expect(hooks.discover).not.toHaveBeenCalled()
  hooks.effects=[]; const unmount = mount(); await vi.advanceTimersByTimeAsync(350)
  expect(hooks.discover).toHaveBeenCalledOnce()
  expect(hooks.discover.mock.calls[0][1]).toMatchObject({side:'w',depth:24,horizon:2,tolerance:30,response:'strong'})
  const signal = hooks.discover.mock.calls[0][3] as AbortSignal
  unmount(); expect(signal.aborted).toBe(true)
  vi.useRealTimers()
})
it('reuses completed compatible plans after panel remount, but not another depth', async () => {
  hooks.discover.mockResolvedValue({ fen, plans:[{id:'e2e4'}], elapsedMs:10, searches:1, duplicates:0 })
  const cleanup=mount(fen,25); await vi.advanceTimersByTimeAsync(350); cleanup()
  hooks.effects=[]; mount(fen,25); await vi.advanceTimersByTimeAsync(500)
  expect(hooks.discover).toHaveBeenCalledOnce()
  hooks.effects=[]; mount(fen,26); await vi.advanceTimersByTimeAsync(350)
  expect(hooks.discover).toHaveBeenCalledTimes(2)
  vi.useRealTimers()
})
