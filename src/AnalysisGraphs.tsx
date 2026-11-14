import { useId, useMemo } from 'react'
import { Chess } from 'chess.js'
import type { Variation } from './learning'
import { latestSharpness, positionLabel, positions, validPoint, type AnalysisPoint } from './gameAnalysis'

type Props = { line: Variation; current: number; hover: number | null; onHover: (index: number | null) => void; onNavigate: (index: number) => void; running: boolean; progress: string; onAnalyze: (level: 'fast' | 'deep') => void; onCancel: () => void }
const left = 42, width = 600, top = 10, bottom = 100
export function nearestGraphIndex(x: number, count: number) { return Math.max(0, Math.min(count - 1, Math.round((x - left) / (width - left * 2) * (count - 1)))) }
const evaluation = (point?: AnalysisPoint, fen?: string) => fen && new Chess(fen).isCheckmate() ? `Checkmate · ${fen.split(' ')[1] === 'w' ? 'Black' : 'White'} wins` : point?.mate !== undefined ? `M${point.mate > 0 ? '+' : ''}${point.mate}` : point?.cp === undefined ? fen && new Chess(fen).isDraw() ? 'Drawn position · no engine score' : 'Unavailable' : `${point.cp >= 0 ? '+' : ''}${(point.cp / 100).toFixed(2)}`

function Graph({ line, fens, points, current, focus, kind, onNavigate, onFocus }: { line: Variation; fens: string[]; points: (AnalysisPoint | undefined)[]; current: number; focus: number; kind: 'evaluation' | 'sharpness'; onNavigate: (index: number) => void; onFocus: (index: number) => void }) {
  const clipId = useId()
  const labels = fens.map((fen, index) => { const before = (index ? fens[index - 1] : fen).split(' '); return index ? `${before[5]}${before[1] === 'w' ? '.' : '...'}${line.moves[index - 1].san}` : `Start · ${before[5]}${before[1] === 'w' ? '.' : '...'} to move` })
  const x = (index: number) => left + (width - left * 2) * index / Math.max(1, fens.length - 1)
  const dotRadius = Math.max(1.2, Math.min(3.4, (width - left * 2) / Math.max(1, fens.length - 1) * .35))
  const atPointer = (clientX: number, bounds: DOMRect) => nearestGraphIndex((clientX - bounds.left) / bounds.width * width, fens.length)
  const scale = Math.max(300, Math.ceil(Math.max(...points.map(point => point?.mate === undefined ? Math.abs(point?.cp || 0) : 0)) / 100) * 100)
  const y = (value: number) => kind === 'evaluation' ? 55 - 45 * Math.max(-1, Math.min(1, value / scale)) : bottom - value * .9
  const series = kind === 'evaluation' ? [{ key: 'cp' as const, color: '#548532' }] : [{ key: 'white' as const, color: '#b88439' }, { key: 'black' as const, color: '#536c91' }]
  let lastTick = -40
  const ticks = fens.map((fen, index) => ({ index, number: Number(fen.split(' ')[5]), turn: fen.split(' ')[1] })).filter(({ index, number, turn }) => { if (index && (turn !== 'w' || number % 5 !== 0) || x(index) - lastTick < 34) return false; lastTick = x(index); return true })
  return <div className="game-graph"><div className="game-graph-title">{kind === 'evaluation' ? 'EVALUATION · WHITE PERSPECTIVE' : 'POSITION SHARPNESS · DIRECT DECISIONS'}</div><svg viewBox={`0 0 ${width} 128`} role="slider" tabIndex={0} aria-label={kind === 'evaluation' ? 'Stockfish evaluation by position' : 'White and Black positional difficulty by decision point'} aria-valuemin={0} aria-valuemax={fens.length - 1} aria-valuenow={current} aria-valuetext={labels[current]} onPointerMove={event => { if (event.pointerType === 'mouse') onFocus(atPointer(event.clientX, event.currentTarget.getBoundingClientRect())) }} onClick={event => onNavigate(atPointer(event.clientX, event.currentTarget.getBoundingClientRect()))} onKeyDown={event => { const next = event.key === 'ArrowRight' ? current + 1 : event.key === 'ArrowLeft' ? current - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? fens.length - 1 : null; if (next !== null) { event.preventDefault(); onNavigate(Math.max(0, Math.min(fens.length - 1, next))) } }}>
    <defs><clipPath id={`${clipId}-positive`}><rect x={left} y={top} width={width-left*2} height={45}/></clipPath><clipPath id={`${clipId}-negative`}><rect x={left} y={55} width={width-left*2} height={45}/></clipPath></defs>
    <line x1={left} x2={width - left} y1={kind === 'evaluation' ? 55 : bottom} y2={kind === 'evaluation' ? 55 : bottom} stroke="#b8c3b2" strokeDasharray="3 3" />
    {kind === 'sharpness' && <line x1={left} x2={width - left} y1={top} y2={top} stroke="#e1e6de" />}
    {ticks.map(({ index, number }) => <g key={index}><line x1={x(index)} x2={x(index)} y1={top} y2={bottom} stroke="#edf0eb"/><text x={x(index)} y="119" textAnchor="middle">{number}</text></g>)}
    {series.map(({ key, color }) => {
      let previous: number | undefined
      const paths: string[] = [], areas: string[] = []
      points.forEach((point, index) => { const value = point?.[key]; if (value === undefined) { if (kind === 'evaluation' || fens[index].split(' ')[1] === (key === 'white' ? 'w' : 'b')) previous = undefined; return } if (previous !== undefined && index - previous <= (kind === 'evaluation' ? 1 : 2)) { const segment = `M ${x(previous)} ${y(points[previous]![key]!)} L ${x(index)} ${y(value)}`; paths.push(segment); const baseline = kind === 'evaluation' ? 55 : bottom; areas.push(`${segment} L ${x(index)} ${baseline} L ${x(previous)} ${baseline} Z`) } previous = index })
      return <g key={key}>{kind === 'evaluation' ? <><path data-area="white-advantage" d={areas.join(' ')} fill="#548532" fillOpacity="0.24" clipPath={`url(#${clipId}-positive)`}/><path data-area="black-advantage" d={areas.join(' ')} fill="#b85c50" fillOpacity="0.24" clipPath={`url(#${clipId}-negative)`}/></> : <path data-area={key} d={areas.join(' ')} fill={color} fillOpacity="0.2"/>}<path d={paths.join(' ')} fill="none" stroke={color} strokeWidth="2" />{points.map((point, index) => point?.[key] === undefined ? null : <circle key={index} cx={x(index)} cy={y(point[key]!)} r={dotRadius} fill={color} />)}</g>
    })}
    {line.branch && <g aria-label="Generation branch point"><line x1={x(line.branch.ply)} x2={x(line.branch.ply)} y1={top} y2={bottom} stroke="#73a448" strokeDasharray="4 3"/><title>Variation begins · {labels[line.branch.ply]}</title></g>}
    <line x1={x(focus)} x2={x(focus)} y1={top} y2={bottom} stroke="#426329" strokeWidth="1.5" pointerEvents="none" />
    <text x="5" y="15">{kind === 'evaluation' ? `+${scale / 100}` : '100'}</text><text x="5" y="59">{kind === 'evaluation' ? '0' : '50'}</text><text x="5" y="103">{kind === 'evaluation' ? `−${scale / 100}` : '0'}</text>
  </svg></div>
}

