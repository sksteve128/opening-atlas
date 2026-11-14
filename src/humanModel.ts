import { Chess } from 'chess.js'
import { identity } from './core'

export type HumanPrediction = { model: string; version: string; rating: number; calibrated: boolean; moves: { uci: string; probability: number }[] }
// Providers perform inference off the UI thread and load their model once.
export type HumanModelProvider = { id: string; version: string; minRating: number; maxRating: number; predict: (fen: string, rating: number, signal: AbortSignal) => Promise<HumanPrediction> }
export const humanModelUnavailable = 'Human model unavailable: local Maia-2 service is not ready.'
export async function humanPrediction(provider: HumanModelProvider, fen: string, rating: number, signal: AbortSignal, budgetMs: number, cache: Map<string, HumanPrediction>) {
  if (!Number.isFinite(rating) || rating < provider.minRating || rating > provider.maxRating) throw new Error('Target rating unsupported by human model.')
  const key = `${provider.id}:${provider.version}:${rating}:${identity(fen)}`
  signal.throwIfAborted()
  const saved = cache.get(key); if (saved) return saved
  const active = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, budgetMs))])
  let abort: () => void = () => {}
  try {
    const prediction = await Promise.race([provider.predict(fen, rating, active), new Promise<never>((_, reject) => { abort = () => reject(active.reason); active.addEventListener('abort', abort, { once: true }); if (active.aborted) abort() })])
    active.throwIfAborted()
    if (prediction.model !== provider.id || prediction.version !== provider.version || prediction.rating !== rating || !Array.isArray(prediction.moves)) throw new Error('Invalid human-model provenance.')
    const legal = new Set(new Chess(fen).moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''))), seen = new Set<string>()
    const moves = prediction.moves.filter(m => {
      if (!Number.isFinite(m.probability) || m.probability < 0 || seen.has(m.uci)) throw new Error('Invalid model probabilities.')
      seen.add(m.uci); return legal.has(m.uci) && m.probability > 0
    })
    const mass = moves.reduce((sum, m) => sum + m.probability, 0)
    if (!(mass > 0) || !Number.isFinite(mass)) throw new Error('No legal model predictions.')
    const result = { ...prediction, moves: moves.map(m => ({ ...m, probability: m.probability / mass })) }
    cache.set(key, result); return result
  } finally { active.removeEventListener('abort', abort) }
}
