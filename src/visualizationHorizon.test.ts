import { expect, test, vi } from 'vitest'
import { Chess } from 'chess.js'
import { STAGE_PLIES, VISUALIZATION_HORIZONS, stageTrace, stageBounds, visualizationMoves, saveVisualizationMoves } from './MovementTrace'
const fen=new Chess().fen(), moves=['e2e4','e7e5','g1f3','b8c6','f1c4','f8c5','d2d3','g8f6','b1c3','d7d6','c1e3','c8e6']
test('defaults to four-ply stages and supports exactly two through ten plies without changing the PV',()=>{
 expect(STAGE_PLIES).toBe(4);expect(VISUALIZATION_HORIZONS.map(n=>n*2)).toEqual([2,4,6,8,10])
 const original=[...moves]
 expect(stageBounds(moves.length,0).end).toBe(4)
 for(const horizon of VISUALIZATION_HORIZONS){const trace=stageTrace(fen,moves,0,horizon*2);expect(trace.moves).toHaveLength(horizon*2);expect(trace.segments.every(s=>s.ply<=horizon*2)).toBe(true)}
 expect(stageTrace(fen,moves.slice(0,5),1).moves).toHaveLength(1)
 expect(moves).toEqual(original)
})
test('forward and backward navigation use the current legal position and actual move numbers',()=>{
 const game=new Chess(fen);game.move('e4')
 const forward=stageTrace(game.fen(),moves.slice(1),0)
 expect(forward.fen).toBe(game.fen());expect(forward.moves[0].label).toBe('1...e5')
 expect(forward.moves.at(-1)?.label).toBe('3.Bc4');expect(forward.moves).toHaveLength(4)
 expect(forward.segments.some(s=>s.from==='e2')).toBe(false)
 const backward=stageTrace(fen,moves,0)
 expect(backward.moves[0].label).toBe('1.e4');expect(backward.moves.at(-1)?.label).toBe('2...Nc6')
 const alternate=stageTrace(fen,['d2d4','d7d5'],0)
 expect(alternate.segments.map(s=>s.from)).toEqual(['d2','d7'])
})
test('persists the display horizon independently of engine/planner settings and rejects invalid values',()=>{
 let raw=JSON.stringify({horizon:5,tolerance:30,depth:24,response:'strong'})
 vi.stubGlobal('localStorage',{getItem:()=>raw,setItem:(_key:string,value:string)=>{raw=value}})
 expect(visualizationMoves()).toBe(3)
 saveVisualizationMoves(2);expect(visualizationMoves()).toBe(2)
 expect(JSON.parse(raw)).toEqual({horizon:5,tolerance:30,depth:24,response:'strong',visualizationMoves:2})
 saveVisualizationMoves(99);expect(visualizationMoves()).toBe(2)
 raw=JSON.stringify({visualizationMoves:99});expect(visualizationMoves()).toBe(3)
 raw='broken';expect(visualizationMoves()).toBe(3)
 vi.unstubAllGlobals()
})