export default function GameAnalysis({ line, current, hover, onHover, onNavigate, running, progress, onAnalyze, onCancel }: Props) {
  const fens = useMemo(() => positions(line), [line.startFen, line.moves])
  const points = fens.map((fen, index) => validPoint(line.analysis?.version === 1 ? line.analysis.points[index] : undefined, fen, index))
  const hasMeasurements = points.some(point => point && (point.cp !== undefined || point.white !== undefined || point.black !== undefined))
  const focus = hover ?? current, point = points[focus]
  const conversion = line.recommendation?.conversion, material = conversion?.material.find(p => p.ply === focus)
  return <section className="game-analysis" aria-label="Game Analysis"><div className="game-analysis-head"><strong>GAME ANALYSIS</strong><div>{running ? <button onClick={onCancel}>Cancel</button> : <><button onClick={() => onAnalyze('fast')}>Analyze game</button><button onClick={() => onAnalyze('deep')}>Deep analysis</button></>}</div></div>
    {running && <p role="status">{progress}</p>}
    {!running && !hasMeasurements && <p className="game-graph-empty">Analyze game to plot measured positions.</p>}
    <div className="game-graphs" onMouseLeave={() => onHover(null)}><Graph line={line} fens={fens} points={points} current={current} focus={focus} kind="evaluation" onNavigate={onNavigate} onFocus={onHover}/><Graph line={line} fens={fens} points={points} current={current} focus={focus} kind="sharpness" onNavigate={onNavigate} onFocus={onHover}/></div>
    <div className="game-graph-legend"><span>● White difficulty</span><span>● Black difficulty</span><span>Measured on each side’s turn · gaps mean not measured</span></div>
    <div className="game-graph-detail" aria-live="polite"><strong>{positionLabel(line, focus)}</strong><span>Evaluation: {evaluation(point, fens[focus])}{point?.depth !== undefined ? ` · Depth ${point.depth}` : ''}</span>{(['white', 'black'] as const).map(side => { const decision = latestSharpness(points, focus, side, fens); return <span key={side}>{side === 'white' ? 'White' : 'Black'} difficulty: {decision?.[side] ?? 'Not measured'}{decision && <> · {decision.index === focus ? 'Current decision' : `Decision at ${positionLabel(line, decision.index)}`} · {decision.evaluated !== undefined && decision.legal !== undefined ? `${decision.evaluated}/${decision.legal} legal moves evaluated` : 'Legacy partial sample'}{decision.evaluated !== decision.legal || decision.level === 'fast' || (decision.depth ?? 0) < 12 ? ' · Preliminary' : ''}</>}</span> })}{material && <span>Material: White {material.white}, Black {material.black} · {line.side} net gain {material.gain} · {material.event}</span>}{conversion?.detectedPly === focus && <span>Advantage detected</span>}{focus === line.moves.length && <span>{line.termination}</span>}{point && <span>{point.level === 'fast' || (point.depth ?? 0) < 12 || point.evaluated !== point.legal ? 'Preliminary' : 'Deep'}</span>}</div>
  </section>
}
