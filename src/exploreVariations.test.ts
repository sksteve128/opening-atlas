import { Chess } from 'chess.js'
import { expect, test, vi } from 'vitest'
import { createExploration, explorationDraw, explorationPhase, explorationRandom, explorationSettings } from './exploreVariations'
import { branchVariation, buildOpeningTree } from './openingTree'
import { identity } from './core'
import { generateSimpleRepertoire } from './simpleGeneration'
import type { Generation, LineMove, Sources, Variation } from './learning'
const fen=new Chess().fen(), base={startFen:fen,prefix:[],side:'white',engineDepth:16,engineTimeoutMs:1000,maxPlies:1,maxMs:20000,mode:'here',playMode:'mainline',opening:'Test',database:'lichess',filters:{ratings:[1800],speeds:['rapid']},tolerance:35,seed:1,exploration:explorationSettings({mode:'explore'})} satisfies Generation
const entries=[{cp:30,depth:16,line:['e2e4']},{cp:15,depth:16,line:['d2d4']},{cp:0,depth:16,line:['g1f3']},{cp:-1,depth:16,line:['b1c3']}]
const sources=(values=entries): Sources=>({analyze:vi.fn(async(_f,count,depth,_s,_t,_r,restrict)=>(restrict?values.filter(e=>restrict.includes(e.line[0])):values.slice(0,count)).map(e=>({...e,depth}))),explorer:vi.fn(async()=>({white:0,draws:0,black:0,moves:[],source:'book' as const}))})
const choose=(opts:Partial<Generation>={},values=entries,history:LineMove[]=[],lines:Variation[]=[])=>createExploration({...base,...opts},lines,1).select(opts.startFen||fen,values[0],history,sources(values))
test('best move mode does no exploration work',async()=>{const src=sources();const r=await createExploration({...base,exploration:explorationSettings({})},[],1).select(fen,entries[0],[],src);expect(r.entry).toBe(entries[0]);expect(src.analyze).not.toHaveBeenCalled()})
test('15 and 30 cp are eligible; outside tolerance is excluded; probabilities are exponential',async()=>{
 const r=await choose();const c=r.exploration!.candidates;expect(c.map(e=>e.lossCp)).toEqual([0,15,30]);expect(c.reduce((s,e)=>s+e.probability,0)).toBeCloseTo(1);expect(c[1].probability/c[0].probability).toBeCloseTo(Math.exp(-1.5));expect(c[2].probability).toBeLessThan(c[1].probability)
})
test.each(['white','black'] as const)('uses side-to-move cp correctly for %s',async side=>{const position=fen.replace(' w ',side==='black'?' b ':' w '),v=entries.map(e=>({...e,line:[side==='black'?e.line[0].replaceAll('2','7').replaceAll('4','5').replaceAll('1','8').replaceAll('3','6'):e.line[0]]}));expect((await choose({side,startFen:position},v)).exploration?.candidates.map(c=>c.lossCp)).toEqual([0,15,30])})
test('equal candidates reproduce fixed seeds and coordinated slots cover all eligible alternatives',async()=>{const equal=entries.map(e=>({...e,cp:30}));const picks=[];for(let batchIndex=0;batchIndex<4;batchIndex++){const opts={batchIndex,explorationBatchSeed:42};const a=await choose(opts,equal),b=await choose(opts,equal);expect(a).toEqual(b);picks.push(a.entry.line[0])}expect(new Set(picks).size).toBe(4)})
test('clear superiority and mate scores are not randomized',async()=>{const v=entries.map((e,i)=>({...e,cp:i?20:400}));expect((await choose({},v)).entry.line[0]).toBe('e2e4');const mate=entries.map((e,i)=>({...e,...(i===0?{mate:3}:{})}));const r=await choose({},mate);expect(r.entry.mate).toBe(3);expect(r.exploration?.candidates).toEqual([])})
test('incoherent / partial evidence cannot make a position flexible',async()=>{for(const v of [entries.slice(0,2),entries.map((e,i)=>({...e,depth:i?15:16})),entries.map(e=>({...e,search:{multiPVComplete:false} as never}))]){const src=sources();src.analyze=async()=>v;const r=await createExploration(base,[],1).select(fen,entries[0],[],src);expect(r.entry).toBe(entries[0]);expect(r.exploration?.reason).toContain('Incomplete')}})
test('novelty counts unique saved lines at canonical destinations including transpositions',async()=>{
 const make=(moves:string[],id:string)=>({id,side:'white',startFen:fen,moves:moves.map(uci=>({uci,san:'',source:'preset'}))}) as Variation
 const a=make(['g1f3','g8f6','g2g3','g7g6'],'a'),b=make(['g2g3','g7g6','g1f3','g8f6'],'b')
 const game=new Chess();for(const m of a.moves)game.move(m.uci)
 expect(new Set(buildOpeningTree([a,b]).get(identity(game.fen()))?.visits.map(v=>v.lineId)).size).toBe(2)
 const lines=[make(['e2e4'],'1'),make(['e2e4'],'2'),make(['e2e4'],'2')]
 const r=await choose({},entries.map(e=>({...e,cp:30})),[],lines);const c=r.exploration!.candidates
 expect(c[0].visits).toBe(2);expect(c[0].probability).toBeLessThan(c[1].probability)
})
test('two deviations, spacing, late endgames, opponent turns and cancellation are guarded',async()=>{
 const decision={best:'e2e4',selected:'d2d4',lossCp:0,depth:18,deviation:true,reason:'test',candidates:[]}
 const history=[{uci:'d2d4',san:'d4',source:'engine',exploration:decision},{uci:'d7d5',san:'d5',source:'engine',exploration:decision}] as LineMove[]
 const src=sources();await createExploration(base,[],1).select(fen,entries[0],history,src);expect(src.analyze).not.toHaveBeenCalled()
 expect(explorationPhase('8/7k/8/8/8/8/PP6/K7 w - - 0 50')).toBe(false)
 await createExploration({...base,side:'black'},[],1).select(fen,entries[0],[],src);expect(src.analyze).not.toHaveBeenCalled()
 const c=new AbortController();c.abort();await expect(createExploration(base,[],1).select(fen,entries[0],[],src,c.signal)).rejects.toMatchObject({name:'AbortError'})
})
test('settings persist safely, metadata and repertoire alternative survive saving',async()=>{
 const opts={...base,batchIndex:1,explorationBatchSeed:42};const line=await generateSimpleRepertoire(opts,[],sources(entries.map(e=>({...e,cp:30}))))
 expect(line.exploration).toMatchObject({mode:'explore',seed:1,temperature:'auto',lossCp:30});expect(JSON.parse(JSON.stringify(line)).exploration).toEqual(line.exploration)
 const branch=branchVariation(line,opts);if(line.moves[0].exploration?.deviation)expect(branch.branch?.kind).toBe('alternative repertoire move')
 expect(explorationSettings({lossCp:Infinity,candidates:999,temperature:-1})).toMatchObject({mode:'best',lossCp:30,candidates:6,temperature:.01})
})
test('weighted draws are deterministic and nonuniform',()=>{const a=explorationRandom(42,'a'),b=explorationRandom(42,'a');expect(Array.from({length:20},()=>a())).toEqual(Array.from({length:20},()=>b()));const rng=explorationRandom(5,'distribution'),counts=[0,0,0];for(let i=0;i<10000;i++)counts[explorationDraw([.55,.33,.12],rng)]++;expect(counts[0]/10000).toBeCloseTo(.55,1);expect(counts[2]/10000).toBeCloseTo(.12,1)})

