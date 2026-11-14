import { expect, test } from 'vitest'
import { searchStatus } from './searchStatus'
import type { Evaluation, SearchInfo } from './engine'
const line = (depth: number, search?: Partial<SearchInfo>): Evaluation => ({ depth, cp: 25, line: ['e2e4'], ...(search ? { search: { requestedDepth: 24, achievedDepth: depth, durationMs: 100, queueMs: 0, multiPVComplete: true, endedNaturally: true, stoppedByBudget: false, ...search } } : {}) })
test('search progress, completion and missing results are distinct', () => {
 expect(searchStatus([],24,true).label).toBe('Depth 0/24 ⟳')
 expect(searchStatus([line(21)],24,true).label).toBe('Depth 21/24 ⟳')
 expect(searchStatus([line(24)],24,false).label).toBe('Depth 24/24 ✓')
 expect(searchStatus([],24,false).label).toBe('Unavailable')
 expect(searchStatus([line(24),line(21)],24,false).label).not.toContain('✓')
})
test('budget stops, incomplete MultiPV and cancellation never masquerade as target completion', () => {
 for (const result of [line(18,{stoppedByBudget:true}),line(24,{multiPVComplete:false}),line(24,{cancelled:true})]) expect(searchStatus([result],24,false).label).not.toContain('✓')
 expect(searchStatus([line(18,{stoppedByBudget:true})],24,false).detail).toContain('Time budget reached')
 expect(searchStatus([{...line(26),source:'cloud'}],24,false).detail).toContain('cached Lichess cloud')
 expect(searchStatus([line(24)],24,false).detail).toContain('only')
 expect(searchStatus([line(24)],24,false).detail).toContain('verification')
})
