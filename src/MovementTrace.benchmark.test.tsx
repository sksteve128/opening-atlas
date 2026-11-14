import { it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { MovementOverlay, TraceControls, traceMoves } from './MovementTrace'
it('measures a long trace and SVG/React serialization without engine work',()=>{
 const fen=new Chess().fen(),moves=Array.from({length:20},()=>['g1f3','g8f6','f3g1','f6g8']).flat()
 const samples:number[]=[],svg:number[]=[],react:number[]=[]
 for(let i=0;i<30;i++){
  let start=performance.now();const trace=traceMoves(fen,moves);samples.push(performance.now()-start)
  start=performance.now();renderToStaticMarkup(<MovementOverlay state={{trace,all:true,focus:3,selected:null,onHover:()=>{},onSelect:()=>{}}} orientation="white"/>);svg.push(performance.now()-start)
  start=performance.now();renderToStaticMarkup(<TraceControls fen={fen} moves={moves} onPreview={()=>{}}/>);react.push(performance.now()-start)
 }
 const median=(values:number[])=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)]
 const trace=traceMoves(fen,moves)
 console.log('Movement benchmark',JSON.stringify({plies:moves.length,samples:30,traceMedianMs:median(samples),svgReactServerRenderMedianMs:median(svg),controlsReactServerRenderIncludingTraceMedianMs:median(react),serializedTraceBytes:Buffer.byteLength(JSON.stringify(trace)),engineRequests:0}))
 expect(trace.moves).toHaveLength(80)
 // A generous runaway guard, not a hardware-specific speed assertion.
 expect(median(samples)).toBeLessThan(1000)
})
