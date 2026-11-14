import { beforeEach, expect, it, vi } from 'vitest'
import { Chess } from 'chess.js'
const hooks=vi.hoisted(()=>({values:[] as unknown[],cursor:0,effects:[] as Array<()=>unknown>}))
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:(initial:unknown)=>{const index=hooks.cursor++;if(!(index in hooks.values))hooks.values[index]=typeof initial==='function' ? (initial as ()=>unknown)() : initial;return [hooks.values[index],(value:unknown)=>{hooks.values[index]=value}]},useMemo:(fn:()=>unknown)=>fn(),useEffect:(fn:()=>unknown)=>hooks.effects.push(fn)}))
import { TraceControls } from './MovementTrace'
import type { PlanPreview } from './PlannerMode'
import * as engine from './engine'
const fen=new Chess().fen()
beforeEach(()=>{hooks.values=[];hooks.cursor=0;hooks.effects=[]})
it('synchronizes arrow, PV, hover and exact legal preview without mutating the root or searching',()=>{
 const preview=vi.fn(),search=vi.spyOn(engine,'analyze')
 function render(){hooks.cursor=0;hooks.effects=[];const tree=TraceControls({fen,moves:['e2e4','e7e5'],onPreview:preview});hooks.effects.forEach(effect=>effect());return tree}
 let tree=render(),state=preview.mock.lastCall![0] as PlanPreview
 expect(state.full).toBe(false);expect(state.movement?.selected).toBeNull()
 state.movement!.onHover(2);render();state=preview.mock.lastCall![0]
 expect(state.highlights).toEqual(['e7','e5']);expect(state.movement?.focus).toBe(2)
 state.movement!.onSelect(1);tree=render();state=preview.mock.lastCall![0]
 expect(state.full).toBe(true);expect(new Chess(state.future).get('e4')?.type).toBe('p')
 expect(new Chess(state.future).get('e7')?.type).toBe('p');expect(state.fen).toBe(fen)
 const sequence=tree.props.children.find((child: any)=>child?.props?.['aria-label']==='Principal variation');sequence.props.children[1][0].props.children[1][1].props.onClick();render();state=preview.mock.lastCall![0]
 expect(new Chess(state.future).get('e5')?.type).toBe('p');expect(state.movement?.selected).toBe(2)
 sequence.props.children[0].props.onClick();render();state=preview.mock.lastCall![0]
 expect(state.future).toBe(fen)
 expect(search).not.toHaveBeenCalled();search.mockRestore()
})
it('clears stale selected ply before changed same-root PV commits while retaining display preferences',()=>{
 const preview=vi.fn();let moves=['e2e4','e7e5']
 function render(){hooks.cursor=0;hooks.effects=[];const tree=TraceControls({fen,moves,onPreview:preview});return tree}
 render();hooks.effects.forEach(fn=>fn());const state=preview.mock.lastCall![0] as PlanPreview
 state.movement!.onSelect(2);render();hooks.effects.forEach(fn=>fn());expect(preview.mock.lastCall![0].full).toBe(true)
 moves=['e2e4','c7c5'];render();render();hooks.effects.forEach(fn=>fn())
 expect(preview.mock.lastCall![0].full).toBe(false);expect(preview.mock.lastCall![0].movement.selected).toBeNull()
 expect(new Chess(preview.mock.lastCall![0].future).get('c5')?.type).toBe('p')
})
it('navigates stages and plies, plays only to the stage end, and keeps previews isolated',()=>{
 vi.useFakeTimers();vi.stubGlobal('window',{setTimeout,clearTimeout})
 const preview=vi.fn(),search=vi.spyOn(engine,'analyze'),moves=Array.from({length:6},()=>['g1f3','g8f6','f3g1','f6g8']).flat()
 let cleanup: Array<()=>void> = []
 function render(){cleanup.forEach(fn=>fn());hooks.cursor=0;hooks.effects=[];const tree=TraceControls({fen,moves,onPreview:preview,speed:2});cleanup=hooks.effects.map(fn=>fn()).filter(fn=>typeof fn==='function') as Array<()=>void>;return tree}
 function nodes(node:any):any[]{return !node || typeof node!=='object' ? [] : [node,...[node.props?.children].flat(Infinity).flatMap(nodes)]}
 function click(tree:any,label:string){const button=nodes(tree).find(node=>node.type==='button'&&(node.props['aria-label']===label||node.props.children===label));expect(button).toBeDefined();button.props.onClick()}
 let tree=render();click(tree,'Next stage ▶');tree=render()
 let state=preview.mock.lastCall![0] as PlanPreview
 expect(state.baseline).toBe(tracePosition(4));expect(state.movement?.trace.moves[0].ply).toBe(5)
 click(tree,'Next ply');tree=render();state=preview.mock.lastCall![0]
 expect(state.future).toBe(tracePosition(5));expect(state.changed).toEqual([]);expect(state.movement!.trace.segments.every((s:any)=>s.ply===5)).toBe(true)
 click(tree,'End of stage');tree=render();expect(preview.mock.lastCall![0].future).toBe(tracePosition(6))
 click(tree,'Play');tree=render();expect(preview.mock.lastCall![0].future).toBe(tracePosition(4))
 vi.advanceTimersByTime(550);tree=render();expect(preview.mock.lastCall![0].future).toBe(tracePosition(5))
 click(tree,'Pause');tree=render();vi.advanceTimersByTime(5000);tree=render();expect(preview.mock.lastCall![0].future).toBe(tracePosition(5))
 click(tree,'Stage overview');tree=render();expect(preview.mock.lastCall![0].baseline).toBe(tracePosition(4))
 expect(search).not.toHaveBeenCalled();expect(moves).toHaveLength(24)
 cleanup.forEach(fn=>fn());search.mockRestore();vi.unstubAllGlobals();vi.useRealTimers()
 function tracePosition(ply:number){const game=new Chess(fen);for(const uci of moves.slice(0,ply))game.move({from:uci.slice(0,2),to:uci.slice(2,4)});return game.fen()}
})
it('never renders an out-of-range selection while a live PV becomes shorter',()=>{
 const preview=vi.fn();let moves=['e2e4','e7e5','g1f3','b8c6']
 function render(){hooks.cursor=0;hooks.effects=[];const tree=TraceControls({fen,moves,onPreview:preview});hooks.effects.forEach(fn=>fn());return tree}
 render();preview.mock.lastCall![0].movement.onSelect(4);render()
 moves=['e2e4'];expect(()=>render()).not.toThrow();render()
 expect(preview.mock.lastCall![0].movement.selected).toBeNull()
 expect(preview.mock.lastCall![0].baseline).toBe(fen)
})
it('horizon selector updates only displayed arrows and keeps the original PV without engine calls',()=>{
 const preview=vi.fn(),search=vi.spyOn(engine,'analyze'),moves=Array.from({length:4},()=>['g1f3','g8f6','f3g1','f6g8']).flat(),original=[...moves]
 function render(){hooks.cursor=0;hooks.effects=[];const tree=TraceControls({fen,moves,onPreview:preview});hooks.effects.forEach(fn=>fn());return tree}
 function nodes(node:any):any[]{return !node || typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]}
 let tree=render();expect(preview.mock.lastCall![0].movement.trace.moves).toHaveLength(4)
  expect(nodes(tree).filter(node=>node.props?.className==='pv-stage')).toHaveLength(2)
 for(const value of [1,2,3,4,5]){
  nodes(tree).find(node=>node.props?.['aria-label']==='Visualization horizon').props.onChange({target:{value:String(value)}})
  tree=render();expect(preview.mock.lastCall![0].movement.trace.moves).toHaveLength(Math.min(4,value*2))
  expect(nodes(tree).filter(node=>node.props?.className==='pv-stage')).toHaveLength(Math.ceil(value/2))
  expect(preview.mock.lastCall![0].movement.trace.segments.every((s:any)=>s.ply<=4)).toBe(true)
 }
 expect(moves).toEqual(original);expect(search).not.toHaveBeenCalled();search.mockRestore()
})
