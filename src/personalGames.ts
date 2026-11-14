import { Chess } from 'chess.js'
import { db, read } from './data'
import type { Variation } from './learning'
import type { SavedGameAnalysis } from './gameAnalysis'
import { lichessToken } from './lichessAuth'

export type GameOrigin = { id: string; ply: number; fen: string }
export type GameSummary = { id: string; source: 'pgn' | 'lichess'; externalId?: string; headers: Record<string,string>; imported: number; plies: number; analyzed: boolean; bookmarks: { ply:number; fen:string; note:string; trainingLine?:string }[] }
export type PersonalGame = GameSummary & { originalPgn: string; annotationVersions: string[]; startFen:string; moves: Variation['moves']; analysis?:SavedGameAnalysis }
const recordKey = (id:string) => `personal-game:${id}`
const summaryKey = (id:string) => `personal-summary:${id}`
export const getPersonalGame = (id:string) => read<PersonalGame>(recordKey(id))
export function gameView(game:PersonalGame, side:'white'|'black'='white'):Variation {
 return { id:`personal:${game.id}`, opening:game.headers.Opening || game.headers.ECO || 'Personal game', name:`${game.headers.White || 'White'} — ${game.headers.Black || 'Black'}`, startFen:game.startFen, moves:game.moves, pgn:game.originalPgn, side, database:'lichess', filters:{ratings:[1600,1800,2000,2200],speeds:['blitz','rapid','classical']},created:game.imported,stats:{firstTry:0,errors:0,reveals:0,completions:0,totalMs:0},endPosition:'',fallback:false, imported:true,analysis:game.analysis }
}
export async function putPersonalGame(game:PersonalGame) {
 const {originalPgn:_pgn,annotationVersions:_versions,startFen:_fen,moves:_moves,analysis:_analysis,...summary}=game
 const database=await db()
 await new Promise<void>((resolve,reject)=>{ const tx=database.transaction('items','readwrite'); tx.objectStore('items').put(game,recordKey(game.id));tx.objectStore('items').put(summary,summaryKey(game.id));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error) })
}
export async function updatePersonalGame(id:string, change:(game:PersonalGame)=>PersonalGame):Promise<PersonalGame> {
 const database=await db()
 return new Promise((resolve,reject)=>{
  const tx=database.transaction('items','readwrite'),store=tx.objectStore('items'),request=store.get(recordKey(id))
  let next:PersonalGame
  request.onsuccess=()=>{
   try {
    if(!request.result)throw Error('Personal game not found.')
    next=change(request.result)
    const {originalPgn:_pgn,annotationVersions:_versions,startFen:_fen,moves:_moves,analysis:_analysis,...summary}=next
    store.put(next,recordKey(id));store.put(summary,summaryKey(id))
   } catch(error) {tx.abort();reject(error)}
  }
  tx.oncomplete=()=>resolve(next);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)
 })
}
// Only metadata is scanned; PGNs and move arrays stay on disk until a game is opened.
export async function gameSummaries():Promise<GameSummary[]> {
 const database=await db()
 return new Promise((resolve,reject)=>{const req=database.transaction('items').objectStore('items').getAll(IDBKeyRange.bound('personal-summary:','personal-summary:\uffff'));req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})
}
export function splitGames(text:string):string[] {
 if(text.length>20_000_000) throw Error('Import at most 20 MB at a time.')
 const games:string[]=[];let start=0,depth=0,comment=false,semicolon=false,tag=false,quoted=false,movetext=false
 const flush=(end:number)=>{const pgn=text.slice(start,end).trim();if(pgn)games.push(pgn);start=end;movetext=false}
 for(let i=0;i<text.length;i++){
  const c=text[i]
  if(semicolon){if(c==='\n')semicolon=false;continue}
  if(comment){if(c==='}')comment=false;continue}
  if(tag){if(c==='"'&&text[i-1]!=='\\')quoted=!quoted;if(c===']'&&!quoted)tag=false;continue}
  if(c==='{'){comment=true;continue}
  if(c===';'){semicolon=true;continue}
  if(c==='['&&depth===0){if(movetext)flush(i);tag=true;continue}
  if(c==='('){depth++;continue}if(c===')'){depth=Math.max(0,depth-1);continue}
  if(depth||/\s/.test(c))continue
  movetext=true
  if(i===0||/\s/.test(text[i-1])){
   const result=text.slice(i,i+8).match(/^(1\/2-1\/2|1-0|0-1|\*)(?=\s|$)/)
   if(result){i+=result[1].length-1;flush(i+1)}
  }
 }
 flush(text.length)
 return games
}
export async function parsePersonalGame(pgn:string):Promise<PersonalGame> {
 if(pgn.length>500_000)throw Error('A single game exceeds the 500 KB parsing limit.')
 const game=new Chess();game.loadPgn(pgn)
 const headers=game.getHeaders()
 if(headers.Variant && !['Standard','From Position'].includes(headers.Variant))throw Error('Only standard chess is supported.')
 const history=game.history({verbose:true})
 if(!history.length)throw Error('No legal moves found.')
 if(history.length>2000)throw Error('Game exceeds 2,000 plies.')
 const startFen=history[0].before
 const moves=history.map(m=>({uci:m.from+m.to+(m.promotion||''),san:m.san,source:'import' as const}))
 const match=headers.Site?.match(/^https?:\/\/(?:www\.)?lichess\.org\/([a-zA-Z0-9]{8})(?:[a-zA-Z0-9]{4})?(?:[\/#?]|$)/)
 const externalId=match?.[1]
 const identity=JSON.stringify([startFen,moves.map(m=>m.uci),...['Event','Site','Date','UTCDate','UTCTime','Round','White','Black','Result','TimeControl'].map(k=>headers[k]||'')])
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity)))).map(n=>n.toString(16).padStart(2,'0')).join('')
 return {id:externalId?`lichess-${externalId}`:hash,source:externalId?'lichess':'pgn',externalId,headers,imported:Date.now(),plies:moves.length,analyzed:false,bookmarks:[],originalPgn:pgn,annotationVersions:[],startFen,moves}
}
export async function importGames(text:string,signal?:AbortSignal,onProgress?:(n:number)=>void) {
 const summary={imported:0,duplicates:0,updated:0,invalid:0,errors:[] as string[]}
 for(const [i,pgn] of splitGames(text).entries()) {
  signal?.throwIfAborted()
  try {
   const game=await parsePersonalGame(pgn), old=await getPersonalGame(game.id)
   if(old) {
    if(old.startFen!==game.startFen || old.moves.map(m=>m.uci).join(' ')!==game.moves.map(m=>m.uci).join(' '))throw Error('Source ID conflicts with an existing game; original preserved.')
    const known=[old.originalPgn,...old.annotationVersions]
    if(known.includes(pgn))summary.duplicates++
    else { await updatePersonalGame(game.id,current=>({...current,headers:{...game.headers,...Object.fromEntries(Object.entries(current.headers).filter(([,v])=>v && v!=='?'))},annotationVersions:[...new Set([...current.annotationVersions,pgn])]})); summary.updated++ }
   } else {await putPersonalGame(game);summary.imported++}
  }catch(error){summary.invalid++;summary.errors.push(`Game ${i+1}: ${(error as Error).message}`)}
  onProgress?.(i+1)
  if(i%20===0)await new Promise(resolve=>setTimeout(resolve,0))
 }
 return summary
}
export type GameFilter={search?:string;player?:string;color?:string;result?:string;opening?:string;since?:string;until?:string;time?:string;minRating?:string;analyzed?:string;bookmarked?:boolean;sort?:string}
export function filterGames(rows:GameSummary[],f:GameFilter) {
 const player=f.player?.toLowerCase().trim()
 return rows.filter(g=>{
  const h=g.headers,color=player?h.White?.toLowerCase()===player?'white':h.Black?.toLowerCase()===player?'black':undefined:undefined
  const result=h.Result==='1/2-1/2'?'draw':color && ['1-0','0-1'].includes(h.Result)?(h.Result===(color==='white'?'1-0':'0-1')?'win':'loss'):'unknown'
  const date=(h.UTCDate||h.Date||'').replaceAll('.','-'), rating=Number(h[color==='black'?'WhiteElo':'BlackElo'])
  return (!f.search||Object.values(h).join(' ').toLowerCase().includes(f.search.toLowerCase())) && (!f.color||color===f.color) && (!f.result||result===f.result) && (!f.opening||(h.Opening||h.ECO||'').toLowerCase().includes(f.opening.toLowerCase())) && (!f.since||date>=f.since) && (!f.until||date<=f.until) && (!f.time||(h.TimeControl||'').includes(f.time)) && (!f.minRating||!!color&&rating>=Number(f.minRating)) && (!f.analyzed||g.analyzed===(f.analyzed==='yes')) && (!f.bookmarked||g.bookmarks.length>0)
 }).sort((a,b)=>{const key=(g:GameSummary)=>f.sort==='opening'?g.headers.Opening||'':f.sort==='result'?g.headers.Result||'':g.headers.UTCDate||g.headers.Date||String(g.imported);return f.sort==='rating'?Number(b.headers.BlackElo||0)-Number(a.headers.BlackElo||0):f.sort==='oldest'?key(a).localeCompare(key(b)):key(b).localeCompare(key(a))})
}
let lichessCooldown=0
export async function fetchPersonalGames(input:string, options:{since?:string;until?:string;speed?:string}={},signal?:AbortSignal) {
 if(Date.now()<lichessCooldown)throw Error('Lichess rate limit: wait one minute before retrying.')
 let path:string
 if(/^https?:/.test(input)) {
  const url=new URL(input);const id=url.pathname.split('/')[1]
  if(url.hostname!=='lichess.org'|| !/^[a-zA-Z0-9]{8}(?:[a-zA-Z0-9]{4})?$/.test(id))throw Error('Enter a valid lichess.org game URL.')
  path=`/game/export/${id.slice(0,8)}?opening=true&clocks=true&evals=true`
 } else {
  if(!/^[a-zA-Z0-9_-]{2,30}$/.test(input))throw Error('Enter a Lichess username or game URL.')
  const q=new URLSearchParams({max:'100',ongoing:'false',finished:'true',opening:'true',clocks:'true',evals:'true',sort:'dateDesc'})
  if(options.since)q.set('since',String(new Date(options.since+'T00:00:00Z').getTime()))
  if(options.until)q.set('until',String(new Date(options.until+'T23:59:59Z').getTime()))
  if(options.speed)q.set('perfType',options.speed)
  path=`/api/games/user/${encodeURIComponent(input)}?${q}`
 }
 const token=lichessToken(),response=await fetch('/api/generation/personal-games?path='+encodeURIComponent(path),{signal,headers:{Accept:'application/x-chess-pgn',...(token?{Authorization:`Bearer ${token}`}:{})}})
 if(response.status===429){lichessCooldown=Date.now()+60000;throw Error('Lichess rate limit: wait one minute before retrying.')}
 if(!response.ok)throw Error(`Lichess import failed (${response.status}). PGN file import remains available.`)
 const text=await response.text()
 const completed=[]
 for(const pgn of splitGames(text)){const game=new Chess();game.loadPgn(pgn);if(['1-0','0-1','1/2-1/2'].includes(game.getHeaders().Result))completed.push(pgn)}
 return completed.join('\n\n')
}
export function criticalMoments(game:PersonalGame) {
 const points=game.analysis?.points||[]
 return points.flatMap((point,i)=>{const before=points[i-1];if(!before||!point||before.cp===undefined||point.cp===undefined)return [];const delta=Math.abs(point.cp-before.cp);return delta>=150?[{ply:i-1,label:`Evaluation changed ${(delta/100).toFixed(1)} pawns · review decision`}]:[]})
}
