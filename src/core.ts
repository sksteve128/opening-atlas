import { Chess, type Move } from 'chess.js'

export type Side = 'white' | 'black'
export type Mode = 'coverage' | 'realistic' | 'weakness' | 'spaced' | 'breadth' | 'depth'
export type ExplorerMove = { uci: string; san: string; white: number; draws: number; black: number; averageRating?: number }
export type ExplorerData = { unavailableReason?: string; cache?: { state: 'live' | 'refreshed' | 'cached' | 'stale'; retrievedAt: number }; white: number; draws: number; black: number; opening?: { name: string }; moves: ExplorerMove[]; source?: 'lichess' | 'masters' | 'book' }
export type ExplorerPerspective = 'white' | 'black' | 'both'
export type ExplorerSort = 'played' | 'white' | 'black' | 'draws'
export type Choice = 'preferred' | 'sound' | 'inaccurate' | 'blunder'
export type Repertoire = Record<string, Record<string, Choice>>
export type Review = { tries: number; successes: number; failures: number; streak: number; last: number; due: number; totalMs: number }
export type Reviews = Record<string, Review>
export type GraphPosition = { fen: string; path: string[]; ply: number; expanded: boolean }
export type GraphEdge = { id: string; from: string; to: string; san: string; uci: string; frequency: number }

export const PRESETS: { name: string; side: Side; moves: string[]; family: string }[] = [
  { name: 'Ponziani', side: 'white', family: 'Open games', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'c3'] },
  { name: 'Scotch', side: 'white', family: 'Open games', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4'] },
  { name: 'Italian', side: 'white', family: 'Open games', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] },
  { name: 'French Tarrasch', side: 'white', family: 'French', moves: ['e4', 'e6', 'd4', 'd5', 'Nd2'] },
  { name: 'Alapin Sicilian', side: 'white', family: 'Sicilian', moves: ['e4', 'c5', 'c3'] },
  { name: "Queen's Gambit", side: 'white', family: 'Queen pawn', moves: ['d4', 'd5', 'c4'] },
  { name: 'French Defense', side: 'black', family: 'Against 1.e4', moves: ['e4', 'e6'] },
  { name: 'Accelerated Dragon', side: 'black', family: 'Against 1.e4', moves: ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'g6'] },
  { name: 'Scandinavian', side: 'black', family: 'Against 1.e4', moves: ['e4', 'd5'] },
  { name: 'Caro-Kann', side: 'black', family: 'Against 1.e4', moves: ['e4', 'c6'] },
  { name: "Queen's Gambit Declined", side: 'black', family: 'Against 1.d4', moves: ['d4', 'd5', 'c4', 'e6'] },
  { name: 'Tartakower', side: 'black', family: 'Against 1.d4', moves: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O', 'Nf3', 'h6', 'Bh4', 'b6'] },
  { name: 'Slav', side: 'black', family: 'Against 1.d4', moves: ['d4', 'd5', 'c4', 'c6'] },
  { name: 'Dutch Defense', side: 'black', family: 'Against 1.d4', moves: ['d4', 'f5'] },
]

