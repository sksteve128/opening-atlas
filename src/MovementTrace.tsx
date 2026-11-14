import { useEffect, useMemo, useState } from 'react'
import { Chess, type Move, type Square } from 'chess.js'
import { materialBalance } from './MaterialCount'
import type { PlanPreview } from './PlannerMode'

export type TracedPiece = { id: string; color: string; type: string; start: string; square: string | null }
export type TraceMove = { ply: number; san: string; label: string; side: string; piece: string; id: string; from: string; to: string; captured?: TracedPiece; captureSquare?: string; check: boolean; checkSquare?: string; mate: boolean; promotion?: string; castle: boolean; nominalBalance: number; fen: string; move: Move }
export type Segment = { ply: number; id: string; from: string; to: string; priority: number }
export type MovementTrace = ReturnType<typeof traceMoves>
export function traceMoves(fen: string, moves: string[]) {
  const game = new Chess(fen), pieces = new Map<string, TracedPiece>(), occupants = new Map<string, string>()
  for (const row of game.board()) for (const piece of row) if (piece) {
    const id = `${piece.color}${piece.type}@${piece.square}`
    pieces.set(id, { id, color: piece.color, type: piece.type, start: piece.square, square: piece.square }); occupants.set(piece.square, id)
  }
  const trace: TraceMove[] = [], segments: Segment[] = []
  let invalidAt: number | undefined
  let nominalBalance = materialBalance(fen).score
  for (const uci of moves) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) { invalidAt = trace.length + 1; break }
    let move: Move
    try { move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }) } catch { invalidAt = trace.length + 1; break }
    const id = occupants.get(move.from)!, piece = pieces.get(id)!, ply = trace.length + 1
    const captureSquare = move.captured ? move.isEnPassant() ? `${move.to[0]}${move.from[1]}` : move.to : undefined
    const captured = captureSquare ? pieces.get(occupants.get(captureSquare)!) : undefined
    const capturedSnapshot = captured ? { ...captured } : undefined
    if (captured) { captured.square = null; occupants.delete(captureSquare!) }
    occupants.delete(move.from); occupants.set(move.to, id); piece.square = move.to; piece.type = move.promotion || piece.type
    const castle = move.isKingsideCastle() || move.isQueensideCastle()
    const mate = game.isCheckmate(), check = game.isCheck()
    const number = Number(move.before.split(' ')[5])
    nominalBalance += ((move.captured ? values[move.captured] : 0) + (move.promotion ? values[move.promotion] - 1 : 0)) * (move.color === 'w' ? 1 : -1)
    trace.push({ ply, san: move.san, label: `${number}${move.color === 'w' ? '.' : '...'}${move.san}`, side: move.color, piece: move.piece, id, from: move.from, to: move.to, captured: capturedSnapshot, captureSquare, check, checkSquare: check ? game.board().flat().find(p => p?.type === 'k' && p.color !== move.color)?.square : undefined, mate, promotion: move.promotion, castle, nominalBalance, fen: game.fen(), move })
    // Visual salience only: this is not a tactical evaluation or engine ranking.
    const priority = captured || check || move.promotion ? 3 : move.piece === 'p' && Math.abs(Number(move.to[1]) - Number(move.from[1])) === 2 ? 3 : castle || move.piece === 'k' || ('nb'.includes(move.piece) && /[18]/.test(move.from[1])) ? 2 : 1
    segments.push({ ply, id, from: move.from, to: move.to, priority })
    if (castle) {
      const from = `${move.isKingsideCastle() ? 'h' : 'a'}${move.from[1]}`, to = `${move.isKingsideCastle() ? 'f' : 'd'}${move.from[1]}`
      const rookId = occupants.get(from)!, rook = pieces.get(rookId)!
      occupants.delete(from); occupants.set(to, rookId); rook.square = to
      segments.push({ ply, id: rookId, from, to, priority: 2 })
    }
  }
  const visits = new Map<string, Set<string>>()
  for (const segment of segments) { const squares = visits.get(segment.id) || new Set<string>(); squares.add(segment.from); squares.add(segment.to); visits.set(segment.id, squares) }
  for (const segment of segments) if (visits.get(segment.id)!.size > 2) segment.priority = Math.max(segment.priority, 2)
  const ghosts = [...pieces.values()].filter(piece => piece.square && (piece.square !== piece.start || piece.type !== piece.id[1])).map(piece => ({ square: piece.square! as Square, piece: piece.color + piece.type.toUpperCase(), id: piece.id }))
  return { fen, moves: trace, segments, pieces: [...pieces.values()], ghosts, invalidAt, finalFen: game.fen() }
}
export function squarePoint(square: string, orientation: 'white' | 'black') {
  const file = square.charCodeAt(0) - 97, rank = Number(square[1]) - 1
  return { x: (orientation === 'white' ? file : 7 - file) * 12.5 + 6.25, y: (orientation === 'white' ? 7 - rank : rank) * 12.5 + 6.25 }
}
const names: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }
const sideName = (side: string) => side === 'w' ? 'White' : 'Black'
export function moveDescription(move: TraceMove) {
  return `${move.label} · ${sideName(move.side)} ${names[move.piece]}: ${move.from} → ${move.to}${move.captured ? ` · captures ${sideName(move.captured.color)} ${names[move.captured.type]} on ${move.captureSquare} (+${values[move.captured.type]} nominal); material balance ${move.nominalBalance > 0 ? '+' : ''}${move.nominalBalance} for White` : ''}${move.promotion ? ` · promotes to ${names[move.promotion]}` : ''}${move.mate ? ' · checkmate' : move.check ? ' · check' : ''}`
}
export type TraceOverlayState = { trace: MovementTrace; all: boolean; focus: number | null; selected: number | null; onHover: (ply: number | null) => void; onSelect: (ply: number) => void }
export const MOVE_MARKER_RADIUS = 1.9375
export function markerPosition(from: string, to: string, orientation: 'white' | 'black', index: number, placed: { x: number; y: number }[] = []) {
  const a = squarePoint(from, orientation), b = squarePoint(to, orientation)
  const length = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / length, uy = (b.y - a.y) / length
  const offset = (index % 3 - 1) * 0.8
  const middleX = (a.x + b.x) / 2 - uy * offset, middleY = (a.y + b.y) / 2 + ux * offset
  const preferredX = Math.abs(middleX % 12.5 - 6.25) < 4 ? Math.round(middleX / 12.5) * 12.5 : middleX
  const margin = MOVE_MARKER_RADIUS + 0.3, clamp = (n: number) => Math.max(margin, Math.min(100 - margin, n))
  // Four-ply stages have few markers; try nearby offsets before accepting any overlap.
  const candidates = [0, 4.5, -4.5, 9, -9].map(shift => ({ x: clamp(preferredX + ux * shift), y: clamp(middleY + uy * shift) }))
  return candidates.find(point => placed.every(other => Math.hypot(point.x - other.x, point.y - other.y) >= MOVE_MARKER_RADIUS * 2 + 0.4)) || candidates[0]
}
export function MovementOverlay({ state, orientation }: { state: TraceOverlayState; orientation: 'white' | 'black' }) {
  const { trace, all, focus, selected, onHover, onSelect } = state
  const emphasized = new Set([...trace.segments].sort((a, b) => b.priority - a.priority || a.ply - b.ply).slice(0, 7))
  const ids = new Set([...emphasized].map(segment => segment.id))
  const shown = trace.segments.filter(segment => all || ids.has(segment.id) || segment.ply === focus || segment.ply === selected)
  const markers = new Map<string, TraceMove[]>()
  for (const move of trace.moves) {
    if (move.captureSquare) markers.set(move.captureSquare, [...(markers.get(move.captureSquare) || []), move])
    if (move.checkSquare && move.checkSquare !== move.captureSquare) markers.set(move.checkSquare, [...(markers.get(move.checkSquare) || []), move])
  }
  const placed: { x: number; y: number }[] = []
  const focused = trace.moves.find(move => move.ply === (focus ?? selected))
  return <svg className="movement-overlay" viewBox="0 0 100 100" aria-label="Chronological movement paths">
    {focused && [focused.from, focused.to].map(square => { const point = squarePoint(square, orientation); return <rect key={square} x={point.x - 6.25} y={point.y - 6.25} width="12.5" height="12.5" fill="#e2a447" opacity=".3"/> })}
    {shown.map((segment, index) => {
      const a = squarePoint(segment.from, orientation), b = squarePoint(segment.to, orientation), move = trace.moves.find(move => move.ply === segment.ply)!
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy), ux = dx / length, uy = dy / length
      const end = { x: b.x - ux * 3, y: b.y - uy * 3 }, active = segment.ply === focus || segment.ply === selected
      const { x, y } = markerPosition(segment.from, segment.to, orientation, index, placed)
      placed.push({ x, y })
      const color = move.side === 'w' ? '#007c83' : '#733fa0'
      const description = segment.id === move.id ? moveDescription(move) : `${move.label} · ${sideName(move.side)} rook: ${segment.from} → ${segment.to} · castling`
      return <g key={`${segment.ply}-${segment.id}`} data-piece-id={segment.id} data-ply={segment.ply} opacity={active ? 1 : emphasized.has(segment) ? 0.7 : 0.28}>
        <path d={`M${a.x},${a.y} L${end.x},${end.y}`} stroke={color} strokeWidth={active ? 0.88 : 0.47} fill="none"/>
        <path d={`M${end.x - ux * 2.43 - uy * 1.35},${end.y - uy * 2.43 + ux * 1.35} L${end.x},${end.y} L${end.x - ux * 2.43 + uy * 1.35},${end.y - uy * 2.43 - ux * 1.35}`} stroke={color} strokeWidth="0.61" fill="none"/>
        <g className="movement-hit" role="button" tabIndex={0} aria-label={description} aria-pressed={selected === segment.ply} onMouseEnter={() => onHover(segment.ply)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(segment.ply)} onBlur={() => onHover(null)} onClick={() => onSelect(segment.ply)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(segment.ply) } }}>
          <title>{description}</title><path d={`M${x - ux * 2.5},${y - uy * 2.5} L${x + ux * 2.5},${y + uy * 2.5}`} stroke="transparent" strokeWidth="1.5"/><circle cx={x} cy={y} r={MOVE_MARKER_RADIUS} fill={color}/><text x={x} y={y} dominantBaseline="central" textAnchor="middle" fill="white" fontSize="2.25">{segment.ply}</text>
        </g>
      </g>
    })}
    {[...markers].map(([square, moves]) => { const point = squarePoint(square, orientation); const captures = moves.filter(move => move.captureSquare === square); const label = `${captures.length ? `×${captures.length > 1 ? captures.length : ''}` : ''}${moves.some(move => move.mate) ? '#' : moves.some(move => move.check) ? '+' : ''}`
      return <g key={square} className="movement-hit" role="button" tabIndex={0} aria-label={moves.map(moveDescription).join('; ')} onMouseEnter={() => onHover(moves[0].ply)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(moves[0].ply)} onBlur={() => onHover(null)} onClick={() => onSelect(moves.find(move => move.ply > (selected || 0))?.ply || moves[0].ply)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(moves.find(move => move.ply > (selected || 0))?.ply || moves[0].ply) } }}><title>{moves.map(moveDescription).join('\n')} · Select repeatedly to cycle events</title><rect x={point.x - 5.6} y={point.y - 5.7} width="4.8" height="2.8" rx="0.6" fill={moves.some(move => move.ply === focus || move.ply === selected) ? '#007c83' : '#733f31'}/><text x={point.x - 3.2} y={point.y - 3.6} textAnchor="middle" fontSize="2.3" fill="white">{label}</text></g>
    })}
  </svg>
}

