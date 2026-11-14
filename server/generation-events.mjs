import { Chess } from 'chess.js'

// Progress snapshots are emitted by the generators after game.move() and moves.push().
// Only those committed moves enter the spectator; engine PVs never do.
export function committedEvents(job, batchId, line, stage) {
  if (!line?.moves || !line.startFen) return []
  const game = new Chess(line.startFen), events = []
  for (let ply = 0; ply < line.moves.length; ply++) {
    const move = line.moves[ply]
    const played = game.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] })
    if (!played) throw new Error(`Invalid committed move at ply ${ply + 1}.`)
    if (ply + 1 <= (job.ply || 0)) continue
    events.push({ type: 'move_committed', batchId, jobId: job.id, sequence: ++job.sequence, timestamp: Date.now(), ply: ply + 1, fen: game.fen(), move: { uci: move.uci, san: move.san, source: move.source }, stage, status: job.status })
  }
  job.ply = line.moves.length
  job.fen = game.fen()
  job.lastMove = line.moves.at(-1)
  job.events.push(...events)
  if (job.events.length > 128) job.events.splice(0, job.events.length - 128)
  return events
}
