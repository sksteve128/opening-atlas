import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { Chess } from 'chess.js'
import { parsePersonalGame, importGames, splitGames, getPersonalGame, gameSummaries, filterGames, gameView, putPersonalGame, criticalMoments, fetchPersonalGames, updatePersonalGame } from './personalGames'
import { positions } from './gameAnalysis'
import { branchVariation } from './openingTree'
import { emptyPlaylists, rememberPlaylist, playlistEntries } from './playlists'
import { read,write } from './data'
const pgn=(event:string,body='1. e4 e5 2. Nf3 Nc6 1-0')=>`[Event "${event}"]\n[White "Alice"]\n[Black "Bob"]\n[Date "2025.01.01"]\n[Result "1-0"]\n\n${body}`
afterEach(()=>vi.unstubAllGlobals())
test('single import preserves original annotated PGN and legally parses mainline',async()=>{
 const raw=pgn('Annotated','1. e4 {First idea} (1. d4 d5) e5 2. Nf3 $1 Nc6 1-0')
 const game=await parsePersonalGame(raw)
 expect(game.originalPgn).toBe(raw);expect(game.moves.map(m=>m.san)).toEqual(['e4','e5','Nf3','Nc6'])
 expect(gameView(game).moves).toEqual(game.moves)
})
test('multi-game import isolates malformed moves and keeps valid games',async()=>{
 const text=pgn('Batch A')+'\n\n'+pgn('Malformed','1. e4 e9 *')+'\n\n'+pgn('Batch B','1. d4 d5 1-0')
 expect(splitGames(text)).toHaveLength(3)
 expect(await importGames(text)).toMatchObject({imported:2,invalid:1})
})
test('source duplicates deduplicate; annotations are retained without replacing original',async()=>{
 const raw=pgn('Duplicates'),annotated=pgn('Duplicates','1. e4 {New comment} e5 2. Nf3 Nc6 1-0')
 expect(await importGames(raw)).toMatchObject({imported:1})
 expect(await importGames(raw)).toMatchObject({duplicates:1})
 expect(await importGames(annotated)).toMatchObject({updated:1})
 const game=await getPersonalGame((await parsePersonalGame(raw)).id)
 expect(game?.originalPgn).toBe(raw);expect(game?.annotationVersions).toContain(annotated)
 expect((await parsePersonalGame(pgn('Distinct event'))).id).not.toBe(game?.id)
})
test('missing metadata is accepted; unsupported variants and illegal games rejected',async()=>{
 expect((await parsePersonalGame('1. e4 e5 *')).plies).toBe(2)
 await expect(parsePersonalGame('[Variant "Chess960"]\n\n1. e4 e5 *')).rejects.toThrow()
 await expect(parsePersonalGame('1. e5 *')).rejects.toThrow()
})
test.each([
 ['castle','1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O *','g1','k'],
 ['en-passant','1. e4 a6 2. e5 d5 3. exd6 *','d6','p'],
])('exact %s FEN is reconstructed from canonical moves',async(_name,body,square,piece)=>{
 const game=await parsePersonalGame(body), fens=positions(gameView(game)),chess=new Chess(fens.at(-1))
 expect(chess.get(square as 'g1')?.type).toBe(piece)
 expect(fens).toHaveLength(game.plies+1)
 if(_name==='en-passant'){expect(fens.at(-2)?.split(' ')[3]).toBe('d6');expect(chess.get('d5')).toBeUndefined()}
})
test('custom FEN promotion and move counters are retained',async()=>{
 const game=await parsePersonalGame('[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/7K w - - 7 25"]\n\n25. a8=Q+ *')
 expect(game.moves[0].uci).toBe('a7a8q');expect(game.startFen.endsWith('7 25')).toBe(true)
 expect(new Chess(positions(gameView(game)).at(-1)).get('a8')?.type).toBe('q')
})
test('bookmarks, game metadata and analysis persist without touching repertoire',async()=>{
 await write('test-repertoire-sentinel',{unchanged:true})
 const game=await parsePersonalGame(pgn('Persist')),fen=positions(gameView(game))[2]
 await putPersonalGame({...game,bookmarks:[{ply:2,fen,note:'Review center'}],analyzed:true})
 const stored=await getPersonalGame(game.id)
 expect(stored?.bookmarks[0]).toEqual({ply:2,fen,note:'Review center'})
 expect((await gameSummaries()).find(g=>g.id===game.id)?.analyzed).toBe(true)
 expect(await read('test-repertoire-sentinel')).toEqual({unchanged:true})
})
test('filters handle user-relative results, dates, opening and bookmarks in large metadata lists',async()=>{
 const g=await parsePersonalGame(pgn('Filters'));g.headers.Opening='Italian';g.headers.BlackElo='2000';g.headers.TimeControl='300+3';g.bookmarks=[{ply:0,fen:g.startFen,note:''}]
 const rows=Array.from({length:3000},(_,i)=>({...g,id:String(i)}))
 expect(filterGames(rows,{player:'alice',color:'white',result:'win',opening:'Italian',minRating:'1900',since:'2025-01-01',until:'2025-01-01',bookmarked:true,time:'300'})).toHaveLength(3000)
 expect(filterGames(rows,{player:'bob',result:'win'})).toHaveLength(0)
 expect(filterGames(rows,{search:'nobody'})).toHaveLength(0)
})
test('generation from middle position preserves provenance and practices from that FEN',async()=>{
 const game=await parsePersonalGame(pgn('Generation'));const fen=positions(gameView(game))[2],origin={id:game.id,ply:2,fen}
 const candidate={...gameView(game),id:'generated',startFen:fen,moves:game.moves.slice(2)}
 const generated=branchVariation(candidate,{startFen:fen,prefix:[],opening:'Training',sourceGame:origin,playMode:'advantage'})
 expect(generated.startFen).toBe(fen);expect(generated.branch?.ply).toBe(0);expect(generated.sourceGame).toEqual(origin)
 expect(positions(generated)[0]).toBe(fen)
 const playlist={id:'saved-test',type:'SAVED_CUSTOM' as const,name:'Difficult positions',ids:[generated.id],selected:generated.id,accessed:1,family:'Games',side:'white' as const,sessionKey:'test',sessionStarted:1}
 expect(playlistEntries(rememberPlaylist(emptyPlaylists(),playlist).saved[0],[generated])[0]).toBe(generated)
 expect(game.moves).toHaveLength(4)
})
test('critical moments require measured evaluations, not psychological labels',async()=>{
 const game=await parsePersonalGame(pgn('Critical'))
 game.analysis={version:1,points:[{cp:20,index:0},{cp:250,index:1},null] as never}
 expect(criticalMoments(game)).toEqual([{ply:0,label:'Evaluation changed 2.3 pawns · review decision'}])
})
test('Lichess import uses completed games and exact official game id',async()=>{
 vi.stubGlobal('localStorage',{getItem:()=>null})
 const request=vi.fn().mockImplementation(async()=>new Response(pgn('Remote')));vi.stubGlobal('fetch',request)
 expect(await fetchPersonalGames('https://lichess.org/abcdefgh/white')).toContain('Remote')
 expect(decodeURIComponent(request.mock.calls[0][0])).toContain('/game/export/abcdefgh?')
 await fetchPersonalGames('Alice',{speed:'rapid',since:'2025-01-01'})
 expect(decodeURIComponent(request.mock.calls[1][0])).toContain('ongoing=false');expect(decodeURIComponent(request.mock.calls[1][0])).toContain('max=100')
 await expect(fetchPersonalGames('https://example.com/abcdefgh')).rejects.toThrow(/valid/)
})
test('cancelled imports stop before writing the next game',async()=>{
 const controller=new AbortController();controller.abort()
 await expect(importGames(pgn('Cancel'),controller.signal)).rejects.toMatchObject({name:'AbortError'})
})

