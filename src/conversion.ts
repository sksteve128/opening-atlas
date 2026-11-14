import { Chess, type PieceSymbol } from 'chess.js'
import type { Evaluation } from './engine'
import type { Side } from './core'
import { estimateFastSharpness, type SharpDecision } from './sharpness'
import type { Sources } from './learning'

const values: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
export function material(fen: string) {
  const counts = { white: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, black: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } }
  for (const piece of new Chess(fen).board().flat()) if (piece) counts[piece.color === 'w' ? 'white' : 'black'][piece.type]++
  const sum = (side: Side) => Object.entries(counts[side]).reduce((n, [piece, count]) => n + values[piece as PieceSymbol] * count, 0)
  return { white: sum('white'), black: sum('black'), counts }
}
export type MaterialPoint = { ply: number; white: number; black: number; balance: number; gain: number; event: string }
export function materialPoint(fen: string, startFen: string, side: Side, ply: number, previous?: MaterialPoint): MaterialPoint {
  const now = material(fen), start = material(startFen), opponent = side === 'white' ? 'black' : 'white'
  const balance = now[side] - now[opponent], gain = balance - (start[side] - start[opponent])
  let event = 'Unchanged material'
  if (gain < 0) event = 'Material deficit / possible temporary sacrifice'
  else if (gain === 0 && previous?.gain) event = previous.gain < 0 ? 'Material recovered' : 'Equal exchange / gain returned'
  else if (gain > 0) {
    const mine = now.counts[side], theirs = now.counts[opponent], initialMine = start.counts[side], initialTheirs = start.counts[opponent]
    const net = (piece: PieceSymbol) => initialTheirs[piece] - theirs[piece] - (initialMine[piece] - mine[piece])
    event = net('q') > 0 ? 'Queen gain' : net('r') > 0 && net('n') + net('b') < 0 ? 'Exchange gain' : net('n') + net('b') > 0 ? 'Minor-piece gain' : net('p') > 0 && net('r') === 0 ? 'Pawn gain' : 'Net material gain' 
  }
  if (now.white > (previous?.white ?? start.white) || now.black > (previous?.black ?? start.black)) event = 'Promotion / material recovery'
  return { ply, white: now.white, black: now.black, balance, gain, event }
}
export type ConversionPoint = { ply: number; cp?: number; depth?: number; mate?: number; difficulty?: number; acceptable?: number; sensitivityCp?: number; stable?: boolean; quiet?: boolean; danger?: TacticalEvidence; middlegame?: ReturnType<typeof middlegameEvidence> }
export type ConversionEvidence = { settings?: { minPlies: number; maxDifficulty: number; advantageCp: number }; state: 'none' | 'detected' | 'converting' | 'resolved' | 'predicted-mate' | 'unresolved'; outcome?: 'Advantage secured' | 'Sound middlegame reached' | 'Checkmate' | 'Material advantage secured' | 'Positional advantage stabilized' | 'Theoretical endgame' | 'Sound continuation' | 'Unresolved'; detectedPly?: number; material: MaterialPoint[]; points: ConversionPoint[]; detail?: string; tablebase?: { ply: number; category: string }; modelStatus?: string }

