import { expect, test } from 'vitest'
import { Chess } from 'chess.js'
import { rememberPractice, pausedPractice, readPracticeHistory, readRecallHistory, queueNeighbor, type Practice } from './playlistPractice'
import { playlistLabels } from './playlists'
import { beginMemory, emptyMemoryStats } from './memorize'
import { lineSignature } from './familyPractice'
import type { Variation } from './learning'
function line(id:string, moves:string[], name='Petrov variation') { const game=new Chess(); return {id,name,side:'white',startFen:game.fen(),moves:moves.map(san=>{const m=game.move(san);return {san,uci:m.from+m.to,source:'import'}})} as Variation }
const a=line('a',['e4','e5','Nf3']), b=line('b',['e4','e5','Nc3'])
const attempt:Practice={lineId:'a',started:10,firstTry:0,errors:0,reveals:0,clean:true,message:'',from:0,endIndex:3}
test('navigation saves and resumes the same practice attempt with its mistakes and exact position',()=>{
 let history=rememberPractice({},a,attempt,0)
 history=rememberPractice(history,a,{...attempt,errors:1,clean:false},2)
 const restored=pausedPractice(readPracticeHistory(JSON.stringify(history)),a,0)!
 expect(restored.index).toBe(2); expect(restored.practice).toMatchObject({started:10,errors:1,clean:false})
 history=rememberPractice(history,a,restored.practice,restored.index)
 expect(history.a).toHaveLength(1)
 history=rememberPractice(history,b,{...attempt,lineId:'b',started:20},0)
 expect(pausedPractice(history,a,0)).toEqual(restored)
 expect(history.a).toHaveLength(1); expect(history.b).toHaveLength(1)
})
test('completion and Retry preserve prior attempts without resuming a completed line',()=>{
 let history=rememberPractice({},a,{...attempt,errors:2},3)
 expect(history.a[0].complete).toBe(true); expect(pausedPractice(history,a,0)).toBeUndefined()
 history=rememberPractice(history,a,{...attempt,started:30},0)
 expect(history.a).toHaveLength(2); expect(history.a[0].practice.errors).toBe(2)
 expect(pausedPractice(history,a,0)?.practice.started).toBe(30)
 expect(pausedPractice(history,{...a,moves:b.moves},0)).toBeUndefined()
 expect(pausedPractice(history,a,1)).toBeUndefined()
})
test('Previous/Next preserve ordered IDs, boundaries, and explicit looping',()=>{
 for(const ids of [['a','b','c'],['c','a','b']]){
  const snapshot=[...ids]
  expect(queueNeighbor(ids,ids[0],-1)).toBeUndefined()
  expect(queueNeighbor(ids,ids[0],1)).toBe(ids[1])
  expect(queueNeighbor(ids,ids[1],-1)).toBe(ids[0])
  expect(queueNeighbor(ids,ids[2],1)).toBeUndefined()
  expect(queueNeighbor(ids,ids[2],1,true)).toBe(ids[0])
  expect(ids).toEqual(snapshot)
 }
 expect(queueNeighbor([],'missing',1)).toBeUndefined()
 expect(queueNeighbor(['a'],'missing',1,true)).toBeUndefined()
})
test('duplicate titles include their earliest distinguishing moves and remain deterministic',()=>{
 expect(playlistLabels([a,b])).toEqual(['Petrov variation · 2.Nf3','Petrov variation · 2.Nc3'])
 expect(playlistLabels([a])).toEqual(['Petrov variation'])
 expect(new Set(playlistLabels([a,{...a,id:'another-id'}])).size).toBe(2)
 expect(playlistLabels([a,b])).toEqual(playlistLabels([a,b]))
})
test('standalone blind recall is preserved without incrementing attempts or changing mastery',()=>{
 const stats=emptyMemoryStats(), memory=beginMemory(stats,'a',0,3,40).session
 const raw=JSON.stringify({a:{signature:lineSignature(a),memory:{...memory,index:2,wrong:1}}})
 expect(readRecallHistory(raw).a.memory).toMatchObject({started:40,index:2,wrong:1,phase:'active'})
 expect(stats.perfect).toBe(0); expect(stats.attempts).toBe(0)
 expect(()=>readRecallHistory('{bad')).toThrow()
 expect(()=>readPracticeHistory(JSON.stringify({a:[{practice:attempt,index:-1}]}))).toThrow()
})
