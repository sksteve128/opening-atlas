import { expect, test } from 'vitest'
import { Chess } from 'chess.js'
import { playlistFromPosition, playlistEntries, rememberPlaylist, emptyPlaylists, parsePlaylists } from './playlists'
import { positions } from './gameAnalysis'
import { queueNeighbor, rememberPractice, pausedPractice, type Practice } from './playlistPractice'
import type { Variation } from './learning'
const root = new Chess().fen()
function line(id: string, pgn: string, side: 'white' | 'black' = 'white'): Variation {
 const chess = new Chess(); chess.loadPgn(pgn)
 return { id, side, opening: 'Test opening', startFen: root, moves: chess.history({verbose:true}).map(m=>({uci:m.from+m.to+(m.promotion||''),san:m.san,source:'import'})) } as Variation
}
const a=line('a','1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3 Nf6')
const b=line('b','1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.d3 Nf6')
const nested=line('nested','1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3 d6 5.d4')
const ruy=line('ruy','1.e4 e5 2.Nf3 Nc6 3.Bb5 a6')
const vienna=line('vienna','1.e4 e5 2.Nc3 Nf6')
const all=[a,b,nested,ruy,vienna]
const selected=(ply:number, source=a)=>({startFen:source.startFen,moves:source.moves.slice(0,ply).map(m=>m.uci),side:source.side,name:'Italian position'})
test('internal node includes all and only terminal descendants, including nested branches',()=>{
 const playlist=playlistFromPosition(all,selected(5),1)!
 expect(playlist.ids).toEqual(['a','nested','b'])
 expect(playlist.branch).toMatchObject({ply:5,fen:positions(a)[5],options:{start:'branch',order:'sequential'}})
 expect(playlistEntries(playlist,all).map(l=>l.moves.slice(5).map(m=>m.san))).toEqual([['Bc5','c3','Nf6'],['Bc5','c3','d6','d4'],['Bc5','d3','Nf6']])
})
test('root collects every complete path; leaves, missing paths and empty trees return no playlist',()=>{
 expect(playlistFromPosition(all,selected(0))?.ids).toEqual(['a','nested','b','ruy','vienna'])
 expect(playlistFromPosition(all,selected(8))).toBeNull()
 expect(playlistFromPosition(all,{...selected(0),moves:['d2d4']})).toBeNull()
 expect(playlistFromPosition([],selected(0))).toBeNull()
 expect(playlistFromPosition(all,selected(7,b))?.ids).toEqual(['b'])
})
test('deduplicates identical sequences and excludes saved prefixes that are not terminal nodes',()=>{
 const prefix={...a,id:'prefix',moves:a.moves.slice(0,6)}, duplicate={...a,id:'duplicate'}
 expect(playlistFromPosition([prefix,a,duplicate,b],selected(5))?.ids).toEqual(['a','b'])
})
test('keeps distinct transposing paths below the node without merging earlier transpositions',()=>{
 const first=line('first','1.Nf3 Nf6 2.g3 g6 3.Bg2 Bg7')
 const second=line('second','1.g3 g6 2.Nf3 Nf6 3.Bg2 Bg7')
 expect(positions(first)[4].split(' ').slice(0,4)).toEqual(positions(second)[4].split(' ').slice(0,4))
 expect(playlistFromPosition([first,second],selected(0,first))?.ids).toEqual(['first','second'])
 expect(playlistFromPosition([first,second],selected(4,first))?.ids).toEqual(['first'])
})
test('preserves existing playlists and saved variations and reuses the same recent identity',()=>{
 const before=JSON.stringify(all), prior={...playlistFromPosition(all,selected(0),1)!,id:'permanent',type:'SAVED_CUSTOM' as const}
 const store=rememberPlaylist(emptyPlaylists(),prior), serialized=JSON.stringify(store)
 const generated=playlistFromPosition(all,selected(5),2)!
 const next=rememberPlaylist(store,generated), repeated=rememberPlaylist(next,playlistFromPosition(all,selected(5),3)!)
 expect(repeated.saved).toEqual([prior]);expect(repeated.recent).toHaveLength(1)
 expect(JSON.stringify(store)).toBe(serialized);expect(JSON.stringify(all)).toBe(before)
 expect(playlistEntries(generated,all)[0]).toBe(a)
 expect(parsePlaylists(JSON.stringify(repeated)).recent[0].branch?.fen).toBe(positions(a)[5])
})
test('existing navigation and practice snapshots use the selected position for every referenced line',()=>{
 const playlist=playlistFromPosition(all,selected(5))!, entries=playlistEntries(playlist,all)
 expect(queueNeighbor(playlist.ids,'a',1)).toBe('nested');expect(queueNeighbor(playlist.ids,'b',1)).toBeUndefined()
 for(const entry of entries){
  const from=playlist.branch!.ply
  expect(positions(entry)[from]).toBe(playlist.branch!.fen)
  const attempt:Practice={lineId:entry.id,started:1,from,endIndex:entry.moves.length,firstTry:0,errors:0,reveals:0,clean:true,message:''}
  const history=rememberPractice({},entry,attempt,from)
  expect(pausedPractice(history,entry,from)?.index).toBe(5)
  expect(pausedPractice(history,entry,0)).toBeUndefined()
 }
})
test('uses the selected side/root tree, supports custom roots, and skips invalid records',()=>{
 const black={...a,id:'black',side:'black' as const}, invalid={...a,id:'invalid',moves:[{...a.moves[0],uci:'e2e9'}]}
 expect(playlistFromPosition([a,black,invalid],selected(5))?.ids).toEqual(['a'])
 const custom={...a,id:'custom',startFen:positions(a)[5],moves:a.moves.slice(5)}
 expect(playlistFromPosition([a,custom],selected(0,custom))?.ids).toEqual(['custom'])
})