// Screen the actual sequence, not the existence of unrelated legal captures.
export function quietConversion(fen: string, pv: string[], recentSan: string[]) {
  const game = new Chess(fen)
  if (game.isCheck() || /[x+#=]/.test(recentSan.at(-1) || '') || pv.length < 4) return false
  try {
    const first = game.move(pv[0])
    return !first.captured && !first.promotion && !/[+#]/.test(first.san)
  } catch { return false }
}
export function conversionReady(evidence: ConversionEvidence, ply: number, entry: Evaluation, decision: SharpDecision | undefined, quiet: boolean, threshold: number, preferredDifficulty = 35, minPlies = 4) {
  const recent = evidence.points.filter(p => p.cp !== undefined).slice(-3)
  const stable = recent.length >= 3 && recent.every(p => p.depth! >= 12 && p.mate === undefined) && Math.max(...recent.map(p => p.cp!)) - Math.min(...recent.map(p => p.cp!)) <= 100
  // Difficulty is supporting evidence; a high score with several sound choices is not a veto.
  const choices = !!decision && decision.depth >= 8 && Number.isFinite(decision.score) && decision.acceptable >= 2 && (decision.score <= preferredDifficulty || decision.acceptable >= 3 || decision.serious === 0)
  const ready = evidence.detectedPly !== undefined && ply - evidence.detectedPly >= Math.max(4, minPlies) && entry.cp >= threshold && entry.depth >= 12 && entry.mate === undefined && stable && quiet && choices
  return { stable, ready }
}

export type TacticalEvidence = { level: 'low' | 'critical' | 'unknown'; reason: string; reply?: string; replyDepth?: number; responseDepth?: number; responseDifficulty?: number; responseChoices?: number; responseCp?: number }
// ponytail: test one strongest forcing reply, not a tactical tree. This is a preliminary
// screen; deeper verification remains separate and can find threats beyond this horizon.
export async function tacticalEvidence(fen: string, entry: Evaluation, analyze: Sources['analyze']): Promise<TacticalEvidence> {
  const game = new Chess(fen)
  const mine = game.turn() === 'w' ? 'white' : 'black', other = mine === 'white' ? 'black' : 'white'
  const startMaterial = material(fen), balance = startMaterial[mine] - startMaterial[other]
  const unknown = (reason: string): TacticalEvidence => ({ level: 'unknown', reason })
  try {
    game.move(entry.line[0])
    const forcing = game.moves({ verbose: true }).filter(m => m.captured || m.promotion || /[+#]/.test(m.san)).map(m => m.from + m.to + (m.promotion || ''))
    let reply = entry.line[1], replyDepth = entry.depth
    if (forcing.length) {
      const [threat] = await analyze(game.fen(), 1, 12, undefined, undefined, false, forcing)
      if (!threat || threat.depth < 10 || !forcing.includes(threat.line[0]) || !Number.isFinite(threat.cp)) return unknown('Strongest forcing reply could not be assessed.')
      reply = threat.line[0]; replyDepth = threat.depth
      if (threat.mate !== undefined || -threat.cp < entry.cp - 100) return { level: 'critical', reason: 'Forcing reply changes the evaluation or predicts mate.', reply, replyDepth }
    }
    const forcingMove = game.move(reply)
    const entries = await analyze(game.fen(), 4, 10)
    if (entries.some(e => e.search?.multiPVComplete === false || e.depth < 8 || !Number.isFinite(e.cp))) return unknown('Response analysis is incomplete.')
    const response = estimateFastSharpness(game.fen(), entries), best = [...entries].sort((a, b) => b.cp - a.cp)[0]
    if (!response || !best) return unknown('Response choices were not measured.')
    // A losing check may offer a bonus win. Declining that bonus is not losing
    // the original advantage, so count responses that preserve the root evaluation.
    const preserving = entries.filter(e => e.mate === undefined && e.cp >= entry.cp - 70)
    const info = { reply, replyDepth, responseDepth: response.depth, responseDifficulty: response.score, responseChoices: preserving.length, responseCp: best.cp }
    if (best.mate !== undefined || best.cp < entry.cp - 100) return { ...info, level: 'critical', reason: 'The forcing reply materially reduces the evaluation or predicts mate.' }
    const after = new Chess(game.fen()), move = after.move(best.line[0]), endMaterial = material(after.fen())
    const ordinaryExchange = !!forcingMove.captured && !!move.captured && move.to === forcingMove.to && !move.promotion && !/[+#]/.test(move.san) && endMaterial[mine] - endMaterial[other] >= balance
    if (ordinaryExchange) return { ...info, level: 'low', reason: 'Strongest forcing reply leads to an ordinary recapture; material and evaluation are preserved.' }
    const quietResponse = preserving.some(e => {
      const responseBoard = new Chess(game.fen()), m = responseBoard.move(e.line[0])
      return !m.captured && !m.promotion && !/[+#]/.test(m.san)
    })
    if (preserving.length < 2 || !quietResponse) return { ...info, level: 'critical', reason: 'The reply requires a precise response or continues a forcing sequence.' }
    return { ...info, level: 'low', reason: forcing.length ? 'Strongest legal forcing reply allows multiple responses preserving the existing evaluation, including a quiet response.' : 'Principal reply allows multiple responses preserving the existing evaluation, including a quiet response.' }
  } catch { return unknown('Tactical response analysis unavailable.') }
}

export function middlegameEvidence(fen: string) {
  const game = new Chess(fen), board = game.board().flat().filter(p => !!p)
  const sides = (['w', 'b'] as const).map(color => {
    const home = color === 'w' ? '1' : '8', pawnHome = color === 'w' ? '2' : '7'
    const undeveloped = board.filter(p => p.color === color && /[nb]/.test(p.type) && p.square[1] === home && 'bcfg'.includes(p.square[0])).length
    const king = board.find(p => p.color === color && p.type === 'k')!
    const queens = board.some(p => p.color !== color && p.type === 'q')
    const safeKing = !game.isAttacked(king.square, color === 'w' ? 'b' : 'w') && (!queens || (king.square[1] === home && 'bcg'.includes(king.square[0])))
    const centralPawnsMoved = 2 - board.filter(p => p.color === color && p.type === 'p' && 'de'.includes(p.square[0]) && p.square[1] === pawnHome).length
    return { color, developed: 4 - undeveloped, safeKing, centralPawnsMoved }
  })
  const moveNumber = Number(fen.split(' ')[5])
  return { moveNumber, sides, suitable: moveNumber >= 8 && sides.every(s => s.developed >= 2 && s.safeKing && s.centralPawnsMoved >= 1) }
}

// ponytail: use the evaluations and moves already collected; no extra engine search at the length checkpoint.
export function instructionalEndpoint(fen: string, recentSan: string[], evidence: ConversionEvidence) {
  const evaluations = evidence.points.filter(point => point.cp !== undefined).slice(-3)
  const stable = evaluations.length === 3 && evaluations.every(point => (point.depth ?? 0) >= 12 && point.mate === undefined)
    && Math.max(...evaluations.map(point => point.cp!)) - Math.min(...evaluations.map(point => point.cp!)) <= 100
  const last = evaluations.at(-1), material = evidence.material.at(-1)
  const forcingSequence = recentSan.slice(-4).some(san => /[x+#=]/.test(san))
  const tacticalWarning = evidence.points.slice(-2).some(point => point.mate !== undefined || point.danger && point.danger.level !== 'low')
  return !!last && stable && last.cp! >= -75 && evidence.detectedPly === undefined && !forcingSequence
    && !tacticalWarning && (material?.gain ?? 0) >= 0 && middlegameEvidence(fen).suitable
}
