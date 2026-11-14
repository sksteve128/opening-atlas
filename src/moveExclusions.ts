import { Chess } from 'chess.js'
import { identity, type Side } from './core'

export type MoveExclusions = Record<string, string[]>
export const EXCLUSIONS_STORAGE = 'opening-atlas-move-exclusions-v1'
// Halfmove clock affects draw rules; fullmove numbering does not.
export function exclusionKey(fen: string, side: Side) { return `${side}|${identity(fen)} ${new Chess(fen).fen().split(' ')[4]}` }
export function legalGenerationMoves(fen: string, side: Side, exclusions: MoveExclusions = {}) {
  const excluded = fen.split(' ')[1] === (side === 'white' ? 'w' : 'b') ? exclusions[exclusionKey(fen, side)] || [] : []
  return new Chess(fen).moves({ verbose: true }).map(m => ({ uci: m.from + m.to + (m.promotion || ''), san: m.san })).filter(m => !excluded.includes(m.uci))
}
export function readExclusions(): MoveExclusions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(EXCLUSIONS_STORAGE) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([key, moves]) => {
      const match = /^(white|black)\|(.+)$/.exec(key)
      if (!match || !Array.isArray(moves) || !moves.every(m => typeof m === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m))) return []
      try { return [[exclusionKey(match[2] + ' 1', match[1] as Side), moves]] } catch { return [] }
    }))
  } catch { return {} }
}
