import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { extensionKey, legalPv, needsTacticalExtension, numberedPv, runTacticalExtension, tacticalStory } from './StockfishPlans'

describe('adaptive Stockfish continuation', () => {
  it('keeps the complete legal PV, stops at illegal or post-mate moves, and numbers both sides', () => {
    const fen = new Chess().fen()
    const positions = legalPv(fen, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'bad'])
    expect(numberedPv(fen, positions)).toEqual(['1.e4', '1...e5', '2.Nf3', '2...Nc6', '3.Bb5'])
    expect(positions).toHaveLength(5)
    expect(new Chess(positions[2].fen).get('f3')?.type).toBe('n')
    expect(tacticalStory(positions).description).toBe('Engine continuation')
    expect(needsTacticalExtension(positions)).toBe(false)
    const mate = legalPv(fen, ['f2f3', 'e7e5', 'g2g4', 'd8h4', 'e2e4'])
    expect(mate).toHaveLength(4)
    expect(tacticalStory(mate).description).toContain('checkmates')
    expect(needsTacticalExtension(mate)).toBe(false)
  })
  it('recognizes unresolved forcing tails without extending ordinary captures', () => {
    const queen = legalPv('4k3/8/8/8/4q3/4R3/8/4K3 w - - 0 1', ['e3e4'])
    expect(queen).toHaveLength(1)
    expect(tacticalStory(queen).description).toContain('captures a queen')
    expect(needsTacticalExtension(queen)).toBe(true)
    const exchange = legalPv('4k3/8/8/8/8/3p4/2r5/2R1K3 w - - 0 1', ['c1c2', 'd3c2'])
    expect(tacticalStory(exchange).description).toContain('recapture')
    expect(needsTacticalExtension(exchange)).toBe(false)
    const sacrifice = legalPv('r1bqkb1r/ppp2ppp/2n5/3np1N1/2B5/8/PPPP1PPP/RNBQK2R w KQkq - 0 6', ['g5f7', 'e8f7'])
    expect(tacticalStory(sacrifice).description).toContain('knight is captured')
    expect(extensionKey('fen', 'e2e4', ['e2e4'])).not.toBe(extensionKey('fen', 'd2d4', ['d2d4']))
  })
  it('reconstructs castling, en passant, and promotion positions', () => {
    const castling = legalPv('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['e1g1'])
    expect(castling[0].san).toBe('O-O')
    expect(new Chess(castling[0].fen).get('f1')?.type).toBe('r')
    const enPassant = legalPv('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', ['e5d6'])
    expect(new Chess(enPassant[0].fen).get('d5')).toBeUndefined()
    const promotion = legalPv('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7a8q'])
    expect(new Chess(promotion[0].fen).get('a8')?.type).toBe('q')
    expect(tacticalStory(promotion).description).toContain('promotes')
  })
  it('extends from cache first, makes at most one bounded request, and rejects stale cancellation', async () => {
    const fen = new Chess().fen(), line = [{ cp: 0, depth: 24, line: ['e2e4', 'e7e5'] }]
    let requests = 0
    const search = async () => { requests++; return line }
    const cached = await runTacticalExtension(fen, 24, new AbortController().signal, () => line, search)
    expect(cached.positions).toHaveLength(2)
    expect(cached.searches).toBe(0)
    expect(requests).toBe(0)
    const fetched = await runTacticalExtension(fen, 24, new AbortController().signal, () => undefined, search)
    expect(fetched.searches).toBe(1)
    expect(requests).toBe(1)
    const controller = new AbortController()
    await expect(runTacticalExtension(fen, 24, controller.signal, () => undefined, async () => { controller.abort(); return line })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
