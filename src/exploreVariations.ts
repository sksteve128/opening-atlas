import { Chess } from 'chess.js'
import { identity } from './core'
import { material } from './conversion'
import { buildOpeningTree } from './openingTree'
import { legalGenerationMoves } from './moveExclusions'
import { styleNeedsVerification, styleScore } from './generationStyle'
import type { Evaluation } from './engine'
import type { Generation, LineMove, Sources, Variation } from './learning'

export type ExplorationSettings = { mode: 'best' | 'explore'; lossCp: number; candidates: number; temperature: number | 'auto'; novelty: boolean; noveltyWeight: number }
export type ExplorationDecision = { best: string; selected: string; lossCp: number; depth: number; bestCp?: number; selectedCp?: number; deviation: boolean; reason: string; candidates: { uci: string; cp: number; depth: number; lossCp: number; visits: number; novelty: number; probability: number }[] }
export function explorationSettings(value: unknown): ExplorationSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<ExplorationSettings>
  const bounded = (n: unknown, fallback: number, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) ? Math.max(min,Math.min(max,n)) : fallback
  return { mode: v.mode === 'explore' ? 'explore' : 'best', lossCp: bounded(v.lossCp,30,0,100), candidates: Math.round(bounded(v.candidates,4,2,6)), temperature: v.temperature === 'auto' || v.temperature === undefined ? 'auto' : bounded(v.temperature,.1,.01,.5), novelty: v.novelty !== false, noveltyWeight: bounded(v.noveltyWeight,1,0,3) }
}
export function explorationRandom(seed: number, key: string) {
  let state = seed >>> 0
  for (const char of key) state = Math.imul(state ^ char.charCodeAt(0),16777619) >>> 0
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7,t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}
// Weighted permutation: parallel jobs take different slots of the same first-decision draw.
export function explorationDraw(weights: number[], random: () => number, slot = 0) {
  const remaining = weights.map((weight,index)=>({weight,index}))
  for (let draw=0; remaining.length; draw++) {
    let ticket = random()*remaining.reduce((sum,item)=>sum+item.weight,0), at=remaining.length-1
    for(let i=0;i<remaining.length;i++){ticket-=remaining[i].weight;if(ticket<=0){at=i;break}}
    const [chosen]=remaining.splice(at,1)
    if(draw === slot % weights.length) return chosen.index
  }
  return 0
}
export function explorationPhase(fen: string) {
  const game=new Chess(fen), pieces=game.board().flat().filter(p=>p!==null)
  const values={p:0,n:3,b:3,r:5,q:9,k:0}
  const material=pieces.reduce((sum,p)=>sum+values[p.type],0), pawns=pieces.filter(p=>p.type==='p').length
  const undeveloped=pieces.filter(p=>'nb'.includes(p.type)&&p.square[1]===(p.color==='w'?'1':'8')).length
  const centralPawns=pieces.filter(p=>p.type==='p'&&'cdef'.includes(p.square[0])).length
  return material>=36 && pawns>=8 && (undeveloped>=2 || fen.split(' ')[2]!=='-' || centralPawns>=4)
}
export function explorationCritical(fen: string, entry: Evaluation) {
  const game=new Chess(fen)
  if(game.isCheck() || entry.mate!==undefined)return true
  if(!styleNeedsVerification(fen,entry.line))return false
  const side=game.turn()==='w'?'white':'black', other=side==='white'?'black':'white', start=material(fen)
  try { for(const uci of entry.line.slice(0,6)) {
    const move=game.move(uci)
    if(move.promotion || /[+#]/.test(move.san))return true
    // Evaluate material after an opponent reply, so ordinary exchanges are not mistaken for wins.
    if(game.turn()===side[0]) { const now=material(game.fen());if(now[side]-now[other]-(start[side]-start[other])>=2)return true }
  } } catch { return true }
  return false
}
export function createExploration(options: Generation, lines: Variation[], seed: number) {
  const settings=explorationSettings(options.exploration)
  const tree=settings.mode==='explore'?buildOpeningTree(lines.filter(l=>l.side===options.side)):undefined
  const metadata=settings.mode==='explore'?{exploration:{...settings,seed}}:{}
  async function select(fen: string, fallback: Evaluation, history: LineMove[], sources: Sources, signal?: AbortSignal, supplied?: Evaluation[]): Promise<{entry: Evaluation; exploration?: ExplorationDecision}> {
    if(settings.mode!=='explore'||fen.split(' ')[1]!==options.side[0])return {entry:fallback}
    const decisions=history.map((m,i)=>({decision:m.exploration,ply:i})).filter(m=>m.decision)
    const deviations=decisions.filter(m=>m.decision!.deviation)
    // ponytail: at most three discovery points and two spaced deviations; no full-game branching search.
    if(decisions.length>=3||deviations.length>=2||history.length-(deviations.at(-1)?.ply??-100)<4||!explorationPhase(fen))return {entry:fallback}
    signal?.throwIfAborted()
    const depth=options.engineDepth, timeout=options.engineTimeoutMs??30000
    const record=(entry:Evaluation,reason:string,candidates:ExplorationDecision['candidates']=[],best=entry.line[0],lossCp=0,bestCp=entry.cp)=>({entry,exploration:{best,selected:entry.line[0],lossCp,depth:entry.depth,bestCp,selectedCp:entry.cp,deviation:entry.line[0]!==best,reason,candidates} satisfies ExplorationDecision})
    try {
      const entries=supplied && supplied.length>=settings.candidates && supplied.every(e=>e.depth>=depth)?supplied:sources.cached?.(fen,settings.candidates,depth)||await sources.analyze(fen,settings.candidates,depth,signal,timeout)
      signal?.throwIfAborted()
      const legal=new Chess(fen).moves({verbose:true}).map(m=>m.from+m.to+(m.promotion||''))
      const allowed=new Set(legalGenerationMoves(fen,options.side,options.exclusions).map(m=>m.uci).filter(uci=>fen!==(options.rootFen||options.startFen)||!options.excludeRootMoves?.includes(uci)))
      const complete=(e:Evaluation)=>e.depth>=depth&&e.depth===entries[0]?.depth&&!e.search?.stoppedByBudget&&!e.search?.cancelled&&e.search?.multiPVComplete!==false&&legal.includes(e.line[0])&&Number.isFinite(e.cp)
      if(entries.length<Math.min(settings.candidates,legal.length)||!entries.every(complete)||new Set(entries.map(e=>e.line[0])).size!==entries.length)return record(fallback,'Incomplete or incoherent candidate evidence; retained verified selection.')
      const best=entries[0]
      // Engine scores are side-to-move: this function runs only for the user's side (including Black).
      if(best.cp < -100 || entries.some(e=>e.mate!==undefined)||explorationCritical(fen,best))return record(allowed.has(best.line[0])?best:fallback,'Tactical or mating continuation: exploration suppressed.')
      const eligible=entries.filter(e=>allowed.has(e.line[0])&&best.cp-e.cp<=settings.lossCp&&best.cp-e.cp>=0)
      if(!eligible.length)return record(fallback,'No permitted candidate within tolerance.')
      const temperature=settings.temperature==='auto'?.1:settings.temperature
      const candidates=eligible.map(e=>{
        const next=new Chess(fen);next.move(e.line[0]);const node=tree?.get(identity(next.fen()))
        const visits=new Set(node?.visits.map(v=>v.lineId)).size, novelty=1/(1+visits), lossCp=best.cp-e.cp
        const style=options.style&&options.style!=='best'?Math.max(-1,Math.min(1,styleScore(fen,e.line[0],options.style)/10)):0
        return {uci:e.line[0],cp:e.cp,depth:e.depth,lossCp,visits,novelty,probability:Math.exp(-lossCp/(100*temperature)+(settings.novelty?settings.noveltyWeight*novelty:0)+style)}
      })
      const mass=candidates.reduce((sum,c)=>sum+c.probability,0);candidates.forEach(c=>c.probability/=mass)
      const coordinated=!decisions.some(d=>d.decision!.candidates.length>1)&&options.batchIndex!==undefined
      const random=explorationRandom(coordinated?(options.explorationBatchSeed??seed):seed,identity(fen)+'|'+decisions.length)
      const pick=explorationDraw(candidates.map(c=>c.probability),random,coordinated?options.batchIndex!+(options.batchAttempt??1)-1:0)
      let chosen=eligible[pick], lossCp=best.cp-chosen.cp
      if(chosen.line[0]!==best.line[0]) {
        const verifyDepth=Math.max(18,depth+2), baseline=(await sources.analyze(fen,1,verifyDepth,signal,timeout))[0]
        const checked=baseline?.line[0]===chosen.line[0]?baseline:(await sources.analyze(fen,1,verifyDepth,signal,timeout,false,[chosen.line[0]]))[0]
        const reliable=(e:Evaluation|undefined)=>e&&e.depth>=verifyDepth&&e.mate===undefined&&Number.isFinite(e.cp)&&!e.search?.stoppedByBudget&&!e.search?.cancelled&&e.search?.multiPVComplete!==false
        if(!reliable(baseline)||!reliable(checked)||baseline.depth!==checked.depth||checked.cp < -100||checked.line[0]!==chosen.line[0]||baseline.cp-checked.cp>settings.lossCp||explorationCritical(fen,baseline))return record(allowed.has(best.line[0])?best:fallback,'Alternative rejected by deeper soundness / tactical verification.',candidates,best.line[0])
        chosen=checked;lossCp=Math.max(0,baseline.cp-checked.cp)
        return record(chosen,'Sound alternative selected; independently verified.',candidates,baseline.line[0],lossCp,baseline.cp)
      }
      return record(chosen,'Weighted sampling retained the best move.',candidates,best.line[0],lossCp,best.cp)
    } catch(error){if(signal?.aborted||(error as Error).name==='AbortError')throw error;return record(fallback,'Exploration unavailable: '+(error as Error).message)}
  }
  return {metadata,select}
}
