import { expect, test } from 'vitest'
import { markerPosition, MOVE_MARKER_RADIUS, stageBounds, stageTrace } from './MovementTrace'
import { Chess } from 'chess.js'
test('four-ply stages cover even and odd continuations without renumbering',()=>{
 expect(stageBounds(6,0)).toEqual({stage:0,count:2,start:0,end:4})
 expect(stageBounds(5,1)).toEqual({stage:1,count:2,start:4,end:5})
 const fen=new Chess().fen(),moves=['e2e4','e7e5','g1f3','b8c6','f1c4','f8c5'],before=[...moves]
 expect([0,1].flatMap(stage=>stageTrace(fen,moves,stage).moves.map(move=>move.ply))).toEqual([1,2,3,4,5,6])
 expect(moves).toEqual(before)
})
test('enlarged markers fit all edges and corners in either orientation at any board size',()=>{
 expect(MOVE_MARKER_RADIUS).toBeCloseTo(1.55*1.25)
 const edges=['a1','a8','h1','h8','a4','h4','d1','d8']
 for(const orientation of ['white','black'] as const) for(const from of edges) for(const to of edges){
  if(from===to)continue
  const point=markerPosition(from,to,orientation,0)
  for(const size of [240,360,640])for(const coordinate of [point.x,point.y]){
   expect((coordinate-MOVE_MARKER_RADIUS)*size/100).toBeGreaterThanOrEqual(0)
   expect((coordinate+MOVE_MARKER_RADIUS)*size/100).toBeLessThanOrEqual(size)
  }
 }
})
test('nearby alternatives separate coincident move numbers while keeping them near the path',()=>{
 const first=markerPosition('h1','h8','white',0)
 const second=markerPosition('h8','h1','white',1,[first])
 expect(Math.hypot(first.x-second.x,first.y-second.y)).toBeGreaterThan(MOVE_MARKER_RADIUS*2)
 expect(Math.abs(second.y-50)).toBeLessThan(10)
})
