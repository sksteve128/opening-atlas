import { expect, test } from 'vitest'
import { Chess } from 'chess.js'
import { emptyPlaylists, fromSession, rememberPlaylist, parsePlaylists, playlistEntries, matchingSession, resumableSession, playlistLabel, recallConcealed } from './playlists'
import { newFamily, newBranch, branchOptions, startFamilyAttempt, finishFamilyAttempt, rememberSession, sessionKey, parseFamilies } from './familyPractice'
import { beginMemory, emptyMemoryStats, recallMove, finishMemory } from './memorize'
import type { Variation } from './learning'
const lines = ['e4','d4','c4'].map((san,i) => { const game = new Chess(), m = game.move(san); return { id: String(i), side: 'white', opening: 'Test', startFen: new Chess().fen(), moves: [{san,uci:m.from+m.to,source:'import'}] } as Variation })
const map = new Map(lines.map(l=>[l.id,l]))
test('temporary family/branch collections retain IDs and original mixed/sequential order without PGNs', () => {
 for (const record of [newFamily('Test','white',lines), ...['mixed','sequential'].map(order=>newBranch('branch','Test','white',lines,0,{...branchOptions(null),order:order as 'mixed'|'sequential'},42))]) {
  const before = JSON.stringify(record), p = fromSession(record)
  expect(p.ids).toEqual(record.session.branch?.playlist || record.session.ids)
  expect(JSON.stringify(p)).not.toContain('uci'); expect(JSON.stringify(record)).toBe(before)
  expect(playlistEntries(p,lines).map(l=>l.id)).toEqual(p.ids)
 }
})
test('three recent collections, reopening selection and order, exit and reload; custom saves survive eviction', () => {
 let store=emptyPlaylists()
 const p=fromSession(newFamily('First','white',lines,undefined,()=>.9,1))
 store=rememberPlaylist(store,{...p,selected:'2'})
 store=rememberPlaylist(store,{...p,type:'SAVED_CUSTOM',name:'My repertoire'})
 for(let i=2;i<=6;i++) store=rememberPlaylist(store,fromSession(newFamily(String(i),'white',lines,undefined,()=>.9,i)))
 expect(store.recent).toHaveLength(3); expect(store.saved).toHaveLength(1)
 const recent={...store.recent[2],selected:'2',accessed:10}, ids=[...recent.ids]
 store=rememberPlaylist(store,recent)
 store=parsePlaylists(JSON.stringify({...store,active:null}))
 expect(store.active).toBeNull(); expect(store.recent[0]).toMatchObject({selected:'2',ids})
 store=rememberPlaylist(store,store.recent[0]); expect(store.active).toBe(recent.id)
 expect(store.saved[0].name).toBe('My repertoire'); expect(store.recent).toHaveLength(3)
 expect(playlistEntries(recent,lines.filter(l=>l.id!=='1')).map(l=>l.id)).toEqual(ids.filter(id=>id!=='1'))
 expect(playlistEntries(recent,[])).toEqual([])
})
test('session suspension/history stays independent of collection and completion never auto resumes', () => {
 let record=startFamilyAttempt(newFamily('Test','white',lines,undefined,()=>.9,1),map,2)
 const p=fromSession(record), key=sessionKey(record.session), before=JSON.stringify(lines)
 let records=rememberSession({},record)
 expect(resumableSession(matchingSession(p,records))).toBe(true)
 const expected=map.get(record.session.memory!.lineId)!.moves[0]
 const wrong=recallMove(record.session.memory!,'a2a3',expected)
 expect(finishFamilyAttempt(record,wrong)).toBe(record)
 record=finishFamilyAttempt(record,recallMove(wrong,expected.uci,expected),3)
 expect(record.session.attempts[0].wrong).toBe(1)
 records=rememberSession(records,record)
 const replacement=newFamily('Test','white',lines,record,()=>.9,4)
 records=rememberSession(records,replacement)
 records=parseFamilies(JSON.stringify(records))
 expect(matchingSession(p,records)?.session.attempts).toEqual(record.session.attempts)
 expect(records[key].session.started).toBe(4)
 expect(resumableSession({...record,session:{...record.session,finished:5}})).toBe(false)
 expect(JSON.stringify(lines)).toBe(before)
})
test('both analysis gates hide active recall, reveal only the current attempt, and restore on completion', () => {
 const {session}=beginMemory(emptyMemoryStats(),'0',0,1,10)
 expect(recallConcealed(session,null)).toBe(true)
 expect(recallConcealed(session,9)).toBe(true)
 expect(recallConcealed(session,10)).toBe(false)
 expect(recallConcealed({...session,phase:'complete'},null)).toBe(false)
 expect(recallConcealed(null,null)).toBe(false)
 const assisted={...session,index:1,reveals:1}
 expect(finishMemory(emptyMemoryStats(),assisted,20)).toMatchObject({perfect:0,completed:1,reveals:1})
})
test('invalid persistence is rejected and missing metadata gets a move-based label', () => {
 expect(parsePlaylists('{broken')).toEqual(emptyPlaylists())
 const p=fromSession(newFamily('Test','white',lines))
 expect(parsePlaylists(JSON.stringify({recent:[{...p,ids:[42]}],saved:[],active:p.id}))).toEqual(emptyPlaylists())
 expect(playlistLabel(lines[0])).toBe('Test — e4')
 expect(playlistLabel({...lines[0],customName:'My line'})).toBe('My line')
})
test('review collections do not evict the three recent branch/family collections', () => {
 let store=emptyPlaylists()
 for(let i=1;i<=3;i++) store=rememberPlaylist(store,fromSession(newFamily(String(i),'white',lines,undefined,()=>.9,i)))
 const recent=store.recent.map(p=>p.id)
 const review={...fromSession(newFamily('Review','white',lines,undefined,()=>.9,10)),type:'REVIEW' as const}
 store=rememberPlaylist(store,review)
 expect(store.recent.map(p=>p.id)).toEqual(recent)
 expect(parsePlaylists(JSON.stringify(store))).toEqual(store)
})
