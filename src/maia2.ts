import type { HumanModelProvider, HumanPrediction } from './humanModel'

export const maia2: HumanModelProvider = {
  id: 'maia2-rapid', version: '0.11.0', minRating: 400, maxRating: 3000,
  async predict(fen, rating, signal) {
    const response = await fetch('/maia/predict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen, rating }), signal })
    if (!response.ok) throw new Error(`Local Maia-2 service unavailable (HTTP ${response.status})`)
    return response.json() as Promise<HumanPrediction>
  },
}
