import 'fake-indexeddb/auto'
import { Chess } from 'chess.js'
import { expect, it, vi } from 'vitest'
import { positions } from './gameAnalysis'
import { lineFen, type Variation } from './learning'
import { parseCloudEvaluation } from './cloudEvaluation'
import { read, write, writeVariations } from './data'

it('reuses exact histories and invalidates append, replacement, and start-position changes',()=>{
 const line={startFen:new Chess().fen(),moves:[{uci:'e2e4',san:'e4',source:'preset' as const}]}
 const first=positions(line);expect(positions(line)).toBe(first);expect(lineFen(line,0)).toBe(line.startFen)
 line.moves.push({uci:'e7e5',san:'e5',source:'preset'});expect(positions(line)).not.toBe(first)
 line.moves[1]={uci:'c7c5',san:'c5',source:'preset'}
 const expected=new Chess();expected.move('e4');expected.move('c5');expect(lineFen(line)).toBe(expected.fen())
 const moved={startFen:first[1],moves:line.moves.slice(1)};expect(lineFen(moved)).toBe(lineFen(line))
})
it('validates cloud PVs, converts black perspective and king-to-rook castling, and preserves mate',()=>{
 const fen='r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1'
 const response={fen,depth:24,knodes:100,pvs:[{cp:20,moves:'e8h8 e1a1'}]}
 expect(parseCloudEvaluation(fen,response)?.[0]).toMatchObject({cp:-20,depth:24,line:['e8g8','e1c1'],source:'cloud',cloud:{knodes:100,candidates:1}})
 expect(parseCloudEvaluation(fen,{...response,pvs:[{mate:-3,moves:'e8h8'}]})?.[0].mate).toBe(3)
 for(const bad of [{...response,depth:undefined},{...response,fen:new Chess().fen()},{...response,pvs:[{cp:10,moves:'e8e6'}]},{...response,pvs:[...response.pvs,...response.pvs]},{...response,pvs:[{cp:10,mate:2,moves:'e8h8'}]}])expect(parseCloudEvaluation(fen,bad)).toBeUndefined()
})
it('migrates saved records atomically, retains the legacy backup, and persists updates across reload',async()=>{
 const line={id:'perf-test',startFen:new Chess().fen(),moves:[],stats:{errors:0}} as unknown as Variation
 await write('generated-lines-v1',[line]);await writeVariations([line])
 const updated={...line,stats:{...line.stats,errors:2}}
 await writeVariations([updated]);vi.resetModules()
 const reopened=await import('./data')
 expect(await reopened.readVariations()).toEqual([updated]);expect(await read('generated-lines-v1')).toEqual([line])
 await reopened.writeVariations([]);expect(await reopened.readVariations()).toEqual([])
})
it('persists compatible local engine results without accepting cloud or shallower entries',async()=>{
 const fen=new Chess().fen(), key='engine-cache:stockfish-19-lite-single:default-hash:wdl:v1'
 await write(key,[[`${fen}|1|20|`,[{depth:20,cp:30,line:['e2e4']}]],['bad',[{depth:40,source:'cloud',cp:30,line:['e2e4']}]]])
 vi.resetModules();const engine=await import('./engine');await engine.loadEngineCache()
 expect(engine.cachedAnalysis(fen,1,18)?.[0].depth).toBe(20)
 expect(engine.cachedAnalysis(fen,1,21)).toBeUndefined();expect(engine.cachedAnalysis(fen,2,18)).toBeUndefined()
})

it('serves cached Explorer data while an unrelated network request is pending',async()=>{
 const game=new Chess();game.move('h4');const fen=game.fen(), filters={ratings:[2500],speeds:['classical']}
 const {identity}=await import('./core')
 await write(`explorer:lichess:${identity(fen)}:2500:classical`,{at:Date.now(),data:{white:1,black:2,draws:3,moves:[],source:'lichess'}})
 let release!:()=>void, started!:()=>void
 const began=new Promise<void>(r=>{started=r})
 vi.stubGlobal('fetch',()=>{started();return new Promise<Response>(resolve=>{release=()=>resolve(new Response(JSON.stringify({white:1,black:1,draws:1,moves:[]})))})})
 vi.resetModules();const {explorer}=await import('./data')
 const pending=explorer(new Chess().fen(),filters)
 await began
 try {expect((await explorer(fen,filters)).white).toBe(1)}finally{release();await pending;vi.unstubAllGlobals()}
})
it('handles cloud misses, rate limits, and warm reuse without treating them as local verification',async()=>{
 const g=new Chess();g.move('a3');const fen=g.fen()
 let status=404, now=Date.now()
 const clock=vi.spyOn(Date,'now').mockImplementation(()=>now)
 const fetcher=vi.fn(async(input: string)=>new Response(status===200?JSON.stringify({fen:new URL(input).searchParams.get('fen'),depth:20,knodes:5,pvs:[{cp:10,moves:'e7e5'}]}):'',{status}))
 vi.stubGlobal('fetch',fetcher);vi.resetModules()
 const {cloudEvaluation}=await import('./cloudEvaluation')
 try {
  expect(await cloudEvaluation(fen)).toBeUndefined();expect(await cloudEvaluation(fen)).toBeUndefined();expect(fetcher).toHaveBeenCalledTimes(1)
  const next=new Chess();next.move('b3');now+=6000;status=429
  expect(await cloudEvaluation(next.fen())).toBeUndefined();expect(fetcher).toHaveBeenCalledTimes(2)
  now+=1000;status=200;expect(await cloudEvaluation(next.fen())).toBeUndefined();expect(fetcher).toHaveBeenCalledTimes(2)
  now+=60000;expect((await cloudEvaluation(next.fen()))?.[0]).toMatchObject({source:'cloud',depth:20,cp:-10})
  expect((await cloudEvaluation(next.fen()))?.[0].source).toBe('cloud');expect(fetcher).toHaveBeenCalledTimes(3)
 } finally {clock.mockRestore();vi.unstubAllGlobals()}
})
