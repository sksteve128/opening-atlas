import 'fake-indexeddb/auto'
import { Chess } from 'chess.js'
import { expect, it } from 'vitest'
import { read, write } from './data'
import { isMyTurn } from './core'
import { lineFen, type LineMove, type Variation } from './learning'
import { beginMemory, dueMemoryLines, emptyMemoryStats, finishMemory, memoryReviewPosition, numberedMoves, opponentReply, recallMove, revealMemory } from './memorize'

it('shows numbered chess moves for odd and even ply counts', () => {
  expect([0, 1, 2, 3, 142, 143].map(numberedMoves)).toEqual([0, 1, 1, 2, 71, 72])
})

it('reviews only reached memorization positions without moving the recall frontier', () => {
  const session = { from: 4, index: 8 }
  expect([-1, 6, 99].map(requested => memoryReviewPosition(session, requested))).toEqual([4, 6, 8])
  expect(session.index).toBe(8)
})

it('tracks wrong recall, reveal, automatic opponent reply, and a completed imperfect repetition', () => {
  const started = beginMemory(emptyMemoryStats(), 'line-1', 0, 4, 1000)
  let session = recallMove(started.session, 'd2d4', { uci: 'e2e4', san: 'e4' })
  expect(session).toMatchObject({ index: 0, wrong: 1, hint: true })
  session = revealMemory(session, 'e4')
  session = revealMemory(session, 'e4')
  expect(session.reveals).toBe(1)
  session = recallMove(session, 'e2e4', { uci: 'e2e4', san: 'e4' })
  session = opponentReply(session)
  session = recallMove(session, 'g1f3', { uci: 'g1f3', san: 'Nf3' })
  session = opponentReply(session)
  expect(session.index).toBe(4)
  expect(finishMemory(started.stats, session, 11000)).toMatchObject({ attempts: 1, completed: 1, perfect: 0, streak: 0, wrong: 1, reveals: 1, totalMs: 10000, dueAt: 611000 })
})

it('automates White and requires Black moves for a saved Black variation', () => {
  const game = new Chess(), moves: LineMove[] = []
  for (const san of ['d4', 'd5', 'Bf4', 'c5']) { const move = game.move(san); moves.push({ uci: move.from + move.to, san: move.san, source: 'import' }) }
  const line = { id: 'london-black', side: 'black', startFen: new Chess().fen(), moves } as Variation
  const started = beginMemory(emptyMemoryStats(), line.id, 0, moves.length)
  expect(isMyTurn(lineFen(line, started.session.index), line.side)).toBe(false)
  let session = opponentReply(started.session)
  expect(isMyTurn(lineFen(line, session.index), line.side)).toBe(true)
  session = recallMove(session, 'd7d5', moves[1])
  session = opponentReply(session)
  session = recallMove(session, 'c7c5', moves[3])
  expect(finishMemory(started.stats, session)).toMatchObject({ attempts: 1, completed: 1, perfect: 1 })
})

it('counts interrupted attempts without inflating completed or perfect repetitions', () => {
  const started = beginMemory(emptyMemoryStats(), 'line-1', 2, 8, 1000)
  const partial = recallMove(started.session, 'g1f3', { uci: 'g1f3', san: 'Nf3' })
  expect(finishMemory(started.stats, partial, 9000)).toEqual(started.stats)
  expect(started.stats).toMatchObject({ attempts: 1, completed: 0, perfect: 0 })
})

it('does not count a completed segment as a full-line repetition', () => {
  const started = beginMemory(emptyMemoryStats(), 'line-1', 0, 2, 1000, 8)
  const complete = opponentReply(recallMove(started.session, 'e2e4', { uci: 'e2e4', san: 'e4' }))
  expect(finishMemory(started.stats, complete, 2000)).toMatchObject({ attempts: 1, completed: 0, perfect: 0, streak: 0, lastPracticed: 2000 })
})

it('builds perfect streaks and schedules reviews by stable variation ID', async () => {
  let stats = emptyMemoryStats()
  for (let repetition = 1; repetition <= 4; repetition++) {
    const started = beginMemory(stats, 'fixed-id', 0, 1, repetition * 1000)
    const complete = recallMove(started.session, 'e2e4', { uci: 'e2e4', san: 'e4' })
    stats = finishMemory(started.stats, complete, repetition * 1000 + 100)
    expect(stats).toMatchObject({ attempts: repetition, completed: repetition, perfect: repetition, streak: repetition, bestStreak: repetition })
  }
  expect(stats.dueAt! - stats.lastPracticed!).toBe(14 * 86400000)
  const renamed = { id: 'fixed-id', name: 'Renamed variation' }
  await write('memorize-stats-test', { [renamed.id]: stats })
  expect((await read<Record<string, typeof stats>>('memorize-stats-test'))?.[renamed.id]).toEqual(stats)
  expect(dueMemoryLines([renamed], { [renamed.id]: stats }, stats.dueAt! - 1)).toEqual([])
  expect(dueMemoryLines([renamed], { [renamed.id]: stats }, stats.dueAt!)).toEqual([renamed])
})

it('recalls castling, en passant, and an underpromotion by exact legal UCI move', () => {
  for (const [fen, uci, san] of [
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1', 'O-O'],
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6', 'exd6'],
    ['4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8n', 'a8=N'],
  ]) {
    const game = new Chess(fen)
    const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    expect(move.san).toBe(san)
    const session = beginMemory(emptyMemoryStats(), 'special', 0, 1).session
    expect(recallMove(session, uci, { uci, san })).toMatchObject({ index: 1, wrong: 0 })
  }
})
