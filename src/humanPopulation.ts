import { Chess } from 'chess.js'
import { identity, total, type ExplorerData } from './core'
import { humanDistribution } from './humanGeneration'
import type { Generation, Sources } from './learning'

// Lichess API rating buckets: each lower bound runs up to the next bucket.
export const supportedRatings = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500]
export type Population = { database: 'lichess' | 'masters'; ratings: number[]; speeds: string[]; tier: 'selected' | 'higher' | 'all' | 'masters'; sparse?: boolean }
export type PopulationAttempt = Population & { games?: number; eligibleGames?: number; error?: string; issue?: 'authentication' | 'rate-limit' | 'network' | 'timeout' | 'malformed' | 'unsupported' | 'zero-games' | 'no-legal-moves' | 'insufficient' }
export function populationLabel(population: Population) {
  return `${population.sparse ? 'Sparse human data · ' : ''}${population.database === 'masters' ? 'Masters database' : `${population.tier === 'selected' ? 'Selected' : 'Expanded'} Lichess · rating groups ${population.ratings.join(', ')} · ${population.speeds.join(', ')}`}`
}
export async function humanPopulation(fen: string, options: Generation, sources: Sources, signal?: AbortSignal, cache = new Map<string, Promise<ExplorerData>>()) {
  const ratings = [...new Set(options.filters.ratings)].sort((a, b) => a - b), speeds = [...options.filters.speeds]
  const higher = supportedRatings.filter(rating => rating >= Math.max(2200, ...ratings))
  const populations: Population[] = options.database === 'masters' ? [{ database: 'masters', ratings: [], speeds: [], tier: 'masters' }] : [
    { database: 'lichess', ratings, speeds, tier: 'selected' },
    ...higher.some(r => !ratings.includes(r)) ? [{ database: 'lichess' as const, ratings: higher, speeds, tier: 'higher' as const }] : [],
    { database: 'lichess', ratings: supportedRatings, speeds, tier: 'all' },
    ...(options.mastersFallback === false ? [] : [{ database: 'masters' as const, ratings: [], speeds: [], tier: 'masters' as const }]),
  ]
  const attempts: PopulationAttempt[] = [], seen = new Set<string>()
  const legal = new Set(new Chess(fen).moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || '')))
  let sparse: { population: Population; data: ExplorerData; dist: NonNullable<ReturnType<typeof humanDistribution>> } | undefined
  for (const population of populations) {
    if (signal?.aborted) throw signal.reason
    const filterKey = `${population.database}:${[...population.ratings].sort((a,b) => a-b)}:${[...population.speeds].sort()}`
    if (seen.has(filterKey)) continue
    seen.add(filterKey)
    const key = identity(fen) + ':' + filterKey
    try {
      let request = cache.get(key)
      if (!request) { request = sources.explorer(fen, { ratings: [...population.ratings], speeds: [...population.speeds] }, signal, population.database); cache.set(key, request) }
      const data = await request
      if (signal?.aborted) throw signal.reason
      if (data.unavailableReason || data.source === 'book') throw new Error(data.unavailableReason || 'Human Explorer unavailable; published book has no game counts.')
      if (![data.white, data.draws, data.black].every(n => Number.isSafeInteger(n) && n >= 0) || !Array.isArray(data.moves)) throw new Error('Malformed Explorer response')
      const dist = humanDistribution(fen, data, options.minPositionGames ?? 20, options.minMoveGames ?? 5)
      const loose = humanDistribution(fen, data, 1, 1)
      const issue = dist ? undefined : total(data) === 0 ? 'zero-games' : !legal.size || !data.moves.some(move => legal.has(move.uci)) ? 'no-legal-moves' : 'insufficient'
      attempts.push({ ...population, games: total(data), eligibleGames: dist?.games ?? loose?.games ?? 0, issue })
      if (dist) return { population, data, dist, attempts }
      if (loose && (!sparse || loose.games > sparse.dist.games)) sparse = { population: { ...population, sparse: true }, data, dist: loose }
    } catch (error) {
      if (signal?.aborted) throw error
      const message = (error as Error).message
      const issue = /401|403/.test(message) ? 'authentication' : /429|rate limit/i.test(message) ? 'rate-limit' : /timeout|timed out/i.test(message) ? 'timeout' : /malformed|invalid explorer|json/i.test(message) ? 'malformed' : /400|404|422|unsupported/i.test(message) ? 'unsupported' : 'network'
      attempts.push({ ...population, error: message, issue })
      // Access failures are not evidence of low coverage; do not try other populations to evade them.
      return { attempts, error: message }
    }
  }
  if (options.limitedHumanData === 'sparse' && sparse) return { ...sparse, attempts }
  return { attempts }
}
