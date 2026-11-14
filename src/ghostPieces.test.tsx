import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultPieces, defaultArrowOptions } from 'react-chessboard'
import { Chess } from 'chess.js'
import { GhostPieces, ghostArrowOptions } from './StableBoard'
import { formation, playUci } from './planner'
it('uses every exact board SVG and original color, at 70% size and 45% opacity without pointer interception', () => {
 for(const piece of Object.keys(defaultPieces)) {
  const Piece=defaultPieces[piece]
  const html=renderToStaticMarkup(<GhostPieces changed={[{square:'d7',piece}]} orientation="white"/>)
  expect(html).toContain(renderToStaticMarkup(<Piece svgStyle={{opacity:0.45,pointerEvents:'none'}}/>))
  expect(html).toContain('width:70%;height:70%;pointer-events:none')
  expect(html).toContain('opacity:0.45;pointer-events:none')
  expect(html).toContain(`Future ${piece} on d7`)
  expect(html).toContain('left:37.5%;top:12.5%;pointer-events:none')
 }
})
it('flips destination coordinates and layers centered ghosts independently of occupied squares',()=>{
 const html=renderToStaticMarkup(<GhostPieces changed={[{square:'d7',piece:'wN'},{square:'a1',piece:'bR'}]} orientation="black"/>)
 expect(html).toContain('left:50%;top:75%');expect(html).toContain('left:87.5%;top:0%')
 expect(html.match(/<svg/g)).toHaveLength(2)
 expect(ghostArrowOptions.arrowWidthDenominator).toBeGreaterThan(defaultArrowOptions.arrowWidthDenominator)
 expect(ghostArrowOptions.opacity).toBeLessThan(defaultArrowOptions.opacity)
})
it.each([
 ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','e1g1','w',['wK on g1','wR on f1']],
 ['r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1','e8c8','b',['bK on c8','bR on d8']],
 ['7k/P7/8/8/8/8/8/7K w - - 0 1','a7a8q','w',['wQ on a8']],
 ['7k/8/8/8/8/8/p7/7K b - - 0 1','a2a1n','b',['bN on a1']],
 ['7k/8/8/8/8/8/r7/R6K w - - 0 1','a1a2','w',['wR on a2']],
 ['7k/8/8/3pP3/8/8/8/7K w - d6 0 1','e5d6','w',['wP on d6']],
] as const)('keeps identity and destinations after %s %s',(fen,move,side,expected)=>{
 const game=new Chess(fen);playUci(game,move)
 const changed=formation(fen,game.fen(),side).changed
 expect(changed.map(p=>`${p.piece} on ${p.square}`).sort()).toEqual([...expected].sort())
 const html=renderToStaticMarkup(<GhostPieces changed={changed} orientation="white"/>)
 for(const label of expected)expect(html).toContain(`Future ${label}`)
 expect(formation(fen,fen,side).changed).toEqual([])
})
it('retains the normal piece when a future capture overlaps its square',()=>{
 const Existing=defaultPieces.bR
 const html=renderToStaticMarkup(<div><Existing/><GhostPieces changed={[{square:'a2',piece:'wR'}]} orientation="white"/></div>)
 expect(html).toContain(renderToStaticMarkup(<Existing/>))
 expect(html.match(/<svg/g)).toHaveLength(2)
 expect(html).toContain('Future wR on a2')
})
