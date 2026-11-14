export type MemoryStats = { attempts: number; completed: number; perfect: number; streak: number; bestStreak: number; wrong: number; reveals: number; totalMs: number; lastPracticed?: number; dueAt?: number; target: number }
export type MemorySession = { lineId: string; from: number; to: number; fullLine: boolean; index: number; started: number; wrong: number; reveals: number; hint: boolean; shownAt?: number; message: string; phase: 'active' | 'complete' }

export const emptyMemoryStats = (): MemoryStats => ({ attempts: 0, completed: 0, perfect: 0, streak: 0, bestStreak: 0, wrong: 0, reveals: 0, totalMs: 0, target: 5 })
export const numberedMoves = (plies: number) => Math.ceil(plies / 2)
export const memoryReviewPosition = (session: Pick<MemorySession, 'from' | 'index'>, requested: number) => Math.max(session.from, Math.min(session.index, requested))

export function beginMemory(stats: MemoryStats, lineId: string, from: number, to: number, now = Date.now(), lineLength = to) {
  return { stats: { ...stats, attempts: stats.attempts + 1 }, session: { lineId, from, to, fullLine: from === 0 && to === lineLength, index: from, started: now, wrong: 0, reveals: 0, hint: false, message: 'Play your saved moves from memory.', phase: 'active' } satisfies MemorySession }
}

export function recallMove(session: MemorySession, uci: string, expected: { uci: string; san: string }): MemorySession {
  return uci === expected.uci ? { ...session, index: session.index + 1, hint: false, message: `Correct: ${expected.san}` } : { ...session, wrong: session.wrong + 1, hint: true, message: `That differs from the saved continuation. Expected move: ${expected.san}. Play it to continue.` }
}

export function revealMemory(session: MemorySession, san: string): MemorySession {
  return { ...session, reveals: session.reveals + Number(session.shownAt !== session.index), shownAt: session.index, hint: true, message: `Expected move: ${san}. Play it on the board.` }
}

export function opponentReply(session: MemorySession): MemorySession { return { ...session, index: session.index + 1, hint: false } }

export function finishMemory(stats: MemoryStats, session: MemorySession, now = Date.now()): MemoryStats {
  if (session.phase !== 'active' || session.index < session.to) return stats
  if (!session.fullLine) return { ...stats, wrong: stats.wrong + session.wrong, reveals: stats.reveals + session.reveals, lastPracticed: now }
  const perfect = session.wrong === 0 && session.reveals === 0
  const streak = perfect ? stats.streak + 1 : 0
  const days = streak >= 4 ? 14 : streak === 3 ? 7 : streak === 2 ? 3 : 1
  return { ...stats, completed: stats.completed + 1, perfect: stats.perfect + Number(perfect), streak, bestStreak: Math.max(stats.bestStreak, streak), wrong: stats.wrong + session.wrong, reveals: stats.reveals + session.reveals, totalMs: stats.totalMs + Math.max(0, now - session.started), lastPracticed: now, dueAt: now + (perfect ? days * 86400000 : 600000) }
}

export function dueMemoryLines<T extends { id: string }>(lines: T[], stats: Record<string, MemoryStats>, now = Date.now()): T[] {
  return lines.filter(line => !stats[line.id]?.dueAt || stats[line.id].dueAt! <= now).sort((a, b) => {
    const priority = (line: T) => { const value = stats[line.id]; return value ? (now - (value.dueAt || 0)) / 86400000 + value.wrong / Math.max(1, value.completed) + (1 - value.perfect / Math.max(1, value.completed)) : 1000 }
    return priority(b) - priority(a)
  })
}