test('splitting ignores results in comments and nested variations, including tagless games',()=>{
 const first='1. e4 {not a result 0-1} (1. d4 d5 (1... Nf6)) e5 1-0'
 expect(splitGames(first+'\n1. d4 d5 1/2-1/2')).toEqual([first,'1. d4 d5 1/2-1/2'])
})
test('conflicting official IDs cannot replace original moves',async()=>{
 const site='[Site "https://lichess.org/Conflict"]\n'
 await importGames(site+pgn('Official'))
 expect(await importGames(site+pgn('Official','1. d4 d5 1-0'))).toMatchObject({invalid:1,imported:0})
 expect((await getPersonalGame('lichess-Conflict'))?.moves[0].uci).toBe('e2e4')
})
test('overlapping bookmark and analysis updates retain both records',async()=>{
 const game=await parsePersonalGame(pgn('Concurrent'))
 await putPersonalGame(game)
 await Promise.all([
  updatePersonalGame(game.id,g=>({...g,bookmarks:[{ply:0,fen:g.startFen,note:'Keep'}]})),
  updatePersonalGame(game.id,g=>({...g,analyzed:true})),
  importGames(pgn('Concurrent','1. e4 {More notes} e5 2. Nf3 Nc6 1-0')),
 ])
 const stored=await getPersonalGame(game.id)
 expect(stored?.bookmarks).toHaveLength(1);expect(stored?.analyzed).toBe(true);expect(stored?.annotationVersions).toHaveLength(1)
})
