import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Chess } from 'chess.js'
import GameAnalysis from './AnalysisGraphs'
import { measuredPoint, positions } from './gameAnalysis'
import type { Variation } from './learning'

it('shades evaluations and both sharpness curves while leaving missing measurements as gaps', () => {
  const game = new Chess(), startFen = game.fen()
  const moves = ['e4', 'e5', 'Nf3', 'Nc6'].map(san => { const move = game.move(san); return { uci: move.from + move.to, san } })
  const line = { startFen, moves } as Variation
  const fens = positions(line)
  const points = fens.map((fen, index) => measuredPoint(fen, index, new Chess(fen).moves({ verbose: true }).map((move, rank) => ({ cp: (index % 2 ? -50 : 100) - rank * 30, depth: 8, line: [move.from + move.to] })), 'fast'))
  const render = (points: (ReturnType<typeof measuredPoint> | null)[]) => renderToStaticMarkup(<GameAnalysis line={{ ...line, analysis: { version: 1, points } }} current={1} hover={null} onHover={vi.fn()} onNavigate={vi.fn()} running={false} progress="" onAnalyze={vi.fn()} onCancel={vi.fn()}/> )
  const html = render(points)
  for (const area of ['white-advantage', 'black-advantage', 'white', 'black']) expect(html).toMatch(new RegExp(`data-area="${area}" d="M [^"]+ Z`))
  expect(html).toContain('White difficulty:')
  expect(html).toContain('Decision at Start')
  expect(html).toContain('legal moves evaluated')
  const gaps = render([points[0], null, null, null, points[4]])
  expect(gaps).toContain('data-area="white" d=""')
  expect(gaps).toContain('data-area="white-advantage" d=""')
})