export const STAGE_PLIES = 4
export const VISUALIZATION_HORIZONS = [1, 2, 3, 4, 5] as const
export function visualizationMoves() {
  try { const value = JSON.parse(localStorage.getItem('atlas-planner') || '{}')?.visualizationMoves; return VISUALIZATION_HORIZONS.includes(value) ? value as number : 3 } catch { return 3 }
}
export function saveVisualizationMoves(value: number) {
  if (!VISUALIZATION_HORIZONS.some(option => option === value)) return
  try { const preferences = JSON.parse(localStorage.getItem('atlas-planner') || '{}'); localStorage.setItem('atlas-planner', JSON.stringify({ ...preferences, visualizationMoves: value })) } catch { /* The control still works for this session. */ }
}
export function stageBounds(length: number, stage: number, plies = STAGE_PLIES) {
  const count = Math.max(1, Math.ceil(length / plies)), index = Math.max(0, Math.min(stage, count - 1))
  return { stage: index, count, start: index * plies, end: Math.min(length, (index + 1) * plies) }
}
export function stageTrace(fen: string, moves: string[], stage: number, plies = STAGE_PLIES) {
  const bounds = stageBounds(moves.length, stage, plies)
  const before = traceMoves(fen, moves.slice(0, bounds.start)), after = traceMoves(fen, moves.slice(0, bounds.end))
  const initial = new Map(before.pieces.map(piece => [piece.id, piece]))
  return { ...after, fen: before.finalFen, moves: after.moves.filter(move => move.ply > bounds.start), segments: after.segments.filter(segment => segment.ply > bounds.start), ghosts: after.pieces.filter(piece => piece.square && (piece.square !== initial.get(piece.id)?.square || piece.type !== initial.get(piece.id)?.type)).map(piece => ({ id: piece.id, square: piece.square! as Square, piece: piece.color + piece.type.toUpperCase() })) }
}
const values: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
export function materialLedger(trace: MovementTrace, ply: number) {
  const captures = { w: [] as string[], b: [] as string[] }, lost = { w: [] as string[], b: [] as string[] }, promotions = { w: 0, b: 0 }
  for (const move of trace.moves.slice(0, ply)) {
    const side = move.side as 'w' | 'b', opponent = side === 'w' ? 'b' : 'w'
    if (move.captured) { captures[side].push(move.captured.type); lost[opponent].push(move.captured.type) }
    if (move.promotion) promotions[side] += values[move.promotion] - 1
  }
  const gain = (side: 'w' | 'b') => captures[side].reduce((n,p) => n + values[p], 0) - lost[side].reduce((n,p) => n + values[p], 0) + promotions[side] - promotions[side === 'w' ? 'b' : 'w']
  return { captures, lost, promotions, gain: gain('w'), balance: trace.moves[ply - 1]?.nominalBalance ?? materialBalance(trace.fen).score }
}
export function tacticalEvents(trace: MovementTrace) {
  const capturedAt = new Map(trace.moves.filter(move => move.captured).map(move => [move.captured!.id, move]))
  let deficit = 0, materialChange = 0
  return trace.moves.map((move, index) => {
    const events: string[] = [], previous = trace.moves[index - 1]
    if (move.captured) events.push(`Captures ${names[move.captured.type]}`)
    if (move.captured && previous?.captured && move.to === previous.to && move.captured.id === previous.id) {
      events.push('Recapture')
      if (move.captured.type === 'r' && 'nb'.includes(previous.captured.type)) events.push(`${sideName(previous.side)} exchanges rook for ${names[previous.captured.type]} (exchange sacrifice)`)
    }
    if (move.captured?.type === 'r' && 'nb'.includes(move.piece)) {
      const recovery = capturedAt.get(move.id)
      if (recovery) events.push(`${sideName(move.captured.color)} loses rook for ${names[move.piece]} recovered at ${recovery.label} (exchange sacrifice in PV; soundness not established)`)
    }
    if (move.promotion) events.push(`Promotion to ${names[move.promotion]}`)
    if (move.mate) events.push('Checkmate'); else if (move.check) events.push('Check')
    materialChange += ((move.captured ? values[move.captured.type] : 0) + (move.promotion ? values[move.promotion] - 1 : 0)) * (move.side === 'w' ? 1 : -1)
    const gain = materialChange * (trace.fen.split(' ')[1] === 'w' ? 1 : -1)
    if (deficit < 0 && gain >= 0) events.push('Nominal material recovered for starting side')
    deficit = gain
    return events
  })
}
export function reconcilePreview(oldMoves: string[], moves: string[], stage: number, selected: number | null, plies = STAGE_PLIES) {
  const bounds = stageBounds(moves.length, stage, plies)
  const compatible = selected !== null && selected <= moves.length && oldMoves.slice(0, selected).every((move, i) => move === moves[i])
  return { stage: bounds.stage, selected: compatible && selected! >= bounds.start && selected! <= bounds.end ? selected : null }
}
export function TraceControls({ fen, moves, onPreview, speed = 1, source = 'engine' }: { fen: string; moves: string[]; speed?: number; source?: 'engine' | 'saved'; onPreview: (preview: PlanPreview | null) => void }) {
  const [horizon, setHorizon] = useState(visualizationMoves)
  const plies = STAGE_PLIES
  const sequence = moves.join(' ')
  const fullTrace = useMemo(() => traceMoves(fen, sequence ? sequence.split(' ') : []), [fen, sequence])
  const trace = useMemo(() => traceMoves(fen, moves.slice(0, Math.min(fullTrace.moves.length, horizon * 2))), [fen, sequence, fullTrace, horizon])
  const legalMoves = useMemo(() => moves.slice(0, trace.moves.length), [sequence, trace])
  const [mode, setMode] = useState<'Formation' | 'Movement paths' | 'Step through'>('Movement paths')
  const [all, setAll] = useState(false), [storedSelected, setSelected] = useState<number | null>(null), [storedHover, setHover] = useState<number | null>(null)
  const [stage, setStage] = useState(0), [playing, setPlaying] = useState(false)
  const [previousSequence, setPreviousSequence] = useState(sequence)
  const next = reconcilePreview(previousSequence.split(' '), legalMoves, stage, storedSelected, plies)
  const selected = previousSequence !== sequence ? next.selected : storedSelected
  const hover = previousSequence !== sequence ? null : storedHover
  if (previousSequence !== sequence) {
    setPreviousSequence(sequence); setStage(next.stage); setSelected(next.selected); setHover(null); setPlaying(false)
    if (next.selected === null && mode === 'Step through') setMode('Movement paths')
  }
  const bounds = stageBounds(trace.moves.length, stage, plies)
  const overview = selected === null
  const ply = selected ?? bounds.start
  const staged = useMemo(() => stageTrace(fen, legalMoves, bounds.stage, plies), [fen, legalMoves, bounds.stage, plies])
  const events = useMemo(() => tacticalEvents(trace), [trace])
  const ledger = materialLedger(trace, overview ? bounds.end : ply)
  const select = (value: number) => { setPlaying(false); setStage(value ? Math.floor((value - 1) / plies) : 0); setSelected(value); setHover(null); setMode('Step through') }
  const navigate = (value: number) => { setPlaying(false); setSelected(Math.max(bounds.start, Math.min(bounds.end, value))); setHover(null); setMode('Step through') }
  const changeStage = (value: number) => { setPlaying(false); setStage(value); setSelected(null); setHover(null); setMode('Movement paths') }
  useEffect(() => {
    if (!playing) return
    if (ply >= bounds.end) { setPlaying(false); return }
    const timer = window.setTimeout(() => setSelected(ply + 1), 1100 / speed)
    return () => window.clearTimeout(timer)
  }, [playing, ply, bounds.end, speed])
  useEffect(() => {
    const visible = overview ? staged : { ...staged, ghosts: [], moves: staged.moves.filter(move => move.ply === ply), segments: staged.segments.filter(segment => segment.ply === ply) }
    const future = overview ? staged.finalFen : trace.moves[ply - 1]?.fen || fen
    const focus = visible.moves.find(move => move.ply === (hover ?? selected))
    onPreview({ fen, future, full: !overview, baseline: overview ? staged.fen : undefined, changed: overview ? staged.ghosts : [], arrows: [], highlights: focus ? [focus.from, focus.to] : [], movement: mode === 'Formation' ? undefined : { trace: visible, all, focus: hover, selected, onHover: setHover, onSelect: select } })
    return () => onPreview(null)
  }, [fen, trace, staged, overview, ply, mode, all, selected, hover, onPreview])
  const describePieces = (pieces: string[]) => Object.entries(pieces.reduce<Record<string, number>>((counts, piece) => ({ ...counts, [piece]: (counts[piece] || 0) + 1 }), {})).map(([piece, count]) => `${count} ${names[piece]}${count > 1 ? 's' : ''}`).join(', ') || 'none'
  return <div className="trace-controls">
    <label>Planning horizon <select aria-label="Visualization horizon" value={horizon} onChange={event => { const value = Number(event.target.value); if (!VISUALIZATION_HORIZONS.some(option => option === value)) return; setHorizon(value); saveVisualizationMoves(value); changeStage(0) }}>{VISUALIZATION_HORIZONS.map(value => <option key={value} value={value}>{value} moves per side ({value * 2} plies)</option>)}</select></label>
    <div className="planner-controls"><strong>Stage {bounds.stage + 1} of {bounds.count}</strong><button disabled={!bounds.stage} onClick={() => changeStage(bounds.stage - 1)}>◀ Previous stage</button><button disabled={bounds.stage + 1 >= bounds.count} onClick={() => changeStage(bounds.stage + 1)}>Next stage ▶</button></div>
    <p role="status">Move {Math.ceil(ply / 2)} of {Math.ceil(trace.moves.length / 2)} · Ply {ply} of {trace.moves.length}{overview ? ' · Stage overview' : ` · ${trace.moves[ply - 1]?.label || 'Starting position'}`}</p>
    <div className="planner-controls" aria-label="Continuation playback"><button aria-label="Start of stage" onClick={() => navigate(bounds.start)}>|◀</button><button aria-label="Previous ply" disabled={ply <= bounds.start} onClick={() => navigate(ply - 1)}>◀</button><button aria-label="Next ply" disabled={ply >= bounds.end} onClick={() => navigate(ply + 1)}>▶</button><button aria-label="End of stage" onClick={() => navigate(bounds.end)}>▶|</button><button onClick={() => { setMode('Step through'); setSelected(ply >= bounds.end ? bounds.start : ply); setPlaying(!playing) }}>{playing ? 'Pause' : 'Play'}</button><button onClick={() => changeStage(bounds.stage)}>Stage overview</button></div>
    <div className="planner-controls" role="group" aria-label="Continuation visualization">{(['Formation', 'Movement paths', 'Step through'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => { setPlaying(false); setMode(value); setSelected(value === 'Step through' ? ply : null) }}>{value}</button>)}</div>
    {mode !== 'Formation' && <label><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)}/> Show all movements</label>}
    <details className="trace-material"><summary>Material {overview ? `at stage end (ply ${bounds.end})` : `at ply ${ply}`}: {ledger.balance > 0 ? '+' : ''}{ledger.balance} for White · change {ledger.gain > 0 ? '+' : ''}{ledger.gain}</summary>{(['w','b'] as const).map(side => <p key={side}>{sideName(side)}: captured {describePieces(ledger.captures[side])}; lost {describePieces(ledger.lost[side])}; promotion gain {ledger.promotions[side]}.</p>)}<p>Pawn 1 · Knight/Bishop 3 · Rook 5 · Queen 9. Nominal material only. Stockfish’s displayed score evaluates the root continuation, not this preview position.</p></details>
    <div className="stockfish-pv staged-pv" aria-label="Principal variation"><button aria-pressed={selected === 0} onClick={() => select(0)}>Now</button>{Array.from({ length: bounds.count }, (_, stageIndex) => <div key={stageIndex} className="pv-stage"><button aria-pressed={bounds.stage === stageIndex} onClick={() => changeStage(stageIndex)}>Stage {stageIndex + 1}</button>{trace.moves.slice(stageIndex * plies, (stageIndex + 1) * plies).map(move => <button key={move.ply} title={`${moveDescription(move)} · ${events[move.ply - 1].join(' · ')}`} aria-pressed={selected === move.ply} onMouseEnter={() => setHover(move.ply)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(move.ply)} onBlur={() => setHover(null)} onClick={() => select(move.ply)}>{move.label}{events[move.ply - 1].some(event => event.includes('exchange sacrifice')) ? ' ◇' : ''}{events[move.ply - 1].some(event => event.includes('recovered')) ? ' ↗' : ''}</button>)}</div>)}</div>
    <p className="trace-description" role="status">{(hover ?? selected) ? `${moveDescription(trace.moves[(hover ?? selected)! - 1])} · ${events[(hover ?? selected)! - 1].join(' · ')}` : 'Stage movements only · teal: White · purple: Black · ◇ exchange sacrifice · ↗ nominal recovery'}</p>
    <details><summary>{source === 'saved' ? 'Full saved continuation' : 'Full engine PV'} · {fullTrace.moves.length} plies</summary><p>{fullTrace.moves.map(move => move.label).join(' ')}</p></details>
    {fullTrace.invalidAt && <p>Continuation ends before illegal or unavailable ply {fullTrace.invalidAt}.</p>}
  </div>
}
