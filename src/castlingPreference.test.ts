import { expect, test, vi } from 'vitest'
import { castlingPlan, castlingSummary, castlingTolerance, parseCastlingPreference, selectCastlingMove } from './castlingPreference'
import { exclusionKey } from './moveExclusions'
import type { Generation, Sources } from './learning'
const fen = 'r3k2r/ppp2ppp/8/8/8/8/PPP2PPP/R3K2R w KQkq - 0 1'
const options = { startFen:fen,side:'white',engineDepth:16,castlingPreference:'queenside',castlingToleranceCp:30 } as Generation
const best = {cp:30,depth:18,line:['a2a3']}
const engine = (loss=10) => vi.fn<Sources['analyze']>(async (_fen,_n,depth,_s,_t,_r,moves)=>[{cp:moves?30-loss:30,depth,line:[moves?.[0]||'a2a3']}])
test.each(['white','black'] as const)('favors either legal castle for %s with an unrestricted soundness bound',async side=>{
 for(const direction of ['kingside','queenside'] as const){
  const position=fen.replace(' w ',side==='black'?' b ':' w '), rank=side==='white'?'1':'8', castle=`e${rank}${direction==='queenside'?'c':'g'}${rank}`
  const result=await selectCastlingMove(position,best,{...options,side,castlingPreference:direction},engine(),undefined,undefined,best)
  expect(result.entry.line[0]).toBe(castle);expect(result.decision).toMatchObject({accepted:true,lossCp:10,plan:[castle]})
 }
})
test('rejects excessive loss, incomplete searches and mating scores',async()=>{
 expect((await selectCastlingMove(fen,best,options,engine(90),undefined,undefined,best)).decision).toMatchObject({accepted:false,lossCp:90})
 const incomplete: Sources['analyze']=async()=>[{cp:30,depth:8,line:['e1c1']}]
 expect((await selectCastlingMove(fen,best,options,incomplete,undefined,undefined,best)).entry).toBe(best)
 expect((await selectCastlingMove(fen,best,options,async()=>[{...best,mate:3}],undefined,undefined,{...best,mate:3})).decision?.accepted).toBe(false)
})
test('requires a legal feasible preparation PV and rechecks it deeply',async()=>{
 const blocked='r3k2r/ppp2ppp/8/8/8/8/PPP2PPP/R2QK2R w KQkq - 0 1', pv=['d1d2','a7a6','e1c1']
 expect(castlingPlan(blocked,pv,'white','queenside')).toEqual(pv)
 expect(castlingPlan(blocked,['e1c1'],'white','queenside')).toBeUndefined()
 const discovery=[{cp:25,depth:12,line:pv}], analyze:Sources['analyze']=async(_f,_n,depth,_s,_t,_r,moves)=>[{cp:25,depth,line:moves?pv:best.line}]
 const result=await selectCastlingMove(blocked,best,options,analyze,undefined,discovery,best)
 expect(result.decision).toMatchObject({accepted:true,plan:pv})
 const refuted:Sources['analyze']=async()=>[{cp:25,depth:18,line:['d1d2','a7a6','e1f1']}]
 expect((await selectCastlingMove(blocked,best,options,refuted,undefined,discovery,best)).decision?.accepted).toBe(false)
 expect(castlingPlan(blocked.replace('r3k2r','r3k1r1'),['d1d2','g8d8','e1c1'],'white','queenside')).toBeUndefined() // castle through attack
})
test('no preference, opponent turn and lost rights add no searches',async()=>{
 const analyze=engine()
 for(const [position,opts] of [[fen,{...options,castlingPreference:'none'}],[fen.replace(' w ',' b '),options],[fen.replace('KQkq','Kkq'),options]] as const) await selectCastlingMove(position,best,opts as Generation,analyze)
 expect(analyze).not.toHaveBeenCalled()
})
test.each(['best','aggressive','solid'] as const)('respects exclusions and soundness with %s style',async style=>{
 const opts={...options,style,exclusions:{[exclusionKey(fen,'white')]:['e1c1']}}
 const analyze=engine(), result=await selectCastlingMove(fen,best,opts,analyze,undefined,[{cp:25,depth:12,line:['e1c1']}],best)
 expect(result.entry).toBe(best);expect(analyze).not.toHaveBeenCalled()
})
test('cancellation propagates and settings / saved outcomes round-trip',async()=>{
 const controller=new AbortController();controller.abort()
 await expect(selectCastlingMove(fen,best,options,engine(),controller.signal)).rejects.toMatchObject({name:'AbortError'})
 expect(parseCastlingPreference('bad')).toBe('none');expect(parseCastlingPreference('queenside')).toBe('queenside')
 expect([castlingTolerance(undefined),castlingTolerance(NaN),castlingTolerance(999)]).toEqual([30,30,100])
 const summary=castlingSummary(options,[{uci:'e1c1',san:'O-O-O',source:'engine'}])
 expect(JSON.parse(JSON.stringify(summary))).toMatchObject({castlingPreference:'queenside',castlingOutcome:'satisfied',castlingToleranceCp:30})
 expect(castlingSummary(options,[{uci:'e1f1',san:'Kf1',source:'engine'}]).castlingOutcome).toContain('rights lost')
})

test('stops reporting failure after the requested castle was played',async()=>{
 const history=[{uci:'e1c1',san:'O-O-O',source:'engine' as const},{uci:'a7a6',san:'a6',source:'engine' as const}]
 const result=await selectCastlingMove('r3k2r/1pp2ppp/p7/8/8/8/PPP2PPP/2KR3R w kq - 0 2',best,options,engine(),undefined,undefined,undefined,history)
 expect(result.decision).toBeUndefined()
})

test('reuses complete deep MultiPV evidence and honors excluded root branches',async()=>{
 const analyze=engine(), entries=[best,{cp:25,depth:18,line:['e1c1']}]
 expect((await selectCastlingMove(fen,best,options,analyze,undefined,entries,best)).decision?.accepted).toBe(true)
 expect(analyze).not.toHaveBeenCalled()
 expect((await selectCastlingMove(fen,best,{...options,excludeRootMoves:['e1c1']},analyze,undefined,entries,best)).entry).toBe(best)
 expect(analyze).not.toHaveBeenCalled()
})
test('exploration ignores a stored castling preference without changing it', async () => {
 const exploring = {...options, exploration: {mode:'explore'} as Generation['exploration']}, analyze = engine()
 expect(await selectCastlingMove(fen,best,exploring,analyze)).toEqual({entry:best})
 expect(analyze).not.toHaveBeenCalled()
 expect(castlingSummary(exploring,[]).castlingPreference).toBe('none')
 expect(exploring.castlingPreference).toBe('queenside')
})
