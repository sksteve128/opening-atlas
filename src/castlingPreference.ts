import { Chess } from 'chess.js'
import type { Evaluation } from './engine'
import type { Generation, Sources, Variation } from './learning'
import { legalGenerationMoves } from './moveExclusions'
import { styleScore } from './generationStyle'
export type CastlingPreference = 'none' | 'kingside' | 'queenside'
export type CastlingDecision = { preference: CastlingPreference; accepted: boolean; reason: string; lossCp?: number; depth?: number; plan?: string[] }
export const parseCastlingPreference = (value: unknown): CastlingPreference => value === 'kingside' || value === 'queenside' ? value : 'none'
export const castlingTolerance = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 30
const castleSan = (preference: CastlingPreference) => preference === 'queenside' ? 'O-O-O' : 'O-O'
export function hasCastlingRight(fen: string, side: Generation['side'], preference: CastlingPreference) {
  const right = preference === 'queenside' ? 'q' : 'k'
  return preference !== 'none' && fen.split(' ')[2].includes(side === 'white' ? right.toUpperCase() : right)
}
// A legal Stockfish PV is evidence of a feasible plan, not a promise about human replies.
export function castlingPlan(fen: string, pv: string[], side: Generation['side'], preference: CastlingPreference, exclusions: Generation['exclusions'] = {}) {
  const game = new Chess(fen)
  for (let i = 0; i < Math.min(12, pv.length); i++) {
    const mine = game.turn() === side[0], uci = pv[i]
    if (mine && !legalGenerationMoves(game.fen(), side, exclusions).some(move => move.uci === uci)) return undefined
    try {
      const move = game.move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci[4] })
      if (mine && move.san.replace(/[+#]/g,'') === castleSan(preference)) return pv.slice(0,i+1)
      if (!hasCastlingRight(game.fen(),side,preference)) return undefined
    } catch { return undefined }
  }
}
export function castlingSummary(options: Pick<Generation,'castlingPreference'|'castlingToleranceCp'|'side'|'startFen'|'exploration'>, moves: Variation['moves']) {
  const preference = options.exploration?.mode === 'explore' ? 'none' : parseCastlingPreference(options.castlingPreference)
  if (preference === 'none') return { castlingPreference: preference, castlingToleranceCp: castlingTolerance(options.castlingToleranceCp) }
  const game = new Chess(options.startFen)
  let satisfied = false
  for (const move of moves) { const mine = game.turn() === options.side[0]; const played = game.move({from:move.uci.slice(0,2),to:move.uci.slice(2,4),promotion:move.uci[4]}); if (mine && played.san.replace(/[+#]/g,'') === castleSan(preference)) satisfied = true }
  return { castlingPreference: preference, castlingToleranceCp: castlingTolerance(options.castlingToleranceCp), castlingOutcome: satisfied ? 'satisfied' as const : hasCastlingRight(game.fen(),options.side,preference) ? 'not reached' as const : 'unavailable — castling rights lost' as const }
}
export async function selectCastlingMove(fen: string, selected: Evaluation, options: Generation, analyze: Sources['analyze'], signal?: AbortSignal, entries?: Evaluation[], baseline?: Evaluation, history?: Variation['moves']): Promise<{ entry: Evaluation; decision?: CastlingDecision }> {
  const preference = options.exploration?.mode === 'explore' ? 'none' : parseCastlingPreference(options.castlingPreference)
  if (preference === 'none' || fen.split(' ')[1] !== options.side[0]) return { entry: selected }
  const reject = (reason: string, extra: Partial<CastlingDecision> = {}) => ({ entry: selected, decision: { preference, accepted:false, reason, ...extra } })
  if (!hasCastlingRight(fen,options.side,preference)) {
    if (history && (castlingSummary(options, history).castlingOutcome === 'satisfied' || history.some(move => move.castling?.reason.includes('rights lost')))) return { entry: selected }
    return reject('Preferred castling unavailable: rights lost; preference inactive.')
  }
  const allowed = legalGenerationMoves(fen,options.side,options.exclusions).filter(move => fen !== (options.rootFen || options.startFen) || !options.excludeRootMoves?.includes(move.uci))
  const legalCastle = allowed.find(move => move.san.replace(/[+#]/g,'') === castleSan(preference))
  const tolerance = castlingTolerance(options.castlingToleranceCp), depth = Math.max(18,options.engineDepth), timeout = options.engineTimeoutMs ?? 30000
  const complete = (entry: Evaluation | undefined, at: number) => !!entry && entry.depth >= at && Number.isFinite(entry.cp) && entry.mate === undefined && !entry.search?.stoppedByBudget && entry.search?.multiPVComplete !== false
  try {
    signal?.throwIfAborted()
    const discovery = entries || (legalCastle ? [] : await analyze(fen,3,12,signal,timeout))
    const plans = discovery.filter(e => complete(e,10) && allowed.some(m=>m.uci===e.line[0])).map(entry => ({ entry, plan:castlingPlan(fen,entry.line,options.side,preference,options.exclusions) })).filter(item=>item.plan)
    const candidates = plans.sort((a,b)=> a.plan!.length-b.plan!.length || (options.style && options.style !== 'best' ? styleScore(fen,b.entry.line[0],options.style)-styleScore(fen,a.entry.line[0],options.style) : 0) || b.entry.cp-a.entry.cp).map(item=>item.entry.line[0])
    if (legalCastle) candidates.unshift(legalCastle.uci)
    const shortlist = [...new Set(candidates)].slice(0,2)
    if (!shortlist.length) return reject('No feasible preferred castle in the bounded engine continuations.')
    const knownBest = baseline || discovery[0]
    const best = complete(knownBest,depth) ? knownBest! : (await analyze(fen,1,depth,signal,timeout))[0]
    if (!complete(best,depth)) return reject('Unrestricted soundness baseline incomplete or mating score.')
    let rejected: CastlingDecision | undefined
    for (const move of shortlist) {
      const cached = discovery.find(entry => entry.line[0] === move && complete(entry, best.depth) && entry.depth === best.depth)
      const checked = best.line[0] === move ? best : cached || (await analyze(fen,1,best.depth,signal,timeout,false,[move]))[0]
      if (!complete(checked,depth) || checked.depth !== best.depth || checked.line[0] !== move) { rejected={preference,accepted:false,reason:'Preferred candidate verification incomplete.'}; continue }
      const lossCp = Math.max(0,best.cp-checked.cp), plan = castlingPlan(fen,checked.line,options.side,preference,options.exclusions)
      if (lossCp > tolerance || !plan) { rejected={preference,accepted:false,reason:lossCp>tolerance ? 'Preferred plan rejected: evaluation loss exceeds tolerance.' : 'Preferred plan disappeared under deeper verification.',lossCp,depth}; continue }
      return {entry:checked,decision:{preference,accepted:true,reason:plan.length===1?'Preferred castle verified within tolerance.':'Preparation verified: preferred castle occurs in the engine continuation.',lossCp,depth,plan}}
    }
    return { entry:selected, decision:rejected }
  } catch (error) { if (signal?.aborted || (error as Error).name === 'AbortError') throw error; return reject('Preferred plan unverified: '+(error as Error).message) }
}
