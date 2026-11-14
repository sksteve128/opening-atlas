import { useEffect, useMemo, useState } from 'react'
import { Chess, type Square } from 'chess.js'
import { StableBoard } from './StableBoard'
import { positions } from './gameAnalysis'
import type { Variation } from './learning'
import { beginMemory, finishMemory, opponentReply, recallMove, revealMemory, type MemorySession, type MemoryStats } from './memorize'
import { finishFamilyAttempt, lineSignature, startFamilyAttempt, type FamilyRecord } from './familyPractice'
type Props = { record: FamilyRecord; lines: Variation[]; update: (record: FamilyRecord) => boolean; updateStats: (id: string, change: (stats: MemoryStats) => MemoryStats) => void; back: () => void; restart: (reviewOnly?: boolean) => void; stats?: Record<string, MemoryStats> }
export default function FamilyPractice({ record, lines, update, updateStats, back, restart, stats }: Props) {
  const s = record.session, memory = s.memory
  const byId = useMemo(() => new Map(lines.map(line => [line.id, line])), [lines])
  const line = memory ? byId.get(memory.lineId) : undefined
  const valid = !!line && lineSignature(line) === s.signatures[line.id] && !!memory && memory.to === line.moves.length && memory.from >= 0 && memory.from <= memory.index && memory.index <= memory.to
  const fens = useMemo(() => valid ? positions(line!) : [], [line, valid])
  const [square, setSquare] = useState<Square | null>(null), [promotion, setPromotion] = useState('q')
  const [reviewPly, setReviewPly] = useState<number | null>(null)
  const fen = fens[reviewPly ?? memory?.index ?? 0], active = !!memory && memory.phase === 'active' && valid && !s.finished
  const ownTurn = !!fen && fen.split(' ')[1] === s.side[0]
  function next() {
    const next = startFamilyAttempt({ ...record, session: { ...s, memory: null } }, byId)
    if (update(next) && next.session.memory) updateStats(next.session.memory.lineId, stats => beginMemory(stats, next.session.memory!.lineId, next.session.memory!.from, next.session.memory!.to).stats)
    setReviewPly(null); setSquare(null)
  }
  function advance(nextMemory: MemorySession) {
    const ended = nextMemory.index >= nextMemory.to
    const next = ended ? finishFamilyAttempt(record, nextMemory) : { ...record, session: { ...s, memory: nextMemory } }
    if (update(next) && ended) updateStats(nextMemory.lineId, stats => nextMemory.index >= nextMemory.to ? finishMemory(stats, nextMemory) : { ...stats, wrong: stats.wrong + nextMemory.wrong, reveals: stats.reveals + nextMemory.reveals, lastPracticed: Date.now() })
  }
  useEffect(() => {
    if (!active || !memory) return
    if (memory.index >= memory.to) { advance(memory); return }
    if (ownTurn) return
    const timer = setTimeout(() => advance(opponentReply(memory)), 450)
    return () => clearTimeout(timer)
  }, [memory, active, ownTurn])
  function move(uci: string) {
    if (!active || !ownTurn || !memory || !line || memory.index >= memory.to) return false
    try { new Chess(fen).move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci[4] }) } catch { return false }
    setSquare(null); advance(recallMove(memory, uci, line.moves[memory.index])); return true
  }
  const uci = (from: string, to: string) => from + to + (new Chess(fen).get(from as Square)?.type === 'p' && ['1','8'].includes(to[1]) ? promotion : '')
  const covered = new Set(s.attempts.map(attempt => attempt.id)).size
  const percent = Math.round(covered / Math.max(1,s.ids.length) * 100)
  const failures = [...new Map(s.attempts.map(a => [a.id,a])).values()].filter(a => !a.success)
  const mastered = s.ids.filter(id => (stats?.[id]?.perfect || 0) >= (stats?.[id]?.target || 5)).length
  return <main className="rep-main family-practice">
    <h1>{s.family} — {s.side === 'white' ? 'White' : 'Black'}</h1>
    <p>{covered} / {s.ids.length} lines {s.branch ? 'practiced' : 'completed'} · {percent}%</p><progress aria-label="Family session progress" value={covered} max={Math.max(1,s.ids.length)}/>
    {s.branch && <><p>{s.branch.weighting}</p><p>Memorization mastery: {mastered}/{s.ids.length} lines · Partial-branch recall does not award full-line mastery.</p>{!s.finished && <p>Current line: {Math.min(s.ids.length,s.ids.length-s.remaining.length+(s.review ? 0 : 1))} / {s.ids.length}{s.branch.options.coverage === 'continuous' ? ` · Cycle ${s.branch.cycle+1}` : ''}</p>}</>}
    {s.finished ? <><h2>{s.stopped ? 'Branch practice stopped' : s.branch ? 'Branch practice complete' : 'Family completed!'}</h2>{s.stopped && memory?.phase==='active' && <p>The unfinished attempt was not counted toward coverage or graded.</p>}<p>{s.attempts.length} attempts · {s.attempts.reduce((n,a) => n + a.wrong,0)} mistakes · {Math.round((s.finished-s.started)/1000)} seconds · {new Date(s.finished).toLocaleString()}</p>{s.branch && <p>{covered}/{s.ids.length} variations practiced · {s.attempts.filter(a=>a.success).length} successful attempts · {s.attempts.filter(a=>!a.success).length} attempts with mistakes or hints · {failures.length} lines with review suggested</p>}<button onClick={()=>restart()}>Practice again</button>{s.branch && !!failures.length && <button onClick={()=>restart(true)}>Review mistakes</button>}</> : <>
      {!memory && <button onClick={next}>{s.attempts.length ? 'Continue family practice' : 'Begin recall'}</button>}
      {memory && !valid && <><p>This saved line was removed or changed. Its attempt cannot count as completed.</p><button onClick={next}>Continue with available lines</button></>}
      {active && <><p>{ownTurn ? 'Recall your next move.' : 'Opponent is playing…'}</p><p role="status">{memory.message}</p></>}
    </>}
    {valid && fen && <><div className="rep-board"><StableBoard options={{ position: fen, boardOrientation: s.side, allowDragging: active && ownTurn, onPieceDrop: ({ sourceSquare,targetSquare }) => targetSquare ? move(uci(sourceSquare,targetSquare)) : false, onSquareClick: ({ square: clicked }) => { if (!active || !ownTurn) return; if (square === clicked) {setSquare(null);return} if (square && move(uci(square,clicked))) return; setSquare(new Chess(fen).get(clicked as Square)?.color === s.side[0] ? clicked as Square : null) }, squareStyles: square ? { [square]: { backgroundColor:'#c9d88b' } } : {}, lightSquareStyle:{backgroundColor:'#f0d9b5'},darkSquareStyle:{backgroundColor:'#b58863'} }}/></div>
      {active && <div className="rep-actions"><label>Promote to <select aria-label="Promotion piece" value={promotion} onChange={e=>setPromotion(e.target.value)}><option value="q">Queen</option><option value="r">Rook</option><option value="b">Bishop</option><option value="n">Knight</option></select></label><button disabled={!ownTurn} onClick={()=>advance(revealMemory(memory!,line!.moves[memory!.index].san))}>Show move</button></div>}
      {s.review && <section aria-label="Attempt review"><h2>{line!.customName || line!.name}</h2><p role="status">{s.attempts.at(-1)?.success ? 'Recalled successfully.' : 'Line practiced. A difference from the saved repertoire is not necessarily a chess blunder.'}</p><p>{line!.pgn || line!.moves.map(m=>m.san).join(' ')}</p><div className="rep-actions"><button onClick={()=>setReviewPly(Math.max(memory!.from,(reviewPly ?? memory!.index)-1))}>← Review previous</button><button onClick={()=>setReviewPly(Math.min(line!.moves.length,(reviewPly ?? memory!.index)+1))}>Review next →</button>{!s.finished && <button onClick={next}>Next line</button>}</div></section>}
    </>}
    {!!s.unavailable.length && <p role="status">{s.unavailable.length} snapshot lines are unavailable. They have not been counted as completed. Start a new session to use the current library.</p>}
    <div className="rep-actions">{s.branch && !s.finished && <button onClick={()=>update({...record,session:{...s,finished:Date.now(),stopped:true}})}>Stop session</button>}<button onClick={back}>Return to Repertoire</button><button onClick={()=>restart()}>Start New Session</button></div>
    <details><summary>{s.branch ? 'Session history' : 'Family history'}</summary>{s.branch && <p>Shuffle seed: {s.branch.seed} · {s.branch.options.order} · {s.branch.options.coverage}</p>}<p>Sessions started {record.sessionsStarted} · Completed {record.sessionsCompleted} · Lines completed {record.linesCompleted} · Attempts {record.totalAttempts} · Attempts with mistakes or hints {record.incorrectAttempts}</p><p>Last completed: {record.lastCompleted ? new Date(record.lastCompleted).toLocaleString() : 'Never'}</p></details>
  </main>
}