test.each(['aggressive','solid'] as const)('style weights eligible candidates without exceeding tolerance (%s)',async style=>{const r=await choose({style},entries);expect(r.exploration!.candidates.every(c=>c.lossCp<=30)).toBe(true);expect(r.exploration!.candidates.reduce((s,c)=>s+c.probability,0)).toBeCloseTo(1)})
test('deeper verification rejects an alternative outside tolerance',async()=>{
 const equal=entries.map(e=>({...e,cp:30})), src=sources(equal)
 const analyze=src.analyze;src.analyze=async(...args)=>(await analyze(...args)).map(e=>({...e,cp:args[6]?-100:e.cp}))
 const result=await createExploration({...base,batchIndex:1,explorationBatchSeed:42},[],1).select(fen,equal[0],[],src)
 expect(result.entry.line[0]).toBe('e2e4');expect(result.exploration?.deviation).toBe(false)
})
test('exploration does not consume Maia or Lichess opponent randomness',async()=>{
 for(const model of [false,true]){
  const src=sources();src.analyze=vi.fn(async()=>{throw Error('Opponent must not run Stockfish')})
  if(model)src.humanModel={id:'maia-test',version:'1',minRating:1000,maxRating:3000,predict:async(_fen,rating)=>({model:'maia-test',version:'1',rating,calibrated:false,moves:[{uci:'e2e4',probability:.6},{uci:'d2d4',probability:.4}]})}
  else src.explorer=async()=>({source:'lichess',white:100,black:0,draws:0,moves:[{uci:'e2e4',san:'e4',white:60,draws:0,black:0},{uci:'d2d4',san:'d4',white:40,draws:0,black:0}]})
  const opts={...base,side:'black' as const,mastersFallback:false,targetRating:1900,humanPolicy:'simulation' as const}
  const a=await generateSimpleRepertoire({...opts,exploration:explorationSettings({mode:'best'})},[],src)
  const b=await generateSimpleRepertoire(opts,[],src)
  expect(b.moves).toEqual(a.moves);expect(src.analyze).not.toHaveBeenCalled()
 }
})
test('exploration ignores castling preference; unavailable Patricia retains Stockfish exploration',async()=>{
 const position='r3k2r/ppp2ppp/8/8/8/8/PPP2PPP/R3K2R w KQkq - 0 1'
 const src=sources();src.analyze=async(_f,_n,depth,_s,_t,_r,restrict)=>[{cp:10,depth,line:[restrict?.[0]||'a2a3']}]
 const r=await generateSimpleRepertoire({...base,startFen:position,castlingPreference:'queenside'},[],src)
 expect(r.moves[0].san).toBe('a3');expect(r.moves[0].castling).toBeUndefined();expect(r.castlingPreference).toBe('none')
 const unavailable=sources();unavailable.patricia=async()=>{throw Error('Patricia unavailable')}
 const alternative=await generateSimpleRepertoire({...base,style:'aggressive',aggressive:{engine:'patricia',relaxed:false,maxLossCp:30}},[],unavailable)
 expect(alternative.moves).toHaveLength(1);expect(alternative.exploration?.mode).toBe('explore')
})
