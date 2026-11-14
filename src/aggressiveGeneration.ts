import { Chess } from 'chess.js'
import type { Evaluation } from './engine'
import type { Generation, Sources } from './learning'
import { styleNeedsVerification, styleScore } from './generationStyle'

export type AggressiveOptions = { engine: 'patricia'; maxLossCp: number; relaxed: boolean; equalCp?: number; quietBelow?: number; searchMs?: number }
export type PatriciaResult = { move: string; version: string; durationMs: number; queueMs: number }
export type PatriciaProvider = (fen: string, ms: number, signal?: AbortSignal) => Promise<PatriciaResult>
export type AggressiveDecision = { consulted: boolean; stockfish: string; proposed?: string; selected: string; rejected: boolean; reason: string; lossCp?: number; verifiedDepth?: number; styleGain?: number; version?: string; durationMs: number; queueMs?: number; searches: number }

// Root UCI scores are side-to-move scores. Only run on the user's turn.
export async function aggressiveCandidate(fen: string, best: Evaluation, options: Generation, sources: Sources, allowed: string[], deadline: number, signal?: AbortSignal) {
  const started = Date.now(), config = options.aggressive
  const decision: AggressiveDecision = { consulted: false, stockfish: best.line[0], selected: best.line[0], rejected: true, reason: 'Not triggered', durationMs: 0, searches: 0 }
  const finish = (reason: string, entry = best) => { decision.reason = reason; decision.selected = entry.line[0]; decision.durationMs = Date.now() - started; return { entry, decision } }
  const game = new Chess(fen), mine = game.turn() === (options.side === 'white' ? 'w' : 'b')
  if (options.style !== 'aggressive' || !config || !mine) return finish('Not an aggressive user turn')
  if (![config.maxLossCp, config.equalCp ?? 50, config.quietBelow ?? 35, config.searchMs ?? 500].every(Number.isFinite)) return finish('Invalid aggressive settings')
  const legal = game.moves({ verbose: true })
  const sharp = sources.fastSharpness?.(fen)?.[options.side]
  if (best.mate !== undefined || !Number.isFinite(best.cp) || Math.abs(best.cp) > Math.min(100, config.equalCp ?? 50)) return finish('Outside equal-position trigger')
  if (game.isCheck() || legal.length <= 2 || styleNeedsVerification(fen, best.line)) return finish('Forced or tactical position')
  if (sharp && sharp.score >= (config.quietBelow ?? 35)) return finish('Difficulty above quiet threshold')
  // Limited candidate coverage cannot prove quietness. Fall back to cheap legal-move indicators.
  if (!sharp || sharp.preliminary || sharp.coverage < 0.8) {
    const forcing = legal.filter(m => m.captured || m.promotion || /[+#]/.test(m.san))
    if (forcing.length > 2 || legal.some(m => m.promotion)) return finish('Uncertain sharpness with tactical indicators')
  }
  if (deadline - Date.now() < 4000) return finish('Insufficient analysis budget')
  if (!sources.patricia) return finish('Patricia unavailable; Stockfish retained')
  const end = Math.min(deadline, Date.now() + Math.min(12000, (deadline - Date.now()) / 4))
  const budget = AbortSignal.timeout(Math.max(1, Math.floor(end - Date.now())))
  const active = signal ? AbortSignal.any([signal, budget]) : budget
  const analyze = async (depth: number, moves?: string[]) => {
    active.throwIfAborted(); decision.searches++
    const result = await sources.analyze(fen, 1, depth, active, Math.max(1, Math.min(options.engineTimeoutMs ?? 30000, end - Date.now())), false, moves)
    const e = result[0]
    if (!e || e.depth < depth || e.mate !== undefined || !Number.isFinite(e.cp) || e.source === 'cloud' || e.search?.multiPVComplete === false || !legal.some(m => m.from + m.to + (m.promotion || '') === e.line[0]) || (moves && !moves.includes(e.line[0]))) throw new Error('Required Stockfish verification incomplete or mate score')
    return e
  }
  try {
    decision.consulted = true
    const proposal = await sources.patricia(fen, Math.max(50, Math.min(1000, config.searchMs ?? 500)), active)
    decision.proposed = proposal.move; decision.version = proposal.version; decision.queueMs = proposal.queueMs
    const move = legal.find(m => m.from + m.to + (m.promotion || '') === proposal.move)
    if (!move || !allowed.includes(proposal.move)) return finish('Illegal or excluded Patricia proposal')
    if (proposal.move === best.line[0]) { decision.lossCp = 0; decision.verifiedDepth = best.depth; return finish('Same move as Stockfish') }
    const gain = styleScore(fen, proposal.move, 'aggressive') - styleScore(fen, best.line[0], 'aggressive')
    decision.styleGain = gain
    const depth = Math.max(16, options.engineDepth, best.depth)
    let baseline = best.depth >= depth && best.search?.multiPVComplete !== false && best.source !== 'cloud' ? best : await analyze(depth)
    let candidate = await analyze(depth, [proposal.move])
    const initialLoss = baseline.cp - candidate.cp
    decision.lossCp = Math.max(0, initialLoss)
    decision.verifiedDepth = Math.min(baseline.depth, candidate.depth)
    if (gain < 1) return finish('No meaningful attacking-feature gain')
    const tolerance = Math.max(0, Math.min(config.relaxed ? 50 : 30, config.maxLossCp))
    if (initialLoss > tolerance || initialLoss > 50) return finish('Evaluation loss exceeds tolerance')
    if (initialLoss > 15 && gain < 2) return finish('Insufficient style benefit for evaluation loss')
    const after = new Chess(fen); after.move(move)
    const enemy = game.turn() === 'w' ? 'b' : 'w'
    const sacrificeRisk = move.piece !== 'p' && after.isAttacked(move.to, enemy)
    if (initialLoss > 30 || sacrificeRisk || move.captured || styleNeedsVerification(fen, candidate.line)) {
      const deeper = Math.max(depth + 2, options.verificationDepth ?? 18)
      const oldBaseline = baseline, oldCandidate = candidate
      baseline = await analyze(deeper); candidate = await analyze(deeper, [proposal.move])
      if (Math.abs(candidate.cp - oldCandidate.cp) > 30 || Math.abs(baseline.cp - oldBaseline.cp) > 30) return finish('Unstable tactical evaluation')
    }
    const loss = baseline.cp - candidate.cp
    decision.lossCp = Math.max(0, loss); decision.verifiedDepth = Math.min(baseline.depth, candidate.depth)
    if (loss > tolerance || loss > 50 || loss > 15 && gain < 2) return finish('Deeper verification rejected preference')
    decision.rejected = false
    return finish('Accepted: attacking features improve within Stockfish tolerance', candidate)
  } catch (error) {
    if (signal?.aborted) throw error
    return finish(`Stockfish retained: ${budget.aborted ? 'verification budget expired' : (error as Error).message}`)
  }
}
