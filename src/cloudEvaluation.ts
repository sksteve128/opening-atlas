import { Chess } from 'chess.js'
import { identity } from './core'
import { read, write } from './data'
import type { Evaluation } from './engine'

// Cloud results are display-only: never enter the local verification cache.
export function parseCloudEvaluation(fen: string, value: unknown): Evaluation[] | undefined {
  const data = value as { fen?: string; depth?: number; knodes?: number; pvs?: { cp?: number; mate?: number; moves?: string }[] }
  try {
    if (!data || typeof data.fen !== 'string' || identity(data.fen) !== identity(fen) || !Number.isInteger(data.depth) || data.depth! < 1 || !Number.isFinite(data.knodes) || !Array.isArray(data.pvs) || !data.pvs.length || data.pvs.length > 5) return
    const sign = fen.split(' ')[1] === 'w' ? 1 : -1
    const entries = data.pvs.map(pv => {
      if (typeof pv.moves !== 'string' || !pv.moves.trim() || !(Number.isFinite(pv.cp) !== Number.isFinite(pv.mate))) throw new Error('Invalid cloud score')
      const game = new Chess(fen)
      const line = pv.moves.trim().split(/\s+/).map(uci => {
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Invalid cloud move')
        const from = uci.slice(0,2), to = uci.slice(2,4)
        // Lichess uses king-to-rook castling even in standard chess.
        const castle = game.moves({verbose:true}).find(m => m.from === from && (m.flags.includes('k') && to === `h${from[1]}` || m.flags.includes('q') && to === `a${from[1]}`))
        const move = game.move({from, to: castle?.to || to, promotion:uci[4]})
        return move.from+move.to+(move.promotion||'')
      })
      const mate = pv.mate === undefined ? undefined : sign * pv.mate
      return {source:'cloud' as const, depth:data.depth!, cloud:{knodes:data.knodes!, candidates:data.pvs!.length}, line, mate, cp:mate === undefined ? sign*pv.cp! : Math.sign(mate)*(100000-Math.abs(mate))}
    })
    if(new Set(entries.map(e=>e.line[0])).size !== entries.length) return
    return entries.sort((a,b)=>b.cp-a.cp)
  } catch { return }
}
const key = 'cloud-evaluations:v1'
const cache = new Map<string, { at: number; value: unknown }>()
let loaded: Promise<void> | undefined, busy = false, nextRequest = 0
export async function cloudEvaluation(fen: string, signal?: AbortSignal) {
  await (loaded ||= read<[string,{at:number;value:unknown}][]>(key).then(rows => { if(Array.isArray(rows)) for(const [fen,entry] of rows.slice(-100)) if(entry && Number.isFinite(entry.at)) cache.set(fen,entry) }).catch(()=>{}))
  if(signal?.aborted) return
  const hit=cache.get(fen)
  if(hit && Date.now()-hit.at < (hit.value ? 7*86400000 : 15*60000)) return parseCloudEvaluation(fen,hit.value)
  if(busy || Date.now()<nextRequest) return
  busy=true;nextRequest=Date.now()+5000
  try {
    const response=await fetch(`https://lichess.org/api/cloud-eval?${new URLSearchParams({fen,multiPv:'4',variant:'standard'})}`,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)})
    if(response.status===429 || response.status===401 || response.status===403){nextRequest=Date.now()+60000;return}
    if(!response.ok && response.status!==404)return
    const value=response.status===404?null:await response.json(), result=value?parseCloudEvaluation(fen,value):undefined
    if(value && !result)return
    cache.set(fen,{at:Date.now(),value});while(cache.size>100)cache.delete(cache.keys().next().value!)
    void write(key,[...cache]).catch(()=>{})
    return result
  } catch { return } finally {busy=false}
}
