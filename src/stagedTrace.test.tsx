import { expect, it, vi } from 'vitest'
import { Chess } from 'chess.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { stageBounds, stageTrace, traceMoves, materialLedger, tacticalEvents, reconcilePreview, TraceControls, MovementOverlay } from './MovementTrace'
import * as engine from './engine'
const initial = new Chess().fen()
const cycle = ['g1f3','g8f6','f3g1','f6g8']
it('divides the complete PV into ten-ply stages, including short final stages',()=>{
 const moves = [...cycle,...cycle,...cycle,...cycle,...cycle,...cycle,'g1f3']
 const trace=traceMoves(initial,moves)
 expect(trace.moves).toHaveLength(25)
 expect(stageBounds(25,0,10)).toEqual({stage:0,count:3,start:0,end:10})
 expect(stageBounds(25,5,10)).toEqual({stage:2,count:3,start:20,end:25})
 const second=stageTrace(initial,moves,1,10)
 expect(second.fen).toBe(trace.moves[9].fen)
 expect(second.finalFen).toBe(trace.moves[19].fen)
 expect(second.moves.map(m=>m.ply)).toEqual([11,12,13,14,15,16,17,18,19,20])
 expect(second.segments.every(s=>s.ply>10 && s.ply<=20)).toBe(true)
 expect(second.pieces.find(p=>p.id==='wn@g1')?.square).toBe('g1')
 expect(second.ghosts.find(p=>p.id==='wn@g1')?.square).toBe('g1')
 const html=renderToStaticMarkup(<MovementOverlay state={{trace:second,all:true,focus:11,selected:null,onSelect:()=>{},onHover:()=>{}}} orientation="black"/>)
 expect(html).toContain('data-ply="11"'); expect(html).not.toContain('data-ply="10"')
})
it('numbers Black-to-move stages from the real FEN, including partial final stages',()=>{
 const fen=initial.replace('w KQkq - 0 1','b KQkq - 0 12')
 const moves=['g8f6','g1f3','f6g8','f3g1','g8f6','g1f3','f6g8','f3g1','g8f6','g1f3','f6g8']
 const trace=traceMoves(fen,moves)
 expect(trace.moves[0].label).toBe('12...Nf6')
 expect(trace.moves[1].label).toBe('13.Nf3')
 expect(stageTrace(fen,moves,1,10).moves[0].label).toBe('17...Ng8')
 expect(stageBounds(11,1,10)).toMatchObject({start:10,end:11})
})
it('accounts for a rook exchanged for a bishop and two pawns without claiming soundness',()=>{
 // Accounting fixture, not a reproduction of the saved Petrov position.
 const fen='7k/8/8/8/8/1p2K3/2bpp3/2R5 w - - 0 1'
 const trace=traceMoves(fen,['c1c2','b3c2','e3d2','h8h7','d2e2'])
 expect(trace.moves).toHaveLength(5)
 expect(materialLedger(trace,2).gain).toBe(-2)
 expect(materialLedger(trace,5)).toMatchObject({gain:0,captures:{w:['b','p','p']},lost:{w:['r']}})
 expect(tacticalEvents(trace)[1].join(' ')).toContain('exchange sacrifice')
 expect(tacticalEvents(trace)[4]).toContain('Nominal material recovered for starting side')
 expect(tacticalEvents(trace).flat().join(' ')).not.toMatch(/winning|sound/)
})
it('uses actual captures, promotions, castling and mate in material and stage formations',()=>{
 const ep=traceMoves('7k/8/8/3pP3/8/8/8/7K w - d6 0 1',['e5d6'])
 expect(ep.moves[0].captureSquare).toBe('d5');expect(materialLedger(ep,1).gain).toBe(1)
 const promotion=traceMoves('7k/P7/8/8/8/8/8/7K w - - 0 1',['a7a8q'])
 expect(materialLedger(promotion,1).promotions.w).toBe(8)
 expect(promotion.ghosts[0].piece).toBe('wQ')
 const castle=stageTrace('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 8',['e8c8'],0)
 expect(castle.segments).toHaveLength(2);expect(new Chess(castle.finalFen).get('d8')?.type).toBe('r')
 const mate=traceMoves(initial,['f2f3','e7e5','g2g4','d8h4'])
 expect(tacticalEvents(mate)[3]).toContain('Checkmate')
 expect(mate.moves[3].checkSquare).toBe('e1')
})
it('preserves compatible previews and stages on deeper updates, resets changed paths and clamps shortened PVs',()=>{
 const old=[...cycle,...cycle,...cycle]
 expect(reconcilePreview(old,[...old,...cycle],1,11,10)).toEqual({stage:1,selected:11})
 expect(reconcilePreview(old,['e2e4','e7e5'],1,11,10)).toEqual({stage:0,selected:null})
 expect(reconcilePreview(old,[...old.slice(0,10),'e2e4'],1,11,10)).toEqual({stage:1,selected:null})
 expect(reconcilePreview(old,old.slice(0,11),1,null,10)).toEqual({stage:1,selected:null})
})
it('renders complete timeline, stage navigation, playback and material without engine calls or input mutation',()=>{
 const search=vi.spyOn(engine,'analyze'), moves=[...cycle,...cycle,...cycle], original=[...moves]
 const html=renderToStaticMarkup(<TraceControls fen={initial} moves={moves} onPreview={()=>{}}/>)
 expect(html).toContain('Next stage');expect(html).toContain('Previous ply');expect(html).toContain('End of stage');expect(html).toContain('Play')
 expect(html).toContain('6...Ng8');expect(html).toContain('Material');expect(html).toContain('Ply 0 of 6')
 expect(moves).toEqual(original);expect(search).not.toHaveBeenCalled();search.mockRestore()
})
it('tracks the delayed minor-piece recovery in the actual saved Petrov sequence',()=>{
 const game=new Chess()
 const sans=['e4','e5','Nf3','Nf6','d4','Nxe4','Bd3','d5','Nxe5','Nc6','Nxc6','bxc6','O-O','Bd6','c4','Qh4','g3','Qf6','Nd2','Bh3','Nxe4','dxe4','Bxe4','Bxf1','Bxc6+','Ke7','Qe1+','Qe6','Kxf1']
 const moves=sans.map(san=>{const move=game.move(san);return move.from+move.to+(move.promotion||'')})
 const trace=traceMoves(initial,moves)
 expect(tacticalEvents(trace)[23].join(' ')).toContain('bishop recovered at 15.Kxf1')
 expect(materialLedger(trace,29).gain).toBe(0)
 expect(materialLedger(trace,29).balance).toBe(0)
 expect(trace.moves[28].captured?.id).toBe('bb@c8')
 const stage=stageTrace(initial,moves,2,10)
 expect(stage.moves[0].label).toBe('11.Nxe4')
 expect(stage.ghosts.some(piece=>piece.id==='wr@h1')).toBe(false)
 expect(new Set(stage.ghosts.map(piece=>piece.square)).size).toBe(stage.ghosts.length)
})
