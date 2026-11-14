import { useMemo, useState } from 'react'
import type { Variation } from './learning'
import { moveNumber } from './learning'
import { positions, positionEvaluation, validPoint } from './gameAnalysis'
import { cachedAnalysis } from './engine'
import { generationProvenance } from './generationProvenance'
import { StableBoard, GhostPieces, ghostArrowOptions } from './StableBoard'
import { MovementOverlay, TraceControls } from './MovementTrace'
import type { PlanPreview } from './PlannerMode'
import { EvaluationBar, evaluationLabel } from './EvaluationBar'
import type { Side } from './core'
import './planner.css'

export const previewStart = (line: Variation) => generationProvenance(line).boundary ?? 0

export function RepertoirePreview({ line, ply, orientation, navigate }: { line: Variation; ply: number; orientation: Side; navigate: (ply: number) => void }) {
  const fens = useMemo(() => positions(line), [line])
  const fen = fens[ply]
  const [showPlan, setShowPlan] = useState(false)
  const [preview, setPreview] = useState<PlanPreview | null>(null)
  const active = showPlan && preview?.fen === fen ? preview : null
  const moves = useMemo(() => line.moves.slice(ply).map(move => move.uci), [line, ply])
  const cached = cachedAnalysis(fen, 1, 1)?.[0]
  const point = validPoint(line.analysis?.points[ply], fen, ply)
  const evaluation = positionEvaluation(fen, ply, line.moves[ply], point, undefined, undefined, cached)
  const depth = cached?.depth ?? (point?.cp !== undefined ? point.depth : line.moves[ply]?.depth)
  const provenance = useMemo(() => generationProvenance(line), [line])
  const start = provenance.boundary ?? 0
  const next = line.moves[ply]?.uci
  return <div className="rep-preview-content" tabIndex={0} aria-label="Interactive line preview" onKeyDown={event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || (event.target as HTMLElement).closest('.trace-controls')) return
    const target = event.key === 'ArrowLeft' ? ply - 1 : event.key === 'ArrowRight' ? ply + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? line.moves.length : undefined
    if (target !== undefined) { event.preventDefault(); navigate(Math.max(0, Math.min(line.moves.length, target))) }
  }}>
    <p className="rep-evaluation">{evaluation ? `Stockfish ${evaluationLabel(evaluation)}${depth === undefined ? '' : ` · Depth ${depth}`} · White perspective` : 'Not analyzed'}</p>
    <div className="rep-board board-row"><EvaluationBar evaluation={evaluation} orientation={orientation}/><div className="learn-board">
      <StableBoard options={{ position: active?.full ? active.future : active?.baseline || fen, boardOrientation: orientation, allowDragging: false, animationDurationInMs: 0, boardStyle: {borderRadius: 8}, lightSquareStyle: { backgroundColor: '#f0d9b5' }, darkSquareStyle: { backgroundColor: '#b58863' }, arrowOptions: ghostArrowOptions, arrows: active ? active.arrows : next ? [{startSquare:next.slice(0,2),endSquare:next.slice(2,4),color:'#329c9c99'}] : [] }}/>
      {active && !active.full && <GhostPieces changed={active.changed} orientation={orientation}/>}
      {active?.movement && <MovementOverlay state={active.movement} orientation={orientation}/>}
    </div></div>
    <div className="rep-navigation" aria-label="Position navigation"><button disabled={!ply} onClick={() => navigate(0)}>Start</button><button aria-label="Previous move" disabled={!ply} onClick={() => navigate(ply-1)}>←</button><span>{ply ? moveNumber(fens[ply-1],line.moves[ply-1].san) : 'Start'} · {ply}/{line.moves.length}</span><button aria-label="Next move" disabled={ply >= line.moves.length} onClick={() => navigate(ply+1)}>→</button><button disabled={ply >= line.moves.length} onClick={() => navigate(line.moves.length)}>End</button></div>
    <div className="rep-actions"><button disabled={ply === start} onClick={() => navigate(start)}>{provenance.boundary === undefined ? 'Earliest saved position' : 'Generation start'}</button><button aria-pressed={showPlan} disabled={!moves.length} onClick={() => setShowPlan(!showPlan)}>Show plan</button></div>
    {showPlan && !!moves.length && <TraceControls source="saved" key={line.id + ':' + ply} fen={fen} moves={moves} onPreview={setPreview}/>}
    <div className="rep-history" aria-label="Saved line moves">{line.moves.map((move,i) => <button key={i} aria-current={ply === i+1 ? 'step' : undefined} onClick={() => navigate(i+1)}>{moveNumber(fens[i],move.san)}</button>)}</div>
  </div>
}
