import { Chess } from 'chess.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { Variation } from './learning'
import { CurrentLineSummary, currentLineStatus } from './CurrentLineSummary'
import { opponentProvenance } from './repertoireSummary'

function saved(sources: Variation['moves'][number]['source'][] = ['engine', 'lichess', 'engine', 'lichess']): Variation {
  const game = new Chess(); game.loadPgn('1. e4 e5 2. Nf3 Nc6')
  return { id: 'line', name: 'Test variation', opening: 'Test', startFen: new Chess().fen(), moves: game.history({ verbose: true }).map((move, index) => ({ san: move.san, uci: move.from + move.to, source: sources[index] })), pgn: game.pgn(), side: 'white', database: 'lichess', filters: { ratings: [], speeds: [] }, created: Date.parse('2026-10-20T12:00:00-07:00'), endPosition: game.fen(), fallback: false, status: 'favorable', termination: 'Advantage secured', stats: { firstTry: 0, errors: 0, reveals: 0, completions: 0, totalMs: 0 }, recommendation: { verification: 'pending', policy: 'simple', objectiveCp: 230, depth: 18, evaluationPly: 4 } }
}

test('compact Current Line has one opponent, result, and evaluation summary', () => {
  const line = saved()
  const html = renderToStaticMarkup(<CurrentLineSummary line={line} memorized={0} target={5} attempts={2}/> )
  expect(html).toContain('For White · 2 moves · Oct 20, 2026')
  expect(html).toContain('Opponent: Lichess throughout')
  const visible = html.replace(/<[^>]*>/g, '')
  expect(visible.match(/Opponent:/g)).toHaveLength(1)
  expect(visible.match(/Advantage appears secured/g)).toHaveLength(1)
  expect(html).toContain('Current evaluation: White +2.30')
  expect(html).toContain('Endpoint: Advantage appears secured · Preliminary')
  expect(html).toContain('Deep verification: Not performed')
  expect(html).toContain('Preliminary')
  expect(html).toContain('Memorized 0/5 · Attempts 2')
  expect(html).not.toContain('Generated from move')
  expect(html).not.toContain('Style:')
})

test('Maia transition and fallback use the same cached summary as playlist and repertoire', () => {
  const line = saved(['engine', 'lichess', 'engine', 'model'])
  line.recommendation!.populationAttempts = [{ ply: 3, database: 'lichess', ratings: [], speeds: [], tier: 'selected', issue: 'rate-limit', error: 'HTTP 429' }]
  const html = renderToStaticMarkup(<CurrentLineSummary line={line} memorized={0} target={5} attempts={0}/> )
  expect(html).toContain(opponentProvenance(line).label)
  expect(html).toContain('Lichess → Maia from 2...Nc6')
  expect(html).toContain('Explorer rate limited')
})

test('missing data and verified evidence are displayed without inferred source or date', () => {
  const line = saved(['import', 'import', 'import', 'import'])
  line.created = NaN
  line.recommendation = { ...line.recommendation!, verification: 'passed', verificationScope: 'deep', depth: 26, configuration: { candidateDepth: 18, verificationDepth: 24, timeoutMs: 10000 } }
  const html = renderToStaticMarkup(<CurrentLineSummary line={line} memorized={1} target={5} attempts={3}/> )
  expect(html).toContain('Date unavailable')
  expect(html).toContain('Opponent source unavailable')
  expect(html).toContain('Verification: Complete · Stockfish depth 26')
  expect(html).toContain('Endpoint: Advantage appears secured · Preliminary')
  expect(html).not.toContain('No Maia used')
})

test('endpoint wording distinguishes sound, stopped, incomplete, and completed lines', () => {
  const line = saved()
  expect(currentLineStatus({ ...line, termination: 'Sound middlegame reached' })).toBe('Sound middlegame reached')
  expect(currentLineStatus({ ...line, termination: 'Cancelled' })).toBe('Generation stopped')
  expect(currentLineStatus({ ...line, termination: '', status: 'incomplete' })).toBe('Incomplete')
  expect(currentLineStatus({ ...line, termination: '', status: 'complete' })).toBe('Completed game')
})

test('default summary is compact while verification and technical provenance remain in closed details', () => {
 const html = renderToStaticMarkup(<CurrentLineSummary line={saved(['engine','lichess','engine','model'])} memorized={2} target={5} attempts={3}/>)
 const front = html.split('<details')[0]
 expect(front).toContain('White · 2 moves · +2.30')
 expect(front).toContain('Lichess → Maia from 2...Nc6')
 expect(front).not.toContain('Preliminary')
 expect(html).toContain('<details class="line-summary-details">')
 expect(html).toContain('Line details · Memorized 2/5')
 expect(html).toContain('Deep verification not established')
 expect(html).toContain('Test</p>')
})

test('all opponent transitions are shown from actual move positions without changing historical records',()=>{
 const line=saved(['engine','lichess','engine','engine']);const before=JSON.stringify(line)
 const html=renderToStaticMarkup(<CurrentLineSummary line={line} memorized={0} target={5} attempts={0}/>)
 expect(html).toContain('Opponent moves: Lichess · 1...e5')
 expect(html).toContain('Opponent moves: Stockfish · 2...Nc6')
 expect(html).toContain('Selection completeness unavailable')
 expect(JSON.stringify(line)).toBe(before)
})
