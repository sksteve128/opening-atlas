import { describe, expect, it, vi } from 'vitest'
import { Chess } from 'chess.js'
import { discoverPlans, preliminaryPlans, soundCandidate, objectiveLoss, decisionEvidence, formation, formationKey, planLabel, playUci, planArrows, type PlannerOptions, type PlannerSources } from './planner'
import { assessDecision, analyzeFastSharpness } from './sharpness'
import type { Evaluation } from './engine'
const options: PlannerOptions = { side:'w', horizon:2, depth:12, tolerance:30, budgetMs:10000, rating:1800, response:'strong' }
const start = new Chess().fen()
const entry = (cp:number, move='e2e4', mate?:number): Evaluation => ({cp, depth:12,line:[move],mate})
const fake: PlannerSources = { analyze: vi.fn(async (fen, count, depth, _signal, _timeout, _refresh, restricted) => new Chess(fen).moves({verbose:true}).filter(m => !restricted || restricted.includes(m.from+m.to+(m.promotion||''))).slice(0,count).map((m,i) => ({cp:-i*10,depth,line:[m.from+m.to+(m.promotion||'')]}))) }
const signal = () => new AbortController().signal
it('filters objective losses, preserves mate outcomes, and never subtracts mate cp sentinels', () => {
 expect(soundCandidate(entry(20),entry(-10),30)).toBe(true)
 expect(soundCandidate(entry(20),entry(-11),30)).toBe(false)
 expect(objectiveLoss(entry(99999,'e2e4',1),entry(200))).toBeNull()
 expect(soundCandidate(entry(99999,'e2e4',1),entry(200),30)).toBe(false)
 expect(soundCandidate(entry(99999,'e2e4',1),entry(99990,'d2d4',5),30)).toBe(true)
 expect(soundCandidate(entry(-99995,'e2e4',-5),entry(-99998,'d2d4',-2),30)).toBe(false)
})
it('separates coverage, forcingness and model-weighted loss without renormalizing missing model mass', () => {
 const entries=[entry(20),entry(-180,'d2d4')]
 const evidence=decisionEvidence(start,entries,{model:'fixture',version:'1',rating:1800,calibrated:false,moves:[{uci:'e2e4',probability:.4},{uci:'d2d4',probability:.1},{uci:'g1f3',probability:.5}]})
 expect(evidence).toMatchObject({legal:20,evaluated:2,modelMass:.5,mistakeMass:.1,expectedLoss:20,gap:200,forcing:0})
})
describe.each([1,2,3,5] as const)('horizon %s', horizon => {
 it('includes one opponent response per own move and reconstructs each legal step', async () => {
  const result=await discoverPlans(start,{...options,horizon},fake,signal())
  expect(result.plans.length).toBeGreaterThan(0)
  for(const plan of result.plans){
   expect(plan.moves).toHaveLength(horizon*2);expect(plan.steps).toEqual(Array.from({length:horizon+1},(_,i)=>i*2))
   const game=new Chess(start);plan.moves.forEach((move,i)=>{playUci(game,move);expect(game.fen()).toBe(plan.fens[i+1])})
  }
 })
})
it('lets the opponent move first when planning for the other side', async () => {
 const result=await discoverPlans(start,{...options,side:'b',horizon:1},fake,signal())
 expect(result.plans[0].leadIn).toBe(1);expect(result.plans[0].moves).toHaveLength(3);expect(result.plans[0].steps).toEqual([0,3])
})
it('terminates at checkmate rather than inventing a reply', async () => {
 const fen='7k/ppp5/5KQ1/8/8/8/PPP5/8 w - - 0 1'
 const result=await discoverPlans(fen,options,{analyze:async()=>[entry(99999,'g6g7',1)]},signal())
 expect(result.plans[0].moves).toEqual(['g6g7']);expect(new Chess(result.plans[0].fens.at(-1)).isCheckmate()).toBe(true)
})
it('does no engine work for terminal tablebase material', async () => {
 const source={analyze:vi.fn()}
 const fen='8/8/8/8/8/2k5/8/K7 w - - 0 1'
 const result=await discoverPlans(fen,options,source,signal())
 expect(result.plans).toEqual([]);expect(source.analyze).not.toHaveBeenCalled()
 expect(preliminaryPlans(fen,options,[entry(0,'a1a2')])).toEqual([])
})
it('preserves extended root identity and marks a refuted root instead of replacing it', async () => {
 const result=await discoverPlans(start,{...options,rootMove:'g1f3',horizon:3},{analyze:async(fen,count,depth,s,t,r,restricted)=>restricted?[entry(-200,'g1f3')]:fake.analyze(fen,count,depth,s,t,r)},signal())
 expect(result.plans).toHaveLength(1);expect(result.plans[0]).toMatchObject({id:'g1f3',refuted:true});expect(result.plans[0].moves[0]).toBe('g1f3')
})
it('propagates cancellation without publishing stale results', async () => {
 const controller=new AbortController(), progress=vi.fn()
 await expect(discoverPlans(start,options,{analyze:async()=>{controller.abort();return [entry(20)]}},controller.signal,progress)).rejects.toBeDefined()
 expect(progress).not.toHaveBeenCalled()
})
it('allows a depth target to use the remaining planner time while waiting for the shared engine', async () => {
 const analyze = vi.fn(fake.analyze)
 await discoverPlans(start,{...options,budgetMs:60000,horizon:1},{analyze},signal())
 expect(analyze.mock.calls[0][4]).toBeGreaterThan(5000)
 expect(analyze.mock.calls[0][7]?.priority).toBe('explicit')
 expect(analyze.mock.calls.slice(1).every(call => call[7]?.priority === 'visible')).toBe(true)
})
it('shows legal preliminary candidates before the depth target and replaces them with checked plans', async () => {
 const candidates: ReturnType<typeof preliminaryPlans>[] = [], checked: string[] = []
 const source: PlannerSources = { analyze: async (fen, count, depth, signal, timeout, refresh, restrict, settings) => {
  const entries = await fake.analyze(fen,count,depth,signal,timeout,refresh,restrict)
  if (fen === start) settings?.onDepth?.(entries.map(e => ({...e,depth:8,search:{requestedDepth:24,achievedDepth:8,durationMs:1,queueMs:0,multiPVComplete:true,endedNaturally:false,stoppedByBudget:false}})))
  return entries.map(e => ({...e,depth:24}))
 } }
 const result = await discoverPlans(start,{...options,depth:24,horizon:1},source,signal(),p => checked.push(p.id),p => candidates.push(p))
 expect(candidates[0][0]).toMatchObject({stage:'candidate',preliminary:true,root:{depth:8}})
 const preview = new Chess(start);playUci(preview,candidates[0][0].moves[0]);expect(candidates[0][0].fens[1]).toBe(preview.fen())
 expect(result.plans[0]).toMatchObject({preliminary:false,root:{depth:24}})
 expect(checked).toContain(result.plans[0].id)
})
it('does not invoke Maia for strongest defense, but retains human-response inference', async () => {
 const human = { id:'test',version:'1',minRating:400,maxRating:3000,predict:vi.fn(async (fen:string,rating:number) => ({model:'test',version:'1',rating,calibrated:false,moves:[{uci:new Chess(fen).moves({verbose:true})[0].from+new Chess(fen).moves({verbose:true})[0].to,probability:1}]})) }
 await discoverPlans(start,{...options,horizon:1},{...fake,human},signal())
 expect(human.predict).not.toHaveBeenCalled()
 await discoverPlans(start,{...options,horizon:1,response:'human'},{...fake,human},signal())
 expect(human.predict).toHaveBeenCalled()
})
it('explains an exhausted planner run without reporting an engine failure', async () => {
 const result = await discoverPlans(start,{...options,budgetMs:1},{analyze:async () => { await new Promise(resolve => setTimeout(resolve,5)); return [entry(20)] }},signal())
 expect(result.error).toContain('Planner time limit reached')
})
it('does not claim a Maia path if the human model is unavailable', async () => {
 const result=await discoverPlans(start,{...options,response:'human'},fake,signal())
 expect(result.plans[0].error).toContain('Maia unavailable');expect(result.plans[0].preliminary).toBe(true)
})
it('uses legal human responses distinct from strongest defense', async () => {
 const human={id:'test',version:'1',minRating:400,maxRating:3000,predict:async(fen:string,rating:number)=>({model:'test',version:'1',rating,calibrated:false,moves:[{uci:new Chess(fen).moves({verbose:true}).map(m=>m.from+m.to+(m.promotion||'')).at(-1)!,probability:1}]})}
 const strong=await discoverPlans(start,{...options,horizon:1},fake,signal())
 const humanResult=await discoverPlans(start,{...options,horizon:1,response:'human'},{...fake,human},signal())
 expect(humanResult.plans[0].moves[1]).not.toBe(strong.plans[0].moves[1])
})
it('compares both sides, pawn structure and piece zones for diversity', () => {
 const game=new Chess(start);game.move('e4')
 expect(formationKey(start)).not.toBe(formationKey(game.fen()))
 expect(formationKey(start)).toBe(formationKey(start))
})
it.each([
 ['castling','r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','e1g1',['g1','f1']],
 ['promotion','7k/P7/8/8/8/8/8/7K w - - 0 1','a7a8q',['a8']],
 ['en passant','7k/8/8/3pP3/8/8/8/7K w - d6 0 1','e5d6',['d6']],
 ['capture','7k/8/8/8/8/8/r7/R6K w - - 0 1','a1a2',['a2']],
])('places future pieces correctly for %s',(_name,fen,move,squares)=>{
 const game=new Chess(fen);playUci(game,move)
 expect(formation(fen,game.fen(),'w').changed.map(p=>p.square).sort()).toEqual(squares.sort())
 if(['e5d6','a1a2'].includes(move))expect(formation(fen,game.fen(),'b').captured).toBe(1)
})
it('keeps normalization bounded and flags depth and coverage limits', async () => {
 const game=new Chess(start), entries=game.moves({verbose:true}).map((m,i)=>({...entry(i?-200:0,m.from+m.to),depth:10}))
 const settings={depth:12,budgetMs:1,excellentCp:30,playableCp:70,seriousCp:150}
 const full=assessDecision(start,entries,undefined,settings)!
 expect(full.score).toBeGreaterThanOrEqual(0);expect(full.score).toBeLessThanOrEqual(100);expect(full.preliminary).toBe(true)
 expect(assessDecision(start,entries.slice(0,4),undefined,settings)?.preliminary).toBe(true)
 const controller=new AbortController();controller.abort()
 await expect(analyzeFastSharpness(start,fake,controller.signal)).rejects.toBeDefined()
})
it('labels only observed maneuvers and bounds arrows to selected-side moves', async () => {
 const result=await discoverPlans(start,options,fake,signal()),plan=result.plans[0]
 expect(planLabel(start,plan.moves,'w')).toBeTruthy()
 expect(planArrows(plan,4,'w')).toHaveLength(2)
})
it('uses tablebase outcome instead of a misleading cp preference', async () => {
 const fen='7k/8/8/8/8/8/8/R5K1 w - - 0 1'
 const source: PlannerSources={analyze:async(position,count,depth,s,t,r,restricted)=>position===fen?[entry(500,'a1a8'),entry(490,'a1a7')]:fake.analyze(position,count,depth,s,t,r,restricted),tablebase:async()=>({category:'win',moves:[{uci:'a1a8',san:'Ra8+',category:'draw'},{uci:'a1a7',san:'Ra7',category:'loss'}]})}
 const result=await discoverPlans(fen,{...options,horizon:1},source,signal())
 expect(result.plans.map(p=>p.id)).toEqual(['a1a7']);expect(result.plans[0].tablebase).toBe('loss')
})
it('same side-to-move losses produce the same precision for White and Black', () => {
 const white=new Chess(),black=new Chess();black.move('e4')
 const scores=[30,10,-90,-200],settings={depth:12,budgetMs:1,excellentCp:30,playableCp:70,seriousCp:150}
 const forGame=(g:Chess)=>g.moves({verbose:true}).slice(0,4).map((m,i)=>entry(scores[i],m.from+m.to))
 expect(assessDecision(white.fen(),forGame(white),undefined,settings)?.score).toBe(assessDecision(black.fen(),forGame(black),undefined,settings)?.score)
})
it('does not let the fast cache hide deeper current analysis', async () => {
 const board=new Chess();board.move('c4');const fen=board.fen()
 let depth=8
 const source={analyze:async(position:string)=>new Chess(position).moves({verbose:true}).slice(0,4).map((m,i)=>({...entry(i?-200:0,m.from+m.to),depth})),cached:(position:string)=>position===fen?new Chess(position).moves({verbose:true}).slice(0,4).map(m=>({...entry(0,m.from+m.to),depth})):undefined}
 expect((await analyzeFastSharpness(fen,source)).black?.depth).toBe(8)
 depth=16
 expect((await analyzeFastSharpness(fen,source)).black?.depth).toBe(16)
})
it('explains a score of 15 without a hardcoded floor', () => {
 const game=new Chess(),scores=[0,0,0,0,-200]
 const entries=game.moves({verbose:true}).slice(0,5).map((m,i)=>entry(scores[i],m.from+m.to))
 expect(assessDecision(start,entries,undefined,{depth:12,budgetMs:1,excellentCp:30,playableCp:70,seriousCp:150})?.score).toBe(15)
})
it('reuses saved position history and stops at an already-repeated game', async () => {
 const game=new Chess(),moves=['g1f3','g8f6','f3g1','f6g8','g1f3','g8f6','f3g1','f6g8'];moves.forEach(m=>playUci(game,m))
 const analyze=vi.fn()
 const result=await discoverPlans(game.fen(),{...options,history:{startFen:start,moves}},{analyze},signal())
 expect(result.plans).toEqual([]);expect(analyze).not.toHaveBeenCalled()
 expect(preliminaryPlans(game.fen(),{...options,history:{startFen:start,moves}},[entry(20)])).toEqual([])
})
