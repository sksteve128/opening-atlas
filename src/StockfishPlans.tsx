import { useEffect, useMemo, useState } from 'react'
import { Chess, type Move } from 'chess.js'
import type { Evaluation } from './engine'
import type { PlanPreview } from './PlannerMode'
import { TraceControls } from './MovementTrace'

export type PvPosition = { fen: string; san: string; move: Move }
export function legalPv(fen: string, line: string[]): PvPosition[] {
  const game = new Chess(fen), positions: PvPosition[] = []
  for (const uci of line) {
    try {
      const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
      if (!move) break
      positions.push({ fen: game.fen(), san: move.san, move })
    } catch { break }
  }
  return positions
}
export function numberedPv(fen: string, positions: PvPosition[]) {
  let number = Number(fen.split(' ')[5]) || 1
  return positions.map(position => {
    const label = `${number}${position.move.color === 'w' ? '.' : '...'}${position.san}`
    if (position.move.color === 'b') number++
    return label
  })
}
const colorName = (color: string) => color === 'w' ? 'White' : 'Black'
const pieceValue: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 }
export function needsTacticalExtension(positions: PvPosition[]) {
  const last = positions.at(-1)
  if (!last || new Chess(last.fen).isGameOver()) return false
  const previous = positions.at(-2)
  if (previous?.move.captured && last.move.captured && previous.move.to === last.move.to && !last.san.includes('+') && !last.move.promotion) return false
  return last.san.includes('+') || !!last.move.promotion || last.move.captured === 'q' || last.move.captured === 'r'
}
export function tacticalStory(positions: PvPosition[]): { description: string; forcing: boolean; resolved: boolean } {
  if (!positions.length) return { description: 'Engine continuation', forcing: false, resolved: false }
  const last = positions.at(-1)!, game = new Chess(last.fen)
  if (game.isCheckmate()) return { description: `${colorName(last.move.color)} checkmates in the displayed continuation`, forcing: true, resolved: true }
  const promotion = positions.find(position => position.move.promotion)
  if (promotion) return { description: `${colorName(promotion.move.color)} promotes on ${promotion.move.to} in the displayed continuation`, forcing: true, resolved: !needsTacticalExtension(positions) }
  const queen = positions.find(position => position.move.captured === 'q')
  if (queen) return { description: `${colorName(queen.move.color)} captures a queen on ${queen.move.to} in the displayed continuation`, forcing: true, resolved: !needsTacticalExtension(positions) }
  const sacrifice = positions.find((position, index) => index > 0 && position.move.captured && positions[index - 1].move.piece === position.move.captured && positions[index - 1].move.to === position.move.to && positions[index - 1].move.captured && 'nbqr'.includes(position.move.captured) && pieceValue[positions[index - 1].move.captured!] < pieceValue[position.move.captured])
  if (sacrifice) return { description: `A ${sacrifice.move.captured === 'b' ? 'bishop' : sacrifice.move.captured === 'n' ? 'knight' : sacrifice.move.captured === 'r' ? 'rook' : 'queen'} is captured on ${sacrifice.move.to} after taking a lower-value piece`, forcing: true, resolved: !needsTacticalExtension(positions) }
  const recapture = positions.find((position, index) => index > 0 && position.move.captured && positions[index - 1].move.captured && position.move.to === positions[index - 1].move.to)
  if (recapture) return { description: `The displayed continuation includes a recapture on ${recapture.move.to}`, forcing: true, resolved: !needsTacticalExtension(positions) }
  const rook = positions.find(position => position.move.captured === 'r')
  if (rook) return { description: `${colorName(rook.move.color)} captures a rook on ${rook.move.to} in the displayed continuation`, forcing: true, resolved: !needsTacticalExtension(positions) }
  const check = positions.find(position => position.san.includes('+'))
  if (check) return { description: `${colorName(check.move.color)} gives check in the displayed continuation`, forcing: true, resolved: !needsTacticalExtension(positions) }
  return { description: 'Engine continuation', forcing: false, resolved: true }
}
export function extensionKey(fen: string, root: string, moves: string[]) { return `${fen}|${root}|${moves.join(' ')}` }
export async function runTacticalExtension(fen: string, depth: number, signal: AbortSignal, cached: (fen: string, depth: number) => Evaluation[] | undefined, search: (fen: string, depth: number, signal: AbortSignal) => Promise<Evaluation[]>) {
  const started = performance.now(), hit = cached(fen, depth)
  const lines = hit || await search(fen, depth, signal)
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  return { positions: legalPv(fen, lines[0]?.line || []), searches: hit ? 0 : 1, durationMs: performance.now() - started, cacheHit: !!hit }
}

export function StockfishPlans({ fen, lines, score, onPreview, searching: _searching, depth: _depth, speed = 1 }: { fen: string; lines: Evaluation[]; score: (line: Evaluation) => string; onPreview: (value: PlanPreview | null) => void; searching: boolean; depth: number; speed?: number }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const candidates = useMemo(() => lines.map(line => ({ line, root: line.line[0], positions: legalPv(fen, line.line) })).filter(item => item.root && item.positions.length), [fen, lines])
  const active = candidates.find(item => item.root === (hover || selected)) || (selected ? candidates[0] : undefined)
  useEffect(() => { setHover(null) }, [fen])
  useEffect(() => { if (!active) onPreview(null) }, [active, onPreview])
  return <div className="stockfish-plans"><div className="candidate-list">{candidates.map(({ line, root, positions: basePositions }, index) => {
    const shown = basePositions
    const story = tacticalStory(shown)
    return <div className="stockfish-candidate" key={root}>
      <button title={`${story.description} · Depth ${line.depth}${line.source === "cloud" ? " · Lichess cloud" : ""}`} className="stockfish-candidate-main" aria-expanded={selected === root} aria-pressed={selected === root} onMouseEnter={() => setHover(root)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(root)} onBlur={() => setHover(null)} onClick={() => { setSelected(value => value === root ? null : root) }}><b>Plan {String.fromCharCode(65 + index)} · {basePositions[0].san}</b><span>{story.description}</span><small>{score(line)}{line.source === 'cloud' ? ' · Cloud' : ''}</small></button>

    </div>
  })}</div>{active && <TraceControls key={fen + active.root} fen={fen} moves={active.line.line} speed={speed} onPreview={onPreview}/>}</div>
}
