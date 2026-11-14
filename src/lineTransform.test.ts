import { expect, test } from 'vitest'
import { Chess } from 'chess.js'
import { transformFen, transformLine, transformSquare, originalLineId, linePerspective } from './lineTransform'
import type { Variation } from './learning'
import { beginMemory, emptyMemoryStats, finishMemory } from './memorize'
import { positions } from './gameAnalysis'
function line(sans: string[], fen = new Chess().fen()): Variation {
  const game = new Chess(fen)
  const moves = sans.map(san => { const m = game.move(san); return { uci: m.from + m.to + (m.promotion || ''), san: m.san, source: 'import' as const } })
  return { id:'original', opening:'Test', name:'Test', startFen:fen, moves, side:'white', pgn:game.pgn(), database:'lichess', filters:{ratings:[2000],speeds:['rapid']}, created:1, stats:{firstTry:0,errors:0,reveals:0,completions:0,totalMs:0}, endPosition:game.fen(), fallback:false }
}
test('square transforms are involutions with correct geometry', () => {
  expect(transformSquare('c6','reverse')).toBe('c3')
  expect(transformSquare('e6','mirror')).toBe('d6')
  expect(transformSquare('c6','combined')).toBe('f3')
  for(const mode of ['normal','reverse','mirror','combined'] as const) for(const sq of ['a1','c6','h8']) expect(transformSquare(transformSquare(sq,mode),mode)).toBe(sq)
})
test.each([
 ['French Advance',['e4','e6','d4','d5','e5']],
 ['Caro-Kann',['e4','c6','d4','d5']],
 ['Italian',['e4','e5','Nf3','Nc6','Bc4','Bc5','O-O']],
 ['Vienna',['e4','e5','Nc3','Nf6']],
 ['Sicilian',['e4','c5','Nf3','d6','d4','cxd4','Nxd4']],
] as [string,string[]][])('%s reverses legal moves without changing saved data', (_, sans) => {
 const source=line(sans), before=JSON.stringify(source), view=transformLine(source,'reverse')
 expect(JSON.stringify(source)).toBe(before)
 expect(transformLine(source,'normal')).toBe(source)
 expect(view.side).toBe('black'); expect(new Chess(view.startFen).turn()).toBe('b')
 const original=positions(source), reversed=positions(view)
 reversed.forEach((fen,i)=>expect(fen.split(' ').slice(0,4)).toEqual(transformFen(original[i],'reverse').split(' ').slice(0,4)))
 expect(view.analysis).toBeUndefined(); expect(view.recommendation).toBeUndefined()
 expect(view.moves.every(m=>m.cp===undefined)).toBe(true)
 expect(originalLineId(view.id)).toBe(source.id); expect(linePerspective(view.id)).toBe('reverse')
})
test('castling colors preserved while horizontal castling geometry is rejected',()=>{
 const source=line(['e4','e5','Nf3','Nc6','Bc4','Bc5','O-O'])
 expect(transformLine(source,'reverse').moves.at(-1)?.uci).toBe('e8g8')
 expect(()=>transformLine(source,'mirror')).toThrow(/castling/)
 expect(()=>transformLine(source,'combined')).toThrow(/castling/)
})
test('en passant capture transforms legally in all supported reflections',()=>{
 const source=line(['exd6'],'4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 22')
 for(const mode of ['reverse','mirror','combined'] as const){
  const view=transformLine(source,mode), game=new Chess(view.startFen)
  const move=game.move(view.moves[0].san)
  expect(move.isEnPassant()).toBe(true)
  expect(game.get(transformSquare('d5',mode))).toBeUndefined()
 }
})
test('promotion and check SAN are reconstructed',()=>{
 const source=line(['a8=Q+'],'7k/P7/8/8/8/8/8/7K w - - 0 1')
 const view=transformLine(source,'combined')
 expect(view.moves[0].uci).toBe('h2h1q'); expect(view.moves[0].san).toBe('h1=Q+')
})
test('checkmate and stalemate survive reflection',()=>{
 const mate=line(['f3','e5','g4','Qh4#'])
 expect(new Chess(positions(transformLine(mate,'reverse')).at(-1)).isCheckmate()).toBe(true)
 const stale='7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'
 for(const mode of ['reverse','mirror','combined'] as const) expect(new Chess(transformFen(stale,mode)).isStalemate()).toBe(true)
})
test('recall progress uses a separate stable reference without duplicate repertoire data',()=>{
 const source=line(['e4','e5']), view=transformLine(source,'reverse')
 const normal=emptyMemoryStats(), attempt=beginMemory(emptyMemoryStats(),view.id,0,2,100,2)
 const completed=finishMemory(attempt.stats,{...attempt.session,index:2},200)
 const persisted=JSON.parse(JSON.stringify({[view.id]:completed}))
 expect(persisted[source.id]).toBeUndefined(); expect(normal.completed).toBe(0)
 expect(persisted[view.id].completed).toBe(1)
})

test('transformed practice resumes separately and playlist neighbors still use original references', async()=>{
 const { rememberPractice, readPracticeHistory, pausedPractice, queueNeighbor } = await import('./playlistPractice')
 const source=line(['e4','e5','Nf3']), view=transformLine(source,'reverse')
 const attempt={lineId:view.id,started:1,firstTry:1,errors:0,reveals:0,clean:true,message:'',from:0}
 const history=readPracticeHistory(JSON.stringify(rememberPractice({},view,attempt,1)))
 expect(pausedPractice(history,source,0)).toBeUndefined()
 expect(pausedPractice(history,view,0)?.index).toBe(1)
 expect(queueNeighbor([source.id,'next'],originalLineId(view.id),1)).toBe('next')
})
test('planner traces use transformed coordinates, captures and piece colors',async()=>{
 const { traceMoves, stageTrace }=await import('./MovementTrace')
 const source=line(['exd6'],'4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 22')
 const view=transformLine(source,'reverse'), trace=traceMoves(view.startFen,view.moves.map(m=>m.uci))
 expect(trace.moves[0].captureSquare).toBe('d4')
 expect(trace.ghosts[0].piece).toBe('bP')
 expect(trace.ghosts[0].square).toBe('d3')
 expect(stageTrace(view.startFen,view.moves.map(m=>m.uci),0).finalFen).toBe(positions(view).at(-1))
})
test('FEN clocks and king/queen identities survive round trip',()=>{
 const fen='r3k2r/8/8/8/8/8/8/R2QK2R w KQkq - 17 42'
 const reversed=transformFen(fen,'reverse')
 expect(reversed.split(' ').slice(4)).toEqual(['17','42'])
 expect(new Chess(reversed).get('d8')).toMatchObject({type:'q',color:'b'})
 expect(new Chess(reversed).get('e8')).toMatchObject({type:'k',color:'b'})
 expect(transformFen(reversed,'reverse')).toBe(fen)
})
