import { memo, useLayoutEffect, useMemo, useRef, type ComponentProps } from 'react'
import { Chessboard, defaultPieces, defaultArrowOptions } from 'react-chessboard'
const Board = memo(Chessboard)
type Options = NonNullable<ComponentProps<typeof Chessboard>['options']>
// Keep DnD's board context unchanged when unrelated explorer/engine state changes.
// Event handlers always see the latest committed application state.
export function StableBoard({options}: {options:Options}) {
  const latest=useRef(options)
  useLayoutEffect(()=>{latest.current=options})
  const {onPieceDrag: _drag, onPieceDrop: _drop, onSquareClick: _click, ...visual}=options
  const key=JSON.stringify(visual)
  const stable=useMemo<Options>(()=>({...visual,
    onPieceDrag: (...args)=>latest.current.onPieceDrag?.(...args),
    onPieceDrop: (...args)=>latest.current.onPieceDrop?.(...args) ?? false,
    onSquareClick: (...args)=>latest.current.onSquareClick?.(...args),
  }),[key])
  return <Board options={stable}/>
}

// The board uses these same library SVGs, including their original fills/strokes.
export const ghostArrowOptions = { ...defaultArrowOptions, arrowWidthDenominator: 10, opacity: 0.35 }
export function GhostPieces({ changed, orientation }: { changed: { square: string; piece: string }[]; orientation: 'white' | 'black' }) {
  return <>{changed.map(({ square, piece }) => {
    const file = square.charCodeAt(0) - 97, rank = Number(square[1]) - 1
    const Piece = defaultPieces[piece]
    return Piece && <span key={square} className="planner-ghost" aria-label={`Future ${piece} on ${square}`} style={{ left: `${(orientation === 'white' ? file : 7-file)*12.5}%`, top: `${(orientation === 'white' ? 7-rank : rank)*12.5}%`, pointerEvents: 'none' }}><span className="planner-ghost-piece" style={{ width: '70%', height: '70%', pointerEvents: 'none' }}><Piece svgStyle={{ opacity: 0.45, pointerEvents: 'none' }}/></span></span>
  })}</>
}
