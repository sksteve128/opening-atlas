import { expect, it, vi } from 'vitest'
import { Chess } from 'chess.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { MovementOverlay, TraceControls, moveDescription, squarePoint, traceMoves } from './MovementTrace'
import * as engine from './engine'
const initial = new Chess().fen()
function uci(fen: string, sans: string[]) { const game = new Chess(fen); return sans.map(san => { const move = game.move(san); return move.from + move.to + (move.promotion || '') }) }
it('keeps one identity and the complete alternating trail through repeat movements and returns', () => {
 const trace = traceMoves(initial, uci(initial,['Nf3','Nf6','Ng1','Ng8','Nf3','Nc6','Nd4','Nxd4']))
 expect(trace.moves.map(move => move.ply)).toEqual([1,2,3,4,5,6,7,8])
 expect(trace.segments.filter(segment => segment.id === 'wn@g1').map(segment => [segment.from,segment.to])).toEqual([['g1','f3'],['f3','g1'],['g1','f3'],['f3','d4']])
 expect(trace.moves[7].captured?.id).toBe('wn@g1')
 expect(trace.ghosts.some(piece => piece.id === 'wn@g1')).toBe(false)
 expect(trace.ghosts.find(piece => piece.square === 'd4')?.id).toBe('bn@b8')
})
it('tracks identical pieces exchanging squares independently', () => {
 const fen='7k/8/8/8/8/8/8/R3R2K w - - 0 1'
 const trace=traceMoves(fen,['a1a2','h8h7','e1a1','h7h8','a2e2','h8h7','e2e1'])
 expect(trace.pieces.find(piece=>piece.id==='wr@a1')?.square).toBe('e1')
 expect(trace.pieces.find(piece=>piece.id==='wr@e1')?.square).toBe('a1')
 expect(trace.ghosts.filter(piece=>piece.piece==='wR')).toHaveLength(2)
})
it('groups capture history on the actual square and removes captured future pieces', () => {
 const fen='4k3/8/8/8/8/3p4/2r5/2R1K3 w - - 0 1',trace=traceMoves(fen,['c1c2','d3c2'])
 expect(trace.moves.map(move=>move.captureSquare)).toEqual(['c2','c2'])
 expect(trace.moves[1].captured?.id).toBe('wr@c1')
 const html=renderToStaticMarkup(<MovementOverlay state={{trace,all:true,focus:null,selected:null,onHover:()=>{},onSelect:()=>{}}} orientation="white"/>)
 expect(html).toContain('×2');expect(html).toContain('captures White rook on c2')
 expect(trace.ghosts).toEqual([{id:'bp@d3',square:'c2',piece:'bP'}])
})
it.each(['e1g1','e1c1','e8g8','e8c8'])('records both castle segments at the same ply: %s',move=>{
 const trace=traceMoves(`r3k2r/8/8/8/8/8/8/R3K2R ${move[1]==='1'?'w':'b'} KQkq - 0 1`,[move])
 expect(trace.moves[0].castle).toBe(true);expect(trace.segments).toHaveLength(2)
 expect(trace.segments.map(segment=>segment.ply)).toEqual([1,1]);expect(trace.ghosts).toHaveLength(2)
})
it('records en passant capture square and original pawn identity',()=>{
 const trace=traceMoves('7k/8/8/3pP3/8/8/8/7K w - d6 0 1',['e5d6'])
 expect(trace.moves[0]).toMatchObject({captureSquare:'d5',captured:{id:'bp@d5'},to:'d6'})
 expect(trace.ghosts).toEqual([{square:'d6',piece:'wP',id:'wp@e5'}])
})
it.each(['q','r','b','n'])('retains pawn identity through promotion to %s',promotion=>{
 const trace=traceMoves('7k/P7/8/8/8/8/8/7K w - - 0 1',['a7a8'+promotion])
 expect(trace.moves[0]).toMatchObject({id:'wp@a7',piece:'p',promotion})
 expect(trace.ghosts).toEqual([{square:'a8',piece:'w'+promotion.toUpperCase(),id:'wp@a7'}])
})
it('uses legal checks, checkmate, stalemate and truncates invalid or post-mate output',()=>{
 const trace=traceMoves(initial,['f2f3','e7e5','g2g4','d8h4','e2e4'])
 expect(trace.moves[3]).toMatchObject({check:true,mate:true,checkSquare:'e1'})
 expect(trace.invalidAt).toBe(5);expect(moveDescription(trace.moves[3])).toContain('checkmate')
 const stale=traceMoves('7k/5K2/8/6Q1/8/8/8/8 w - - 0 1',['g5g6'])
 expect(new Chess(stale.finalFen).isStalemate()).toBe(true);expect(stale.moves[0].check).toBe(false)
 expect(traceMoves(initial,['bad']).moves).toHaveLength(0)
 expect(traceMoves(initial,[]).ghosts).toEqual([])
})
it('flips coordinates exactly and keeps repeated path arrow numbers and pointer-safe layer',()=>{
 expect(squarePoint('a1','white')).toEqual({x:6.25,y:93.75})
 expect(squarePoint('a1','black')).toEqual({x:93.75,y:6.25})
 const trace=traceMoves(initial,['g1f3','g8f6','f3g1','f6g8'])
 const html=renderToStaticMarkup(<MovementOverlay state={{trace,all:true,focus:3,selected:3,onHover:()=>{},onSelect:()=>{}}} orientation="black"/>)
 expect(html.match(/data-piece-id="wn@g1"/g)).toHaveLength(2)
 expect(html).toContain('data-ply="4"');expect(html).toContain('tabindex="0"')
 expect(html).toContain('aria-pressed="true"')
 expect(html.match(/fill="#e2a447"/g)).toHaveLength(2)
 expect(html).toContain('stroke="#733fa0"');expect(html).toContain('>4</text>')
})
it('arrow mouse, touch-click and keyboard selection share ply and never start searches',()=>{
 const hover=vi.fn(),select=vi.fn(),search=vi.spyOn(engine,'analyze')
 const tree=MovementOverlay({state:{trace:traceMoves(initial,['e2e4']),all:true,focus:null,selected:null,onHover:hover,onSelect:select},orientation:'white'})
 const hit=tree.props.children[1][0].props.children[2]
 hit.props.onMouseEnter();expect(hover).toHaveBeenLastCalledWith(1)
 hit.props.onMouseLeave();expect(hover).toHaveBeenLastCalledWith(null)
 hit.props.onFocus();expect(hover).toHaveBeenLastCalledWith(1)
 hit.props.onClick();expect(select).toHaveBeenLastCalledWith(1)
 const preventDefault=vi.fn();hit.props.onKeyDown({key:'Enter',preventDefault});hit.props.onKeyDown({key:' ',preventDefault})
 expect(select).toHaveBeenCalledTimes(3);expect(preventDefault).toHaveBeenCalledTimes(2)
 expect(search).not.toHaveBeenCalled();search.mockRestore()
})
it('shows native per-ply sequence, all three modes, and updates the same-root continuation',()=>{
 const old=traceMoves(initial,['e2e4','e7e5']),next=traceMoves(initial,['e2e4','c7c5'])
 expect(next.moves[1].label).toBe('1...c5');expect(next.finalFen).not.toBe(old.finalFen)
 const html=renderToStaticMarkup(<TraceControls fen={initial} moves={['e2e4','c7c5']} onPreview={()=>{}}/>)
 for(const label of ['Formation','Movement paths','Step through','Show all movements','1...c5'])expect(html).toContain(label)
 expect(html).not.toContain('1...e5')
})
it('retains dozens of plies with bounded emphasized segments',()=>{
 const moves=Array.from({length:20},()=>['g1f3','g8f6','f3g1','f6g8']).flat()
 const trace=traceMoves(initial,moves)
 expect(trace.moves).toHaveLength(80);expect(trace.segments).toHaveLength(80)
 const html=renderToStaticMarkup(<MovementOverlay state={{trace,all:false,focus:null,selected:null,onHover:()=>{},onSelect:()=>{}}} orientation="white"/>)
 expect(html.match(/opacity="0.7"/g)).toHaveLength(7)
 expect(trace.ghosts).toHaveLength(0)
})
it('rejects malformed UCI suffixes and keeps arrow targets away from square centers',()=>{
 expect(traceMoves(initial,['e2e4garbage']).invalidAt).toBe(1)
 const trace=traceMoves(initial,['d2d4','d7d5','g1f3','g8f6'])
 const html=renderToStaticMarkup(<MovementOverlay state={{trace,all:true,focus:null,selected:null,onHover:()=>{},onSelect:()=>{}}} orientation="white"/>)
 for(const match of html.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g))expect(Math.abs(Number(match[1])%12.5-6.25)).toBeGreaterThanOrEqual(4)
})
