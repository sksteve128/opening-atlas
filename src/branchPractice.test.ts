import { expect, test } from 'vitest'
import { Chess } from 'chess.js'
import { identity } from './core'
import type { Variation } from './learning'
import { branchOptions, branchOrder, branchSessionKey, newBranch, startFamilyAttempt, finishFamilyAttempt, parseFamilies, practicePlaylist, type FamilyRecord } from './familyPractice'
import { buildRepertoireTree, descendantEntries } from './repertoireTree'
import { positions } from './gameAnalysis'
import { beginMemory, emptyMemoryStats, finishMemory, recallMove, opponentReply, revealMemory } from './memorize'

function saved(id: string, pgn: string, side: 'white'|'black' = 'white'): Variation {
  const game=new Chess();game.loadPgn(pgn)
  return {id,side,startFen:new Chess().fen(),moves:game.history({verbose:true}).map(m=>({uci:m.from+m.to+(m.promotion||''),san:m.san,source:'import'})),filters:{ratings:[1600,1800],speeds:['blitz','rapid']}} as Variation
}
const a=saved('a','1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4')
const b=saved('b','1.e4 c5 2.Nf3 d6 3.Nc3 Nc6 4.Bb5')
const c=saved('c','1.e4 c5 2.Nf3 Nc6 3.d4')
const defaults=branchOptions(null)
const treeFor=(lines:Variation[])=>buildRepertoireTree(lines.map(line=>({line,family:'Sicilian',search:''})))
const launch=(lines=[a,b],options=defaults,ply=4)=>startFamilyAttempt(newBranch('branch','Sicilian — 2...d6','white',lines,ply,options,42),new Map(lines.map(l=>[l.id,l])))
function complete(record: FamilyRecord, lines: Variation[]) {
  let m=record.session.memory!
  const line=lines.find(l=>l.id===m.lineId)!
  for(;m.index<m.to;){
    m=positions(line)[m.index].split(' ')[1]===line.side[0] ? recallMove(m,line.moves[m.index].uci,line.moves[m.index]) : opponentReply(m)
  }
  return finishFamilyAttempt(record,m)
}
test('exact nested paths exclude siblings, opposite side and transposed histories',()=>{
  const black={...a,id:'black',side:'black' as const}, g6=saved('g6','1.e4 c5 2.Nf3 g6 3.d4')
  const duplicate={...a,id:'duplicate'}, tree=treeFor([a,b,c,g6,black,duplicate])
  const node=tree.paths.get('a')![4]
  const members=descendantEntries(node).map(e=>e.line)
  expect(members.map(l=>l.id)).toEqual(['a','duplicate','b'])
  expect(newBranch(node.key,'d6','white',members,4,defaults,42).session.ids).toEqual(['a','b'])
  expect(descendantEntries(tree.paths.get('a')![5]).map(e=>e.line.id)).toEqual(['a','duplicate'])
  const x=saved('x','1.Nf3 d5 2.g3 Nf6 3.Bg2'),y=saved('y','1.g3 d5 2.Nf3 Nf6 3.Bg2'), trans=treeFor([x,y])
  expect(identity(positions(x)[4])).toBe(identity(positions(y)[4]))
  expect(descendantEntries(trans.paths.get('x')![4]).map(e=>e.line.id)).toEqual(['x'])
})
test('single-line branch and branch/full starts use legal existing opponent replies',()=>{
  let r=launch([a]);expect(r.session.memory?.index).toBe(4);expect(positions(a)[4]).toContain(' w ')
  const m=recallMove(r.session.memory!,'d2d4',a.moves[4]);expect(opponentReply(m).index).toBe(6)
  r=complete(r,[a]);expect(r.session.finished).toBeTruthy();expect(r.session.branch?.encountered).toEqual(['a'])
  expect(launch([a],{...defaults,start:'full'}).session.memory?.index).toBe(0)
  const black={...a,id:'black',side:'black' as const}
  const rb=startFamilyAttempt(newBranch('b','Black','black',[black],4,defaults,4),new Map([['black',black]]))
  expect(rb.session.memory?.index).toBe(4);expect(opponentReply(rb.session.memory!).index).toBe(5)
  expect(complete(rb,[black]).session.completed).toEqual(['black'])
})
test('mixed order is reproducible; sequential follows tree input order; all lines without replacement',()=>{
  const lines=[a,b,c], one=newBranch('x','X','white',lines,0,defaults,42), two=newBranch('x','X','white',lines,0,defaults,42)
  expect(one.session.remaining).toEqual(two.session.remaining)
  expect(new Set(one.session.remaining).size).toBe(3)
  expect(newBranch('x','X','white',lines,0,{...defaults,order:'sequential'},42).session.remaining).toEqual(['a','b','c'])
  let r=startFamilyAttempt(one,new Map(lines.map(l=>[l.id,l])))
  const seen=[]
  while(!r.session.finished){seen.push(r.session.memory!.lineId);r=complete(r,lines);if(!r.session.finished)r=startFamilyAttempt({...r,session:{...r.session,memory:null}},new Map(lines.map(l=>[l.id,l])))}
  expect(new Set(seen).size).toBe(3);expect(r.session.branch?.encountered).toHaveLength(3)
})
test('coverage counts grading boundaries including failure, never opening or partial moves',()=>{
  let r=launch([a]);const initial=r.session.memory!
  expect(r.session.branch?.encountered).toEqual([])
  expect(finishFamilyAttempt(r,initial)).toBe(r)
  const wrong=recallMove(initial,'a2a3',a.moves[4]);expect(finishFamilyAttempt(r,wrong)).toBe(r);r=complete({...r,session:{...r.session,memory:wrong}},[a])
  expect(r.session.finished).toBeTruthy();expect(r.session.completed).toEqual([])
  expect(r.session.branch?.encountered).toEqual(['a']);expect(r.incorrectAttempts).toBe(1)
  expect(finishMemory(emptyMemoryStats(),wrong).perfect).toBe(0)
  expect(finishFamilyAttempt(r,wrong)).toBe(r)
  expect(finishFamilyAttempt(launch([a]),revealMemory(initial,'d4')).session.completed).toEqual([])
})
test('partial success leaves full-line mastery untouched and full-opening success uses normal grading',()=>{
  for(const start of ['branch','full'] as const){
    const r=launch([a],{...defaults,start}),done=complete(r,[a]),m={...done.session.memory!,phase:'active' as const}
    const stats=finishMemory({...emptyMemoryStats(),attempts:1},m)
    expect(stats.perfect).toBe(start==='full'?1:0);expect(stats.target).toBe(5)
  }
})
test('continuous cycles avoid immediate repeats, preserve exact coverage and never finish automatically',()=>{
  const lines=[a,b],map=new Map(lines.map(l=>[l.id,l]));let r=launch(lines,{...defaults,coverage:'continuous'})
  let previous=''
  for(let i=0;i<12;i++){expect(r.session.memory!.lineId).not.toBe(previous);previous=r.session.memory!.lineId;r=complete(r,lines);expect(r.session.finished).toBeUndefined();r=startFamilyAttempt({...r,session:{...r.session,memory:null}},map)}
  expect(r.session.branch?.encountered).toHaveLength(2)
  expect(r.session.branch!.cycle).toBeGreaterThan(1)
})
test('human weighting uses recorded probabilities without replacement and rejects incomplete/mixed provenance',()=>{
  const withProbability=(line:Variation,p:number)=>({...line,moves:line.moves.map((m,i)=>i===5?{...m,source:'lichess' as const,games:100,frequency:p}:m)})
  const weighted=newBranch('x','X','white',[withProbability(a,.9),withProbability(b,.1)],4,{...defaults,opponent:'human'},5)
  expect(weighted.session.branch?.weighting).toContain('Saved opponent probabilities')
  expect(newBranch('x','X','white',[withProbability(a,.9),withProbability(b,.1)],4,{...defaults,opponent:'human'},5,undefined,Date.now(),{filters:{ratings:[2200],speeds:['classical']}}).session.branch?.weighting).toContain('Uniform fallback')
  expect(weighted.session.branch!.weights.a/weighted.session.branch!.weights.b).toBeCloseTo(9)
  let chosenA=0
  for(let seed=0;seed<1000;seed++){const order=branchOrder(['a','b'],{...weighted.session.branch!,seed});chosenA+=Number(order[0]==='a');expect(new Set(order).size).toBe(2)}
  expect(chosenA).toBeGreaterThan(850);expect(chosenA).toBeLessThan(950)
  for(const lines of [[withProbability(a,.9),b],[withProbability(a,.9),{...withProbability(b,.1),filters:{ratings:[2200],speeds:['blitz']}} as Variation]]){
    const result=newBranch('x','X','white',lines,4,{...defaults,opponent:'human'},5)
    expect(result.session.branch!.weights).toEqual({a:1,b:1});expect(result.session.branch?.weighting).toContain('Uniform fallback')
  }
  const model={...a,moves:a.moves.map((m,i)=>i===5?{...m,source:'model' as const,prediction:{model:'Maia-2',version:'1',rating:1900,calibrated:false,probability:.4}}:m)}
  expect(newBranch('x','X','white',[model],4,{...defaults,opponent:'human'},5).session.branch?.weighting).toContain('Saved opponent probabilities')
})
test('reload recovery and changed records do not fabricate coverage or alter stored variations',()=>{
  const original=JSON.stringify([a,b]),r=launch(),restored=parseFamilies(JSON.stringify({branch:r})).branch
  expect(restored.session.memory).toEqual(r.session.memory)
  const changed={...a,moves:a.moves.slice(0,4)}
  const next=startFamilyAttempt({...r,session:{...r.session,memory:null}},new Map([['a',changed]]))
  expect(next.session.memory).toBeNull();expect(next.session.branch?.encountered).toEqual([]);expect(next.session.finished).toBeUndefined()
  expect(JSON.stringify([a,b])).toBe(original)
  expect(()=>parseFamilies(JSON.stringify({branch:{...r,session:{...r.session,branch:{...r.session.branch,weights:{a:-1,b:1}}}}}))).toThrow()
})
test('large branch snapshots reuse IDs and history caches during individual attempts',()=>{
  const lines=Array.from({length:1000},(_,i)=>({...a,id:String(i),startFen:a.startFen.replace(' 0 1',` 0 ${i+1}`)}))
  const r=newBranch('large','Large','white',lines,4,defaults,7),map=new Map(lines.map(l=>[l.id,l]))
  expect(r.session.ids).toHaveLength(1000)
  const next=startFamilyAttempt(r,map);expect(next.session.ids).toBe(r.session.ids);expect(next.session.signatures).toBe(r.session.signatures)
  expect(parseFamilies(JSON.stringify({large:next})).large.session.ids).toHaveLength(1000)
})
test('playlist order and statuses distinguish failed coverage from accuracy and persistent mastery',()=>{
  const lines=[a,b], map=new Map(lines.map(line=>[line.id,line]))
  let r=startFamilyAttempt(newBranch('playlist','Sicilian','white',lines,4,{...defaults,order:'sequential'},42),map)
  expect(practicePlaylist(r).ids).toEqual(['a','b'])
  expect(practicePlaylist(r).status('a')).toBe('Current')
  expect(practicePlaylist(r).status('b')).toBe('Upcoming')
  const wrong=recallMove(r.session.memory!,'a2a3',a.moves[4])
  expect(finishFamilyAttempt(r,wrong)).toBe(r)
  r=complete({...r,session:{...r.session,memory:wrong}},lines)
  expect(practicePlaylist(r,{a:{perfect:0,target:1}})).toMatchObject({attempted:1,passed:0,mastered:0,total:2,attemptCount:1,successfulAttempts:0})
  expect(practicePlaylist(r).status('a')).toBe('Needs review')
  r=startFamilyAttempt({...r,session:{...r.session,memory:null}},map)
  expect(r.session.memory?.lineId).toBe('b')
  expect(practicePlaylist(r).ids).toEqual(['a','b'])
  expect(practicePlaylist(r).status('b')).toBe('Current')
  r=complete(r,lines)
  expect(practicePlaylist(r,{b:{perfect:1,target:1}})).toMatchObject({attempted:2,passed:1,mastered:1,total:2,attemptCount:2,successfulAttempts:1})
  expect(practicePlaylist(r).status('b')).toBe('Passed')
  const retry=beginMemory(emptyMemoryStats(),'a',4,a.moves.length).session
  r=complete({...r,session:{...r.session,memory:retry,review:undefined}},lines)
  expect(r.sessionsCompleted).toBe(1)
  expect(practicePlaylist(r).status('a')).toBe('Passed')
  expect(practicePlaylist(r)).toMatchObject({attempted:2,passed:2,attemptCount:3,successfulAttempts:2})
})
test('root branch records stay within their opening family while existing keys remain resumable',()=>{
  const italian=launch([a]), legacy={'branch:root':{...italian,session:{...italian.session,family:'Italian Game — Starting position'}}}
  expect(branchSessionKey('Italian Game','white','root',legacy)).toBe('branch:root')
  expect(branchSessionKey('Sicilian Defense','white','root',legacy)).not.toBe('branch:root')
  expect(branchSessionKey('Sicilian Defense','white','root',legacy)).not.toBe(branchSessionKey('Sicilian Defense','black','root',legacy))
})