export function gameFrom(moves: string[]) { const game = new Chess(); moves.forEach(move => game.move(move)); return game }
export function identity(fen: string) {
  const parts = fen.split(' ')
  const game = new Chess(fen)
  // ponytail: ignore move clocks; retain en passant only when a legal capture exists.
  if (parts[3] !== '-' && !game.moves({ verbose: true }).some(m => m.flags.includes('e'))) parts[3] = '-'
  return parts.slice(0, 4).join(' ')
}
export function playUci(fen: string, uci: string): Move | null {
  try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }) } catch { return null }
}
export function nextFen(fen: string, uci: string) {
  const game = new Chess(fen)
  game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  return game.fen()
}
export function moveKey(fen: string, uci: string) { return `${identity(fen)}|${uci}` }
export function isMyTurn(fen: string, side: Side) { return fen.split(' ')[1] === (side === 'white' ? 'w' : 'b') }
export function total(data: ExplorerData) { return data.white + data.draws + data.black }
export function frequency(move: ExplorerMove, data: ExplorerData) { return total(data) ? (move.white + move.draws + move.black) / total(data) : 0 }
export function sampleGames(move: Pick<ExplorerMove, 'white' | 'draws' | 'black'>) {
  return [move.white, move.draws, move.black].every(count => Number.isFinite(count) && count >= 0) ? move.white + move.draws + move.black : null
}
export function outcomeRate(move: Pick<ExplorerMove, 'white' | 'draws' | 'black'>, outcome: 'white' | 'draws' | 'black') {
  const games = sampleGames(move)
  return games ? move[outcome] / games : null
}
export function sortExplorerMoves(moves: ExplorerMove[], sort: ExplorerSort) {
  const games = (move: ExplorerMove) => sampleGames(move) ?? -1
  return [...moves].sort((a, b) => sort === 'played' ? games(b) - games(a) : (outcomeRate(b, sort) ?? -1) - (outcomeRate(a, sort) ?? -1) || games(b) - games(a))
}
export function parseExplorerPerspective(value: string | null): ExplorerPerspective {
  return value === 'white' || value === 'black' ? value : 'both'
}
export function selectMove(moves: ExplorerMove[], data: ExplorerData, mode: Mode, visits: Record<string, number>, reviews: Reviews, fen: string, seed = Math.random()) {
  if (!moves.length) return null
  const ranked = [...moves]
  if (mode === 'coverage') { const least = Math.min(...ranked.map(m => visits[moveKey(fen, m.uci)] || 0)); return ranked.filter(m => (visits[moveKey(fen, m.uci)] || 0) === least)[0] }
  if (mode === 'breadth') return ranked[0]
  if (mode === 'depth') return ranked[ranked.length - 1]
  const now = Date.now()
  const weights = ranked.map(m => {
    const review = reviews[moveKey(fen, m.uci)]
    if (mode === 'weakness') return 1 + (review?.failures || 0) * 3
    if (mode === 'spaced') return review ? Math.max(0.1, (now - review.due) / 86400000 + 1) : 3
    return Math.max(0.001, frequency(m, data))
  })
  let target = seed * weights.reduce((a, b) => a + b, 0)
  return ranked.find((_, i) => (target -= weights[i]) <= 0) || ranked[ranked.length - 1]
}
export function recordReview(old: Review | undefined, success: boolean, durationMs: number, now = Date.now()): Review {
  const successes = (old?.successes || 0) + Number(success)
  const failures = (old?.failures || 0) + Number(!success)
  const streak = success ? Math.min(7, (old?.streak || 0) + 1) : 0
  return { tries: (old?.tries || 0) + 1, successes, failures, streak, last: now, due: now + (success ? 86400000 * 2 ** streak : 600000), totalMs: (old?.totalMs || 0) + durationMs }
}
export function nextRepetition<T extends { start: string; startPly: number; done: number; repetitions: number; fen: string; ply: number }>(session: T): T | null {
  if (session.done + 1 >= session.repetitions) return null
  return { ...session, fen: session.start, ply: session.startPly, done: session.done + 1 }
}
export function coverage(fen: string, side: Side, repertoire: Repertoire, data: Record<string, ExplorerData>, depth: number, visited = new Set<string>()): number | null {
  if (depth <= 0) return 1
  const key = identity(fen)
  const state = `${key}|${depth}`
  if (visited.has(state)) return null
  const explorer = data[key]
  if (!explorer) return null
  if (explorer.source === 'book') return null
  const nextVisited = new Set(visited).add(state)
  if (isMyTurn(fen, side)) {
    const preferred = explorer.moves.filter(m => repertoire[key]?.[m.uci] === 'preferred')
    if (!preferred.length) return 0
    const values = preferred.map(m => coverage(nextFen(fen, m.uci), side, repertoire, data, depth - 1, nextVisited))
    return values.some(v => v === 1) ? 1 : values.every(v => v === null) ? null : Math.max(...values.map(v => v ?? 0))
  }
  const all = total(explorer)
  if (!all) return null
  let result = 0
  let unknown = false
  for (const m of explorer.moves) {
    const value = coverage(nextFen(fen, m.uci), side, repertoire, data, depth - 1, nextVisited)
    if (value === null) unknown = true
    else result += frequency(m, explorer) * value
  }
  return unknown ? null : result
}
