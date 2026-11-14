import { expect, test } from 'vitest'
import { Chess } from 'chess.js'
import type { Variation } from './learning'
import { measuredPoint, positions } from './gameAnalysis'
import { repertoireDate, repertoireEvaluation, repertoireOutcome } from './repertoireSummary'
const line = { side: 'black', startFen: new Chess().fen(), moves: [{ uci: 'e2e4', san: 'e4' }], created: Date.UTC(2026, 9, 19, 12) } as Variation
const point = (index: number, cp = -1145, mate?: number) => ({ ...measuredPoint(positions(line)[index], index, [], 'fast'), cp, mate, depth: 18 })
test('saved evaluation perspective, signed scores and mate are display-only', () => {
  const saved = { ...line, analysis: { version: 1 as const, points: [null, point(1)] } }
  const before = JSON.stringify(saved)
  expect(repertoireEvaluation(saved)).toMatchObject({ score: 'Black +11.45', provenance: 'Final', quality: 'Preliminary', depth: 18 })
  expect(repertoireEvaluation({ ...saved, side: 'white' })?.score).toBe('White -11.45')
  expect(repertoireEvaluation({ ...saved, analysis: { version: 1, points: [point(0, 80)] } })).toMatchObject({ score: 'Black -0.80', provenance: 'Latest' })
  expect(repertoireEvaluation({ ...saved, analysis: { version: 1, points: [point(1, 99999, -3)] } })?.score).toBe('Black +M3')
  expect(JSON.stringify(saved)).toBe(before)
})
test('missing or mismatched evidence never becomes a final evaluation', () => {
  expect(repertoireEvaluation(line)).toBeUndefined()
  expect(repertoireEvaluation({ ...line, analysis: { version: 1, points: [{ ...point(1), fen: 'wrong' }] } })).toBeUndefined()
  expect(repertoireEvaluation({ ...line, recommendation: { verification: 'pending', objectiveCp: 115, depth: 18 } })).toMatchObject({ provenance: 'Saved', score: 'Black +1.15', quality: 'Preliminary' })
  expect(repertoireEvaluation({ ...line, sideUnconfirmed: true, analysis: { version: 1, points: [point(1)] } })).toBeUndefined()
})
test('dates use persisted timestamps and outcomes use actual saved metadata', () => {
  expect(repertoireDate(line.created)).toBe('Oct 19, 2026')
  expect(repertoireDate()).toBeUndefined()
  expect(repertoireDate(NaN)).toBeUndefined()
  expect(repertoireOutcome(line)).toBe('Unresolved')
  expect(repertoireOutcome({ ...line, result: '1/2-1/2' })).toBe('Draw')
  expect(repertoireOutcome({ ...line, termination: 'Checkmate' })).toBe('Checkmate')
})
test('deep verification labels require both saved verification evidence and achieved depth', () => {
  const saved = { ...line, recommendation: { verification: 'passed' as const, verificationScope: 'deep' as const, depth: 24, objectiveCp: 100, configuration: { candidateDepth: 18, verificationDepth: 24, timeoutMs: 30000 } } }
  expect(repertoireEvaluation(saved)?.quality).toBe('Deeply verified')
  expect(repertoireEvaluation({ ...saved, analysis: { version: 1, points: [point(1)] } })?.quality).toBe('Preliminary')
  expect(repertoireEvaluation({ ...saved, recommendation: { ...saved.recommendation, preliminary: true } })?.quality).toBe('Preliminary')
})
