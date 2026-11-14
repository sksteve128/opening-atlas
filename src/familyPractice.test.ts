import { expect, test } from 'vitest'
import { Chess } from 'chess.js'
import type { Variation } from './learning'
import { eligibleFamily, newFamily, startFamilyAttempt, finishFamilyAttempt, parseFamilies, familyKey } from './familyPractice'
import { opponentReply, recallMove, revealMemory, emptyMemoryStats, finishMemory } from './memorize'
const saved = (id: string, pgn = '1. e4 e5', side: 'white' | 'black' = 'white', fen = new Chess().fen()) => {
  const chess = new Chess(fen); chess.loadPgn(pgn)
  return { id, side, startFen:fen, moves:chess.history({verbose:true}).map(m=>({uci:m.from+m.to+(m.promotion||''),san:m.san,source:'import'})) } as Variation
}
test('snapshot deduplicates by side, start and full sequence, retaining shorter endpoints',()=>{
  const a=saved('a'), b=saved('b','1. e4'), c=saved('c','1. e4 e5 2. Nf3'), d=saved('d','1. e4 e5','black')
  expect(eligibleFamily([a,{...a,id:'duplicate'},b,c,d], 'white').map(l=>l.id)).toEqual(['a','b','c'])
  expect(eligibleFamily([a,d], 'black')).toEqual([d])
  expect(eligibleFamily([{...a,sideUnconfirmed:true},{...a,moves:[]}], 'white')).toEqual([])
})
test('shuffle, fixed snapshot, nonpunitive coverage, resume, exact progress and independent stats',()=>{
  const lines=[saved('a'),saved('b','1. d4 d5'),saved('c','1. c4 e5')], map=new Map(lines.map(l=>[l.id,l]))
  let r=newFamily('Family','white',lines,undefined,()=>0,1)
  expect(r.session.ids).not.toEqual(lines.map(l=>l.id))
  r=startFamilyAttempt(r,map,10)
  const first=r.session.memory!, line=map.get(first.lineId)!
  const wrong=recallMove(first,'a2a3',line.moves[0])
  expect(finishFamilyAttempt(r,wrong,15)).toBe(r)
  r=finishFamilyAttempt(r,opponentReply(recallMove(wrong,line.moves[0].uci,line.moves[0])),20)
  expect(r.session.completed).toHaveLength(0); expect(r.session.remaining).not.toContain(first.lineId)
  expect(finishFamilyAttempt(r,first,30)).toBe(r)
  r=parseFamilies(JSON.stringify({[familyKey('Family','white')]:r}))[familyKey('Family','white')]
  r=startFamilyAttempt({...r,session:{...r.session,memory:null}},map,40)
  expect(r.session.memory!.lineId).not.toBe(first.lineId)
  map.set('new',saved('new','1. Nf3 d5'))
  while(!r.session.finished){
    const m=r.session.memory!, current=map.get(m.lineId)!
    const finished=opponentReply(recallMove(m,current.moves[0].uci,current.moves[0]))
    const individual=finishMemory({...emptyMemoryStats(),attempts:1},finished,100)
    expect(individual.perfect).toBe(1); expect(individual.target).toBe(5)
    r=finishFamilyAttempt(r,finished,100)
    if(!r.session.finished) r=startFamilyAttempt({...r,session:{...r.session,memory:null}},map,50+r.totalAttempts)
  }
  expect(r.session.completed).toHaveLength(2);expect(r.session.ids).not.toContain('new')
  expect(r).toMatchObject({sessionsCompleted:1,linesCompleted:2,totalAttempts:3,incorrectAttempts:1})
  const fresh=newFamily('Family','white',lines,r)
  expect(fresh.session.completed).toEqual([]);expect(fresh.sessionsCompleted).toBe(1);expect(fresh.sessionsStarted).toBe(2)
})
test('hints keep recall active; removed or changed records never become successes',()=>{
  const a=saved('a'), b=saved('b','1. d4 d5'), map=new Map([[a.id,a],[b.id,b]])
  let r=startFamilyAttempt(newFamily('F','white',[a,b],undefined,()=>.99),map)
  const hinted=revealMemory(r.session.memory!,'e4')
  expect(finishFamilyAttempt(r,hinted)).toBe(r)
  r=finishFamilyAttempt(r,opponentReply(recallMove(hinted,a.moves[0].uci,a.moves[0])))
  expect(r.session.completed).toEqual([]);expect(r.incorrectAttempts).toBe(1)
  map.delete('b');map.set('a',saved('a','1. c4 e5'))
  r=startFamilyAttempt({...r,session:{...r.session,memory:null}},map)
  expect(r.session.unavailable.sort()).toEqual(['a','b']);expect(r.session.finished).toBeUndefined();expect(r.session.memory).toBeNull()
})
test('one-line Black family automates White then recalls Black',()=>{
  const line=saved('black','1. e4 e5','black'), map=new Map([[line.id,line]])
  let r=startFamilyAttempt(newFamily('F','black',[line]),map)
  const m=recallMove(opponentReply(r.session.memory!),line.moves[1].uci,line.moves[1])
  r=finishFamilyAttempt(r,m)
  expect(r.session.finished).toBeTruthy();expect(r.session.completed).toEqual(['black'])
})
test('special positions use existing recall grading and legal chess histories',()=>{
  for(const [fen,uci] of [['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','e1g1'],['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1','e5d6'],['4k3/P7/8/8/8/8/8/4K3 w - - 0 1','a7a8n']]){
    const game=new Chess(fen), move=game.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]})
    const line={id:uci,side:'white',startFen:fen,moves:[{uci,san:move.san,source:'import'}]} as Variation
    const r=startFamilyAttempt(newFamily('Custom','white',[line]),new Map([[line.id,line]]))
    expect(finishFamilyAttempt(r,recallMove(r.session.memory!,uci,line.moves[0])).session.completed).toEqual([uci])
  }
})
test('10, 100 and 1000 records remain bounded and preserve source records',()=>{
  for(const count of [10,100,1000]){
    const lines=Array.from({length:count},(_,i)=>saved(String(i),i%2?'1. e4 e5':'1. d4 d5')), before=JSON.stringify(lines)
    const r=newFamily('F','white',lines)
    expect(r.session.ids).toHaveLength(2);expect(JSON.stringify(lines)).toBe(before)
  }
  expect(()=>parseFamilies('{broken')).toThrow();expect(()=>parseFamilies('{"bad":{}}')).toThrow()
})

test('indexes a thousand distinct saved positions without changing the snapshot during recall',()=>{
  const base=saved('base'), lines=Array.from({length:1000},(_,i)=>({...base,id:String(i),startFen:base.startFen.replace(' 0 1', ` 0 ${i+1}`)}))
  const record=newFamily('Large','white',lines)
  expect(record.session.ids).toHaveLength(1000)
  const next=startFamilyAttempt(record,new Map(lines.map(line=>[line.id,line])))
  expect(next.session.ids).toBe(record.session.ids)
  const restored=parseFamilies(JSON.stringify({large:next})).large
  expect(restored.session.memory).toEqual(next.session.memory)
  expect(()=>parseFamilies(JSON.stringify({bad:{...next,session:{...next.session,memory:{...next.session.memory,index:-1}}}}))).toThrow()
})
