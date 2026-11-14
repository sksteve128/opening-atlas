import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { coverage, frequency, gameFrom, identity, moveKey, nextFen, nextRepetition, outcomeRate, parseExplorerPerspective, playUci, recordReview, sampleGames, selectMove, sortExplorerMoves, type ExplorerData, type Repertoire } from './core'

const moves = (items: [string, string, number][]): ExplorerData => ({ white: items.reduce((n, m) => n + m[2], 0), draws: 0, black: 0, moves: items.map(([uci, san, white]) => ({ uci, san, white, draws: 0, black: 0 })) })

describe('opening model', () => {
  it('calculates explorer outcomes and sorts without changing the Lichess response', () => {
    const data: ExplorerData = { white: 55, draws: 25, black: 40, moves: [
      { uci: 'e2e4', san: 'e4', white: 45, draws: 25, black: 30 },
      { uci: 'd2d4', san: 'd4', white: 10, draws: 0, black: 10 },
      { uci: 'g1f3', san: 'Nf3', white: 0, draws: 0, black: 0 },
    ] }
    expect([frequency(data.moves[0], data), outcomeRate(data.moves[0], 'white'), outcomeRate(data.moves[0], 'draws'), outcomeRate(data.moves[0], 'black')]).toEqual([100 / 120, .45, .25, .30])
    expect(outcomeRate(data.moves[2], 'white')).toBeNull()
    expect(sampleGames({ white: 4, draws: undefined, black: 2 } as unknown as ExplorerData)).toBeNull()
    expect(['played', 'white', 'black', 'draws'].map(sort => sortExplorerMoves(data.moves, sort as 'played' | 'white' | 'black' | 'draws').map(move => move.san))).toEqual([
      ['e4', 'd4', 'Nf3'], ['d4', 'e4', 'Nf3'], ['d4', 'e4', 'Nf3'], ['e4', 'd4', 'Nf3'],
    ])
    expect(data.moves.map(move => move.san)).toEqual(['e4', 'd4', 'Nf3'])
    expect(['white', 'black', 'both', null, 'invalid'].map(parseExplorerPerspective)).toEqual(['white', 'black', 'both', 'both', 'both'])
  })
  it('validates legal moves and repertoire keys', () => {
    const fen = new Chess().fen()
    expect(playUci(fen, 'e2e4')?.san).toBe('e4')
    expect(playUci(fen, 'e2e5')).toBeNull()
    expect(moveKey(fen, 'e2e4')).toBe(`${identity(fen)}|e2e4`)
  })
  it('handles castling, promotion, and en passant through chess.js', () => {
    const castle = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
    expect(playUci(castle, 'e1g1')?.san).toBe('O-O')
    expect(new Chess(nextFen(castle, 'e1g1')).get('f1')?.type).toBe('r')
    const promotion = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1'
    expect(playUci(promotion, 'a7a8q')?.promotion).toBe('q')
    const ep = gameFrom(['e4', 'a6', 'e5', 'd5']).fen()
    expect(playUci(ep, 'e5d6')?.flags).toContain('e')
  })
  it('merges transpositions but preserves castling and legal en passant', () => {
    expect(identity(gameFrom(['Nf3', 'Nf6', 'g3', 'g6']).fen())).toBe(identity(gameFrom(['g3', 'g6', 'Nf3', 'Nf6']).fen()))
    const fen = new Chess().fen()
    expect(identity(fen)).not.toBe(identity(fen.replace('KQkq', '-')))
    const ep = gameFrom(['e4', 'a6', 'e5', 'd5']).fen()
    expect(identity(ep)).not.toBe(identity(ep.replace(' d6 ', ' - ')))
    expect(identity(gameFrom(['e4']).fen())).toBe(identity(gameFrom(['e4']).fen().replace(' e3 ', ' - ')))
  })
  it('selects uncovered branches and real-frequency weighted moves', () => {
    const fen = gameFrom(['e4']).fen()
    const data = moves([['e7e5', 'e5', 60], ['c7c5', 'c5', 40]])
    expect(selectMove(data.moves, data, 'realistic', {}, {}, fen, 0.1)?.uci).toBe('e7e5')
    expect(selectMove(data.moves, data, 'realistic', {}, {}, fen, 0.9)?.uci).toBe('c7c5')
    expect(selectMove(data.moves, data, 'coverage', { [moveKey(fen, 'e7e5')]: 1 }, {}, fen)?.uci).toBe('c7c5')
    expect(selectMove(data.moves, data, 'breadth', {}, {}, fen)?.uci).toBe('e7e5')
    expect(selectMove(data.moves, data, 'depth', {}, {}, fen)?.uci).toBe('c7c5')
  })
  it('calculates path probability from conditional frequencies', () => {
    const start = new Chess().fen(), afterE4 = nextFen(start, 'e2e4'), afterE5 = nextFen(afterE4, 'e7e5'), afterC5 = nextFen(afterE4, 'c7c5')
    const data = { [identity(start)]: moves([['e2e4', 'e4', 100]]), [identity(afterE4)]: moves([['e7e5', 'e5', 60], ['c7c5', 'c5', 40]]), [identity(afterE5)]: moves([['g1f3', 'Nf3', 100]]), [identity(afterC5)]: moves([['g1f3', 'Nf3', 100]]) }
    const repertoire: Repertoire = { [identity(start)]: { e2e4: 'preferred' }, [identity(afterE5)]: { g1f3: 'preferred' } }
    expect(coverage(start, 'white', repertoire, data, 3)).toBeCloseTo(0.6)
    expect(coverage(start, 'white', repertoire, { ...data, [identity(start)]: { ...data[identity(start)], source: 'book' } }, 3)).toBeNull()
  })
  it('schedules failed reviews sooner and ends the requested repetitions', () => {
    const now = 1_000_000
    const success = recordReview(undefined, true, 2000, now)
    const failed = recordReview(success, false, 3000, now + 10000)
    expect(success.due).toBeGreaterThan(failed.due)
    expect(failed.totalMs).toBe(5000)
    expect(recordReview(failed, true, 1000, now + 20000).streak).toBe(1)
    const session = { start: 'a', startPly: 2, fen: 'b', ply: 8, done: 0, repetitions: 2 }
    expect(nextRepetition(session)).toMatchObject({ fen: 'a', ply: 2, done: 1 })
    expect(nextRepetition({ ...session, done: 1 })).toBeNull()
  })
})
