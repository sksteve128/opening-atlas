import { useEffect, useState } from 'react'
import { lineFen, moveNumber, type Variation } from './learning'
import { StableBoard } from './StableBoard'
import { opponentProvenance } from './repertoireSummary'
import { spectatorPly, type BatchJob, type BatchStatus, type RecentBatch } from './backgroundBatch'
import './generationQueue.css'

type Props = { active: BatchStatus | null; recent: RecentBatch[]; lines: Variation[]; onOpenLine: (line: Variation) => void; onStop: () => void; onRepertoire: () => void }
const ended = (status: string) => status === 'complete' || status === 'failed' || status === 'cancelled'
const date = (time: number) => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const summary = (line: Variation) => `${Math.ceil(line.moves.length / 2)} moves · ${line.side} · ${opponentProvenance(line).label} · ${line.recommendation?.objectiveCp === undefined ? 'Evaluation unavailable' : `${line.recommendation.objectiveCp >= 0 ? '+' : ''}${(line.recommendation.objectiveCp / 100).toFixed(2)} for ${line.side}`} · ${line.termination || 'Continuation saved'} · ${line.recommendation?.verification === 'passed' ? 'Verified' : 'Preliminary'}`

export default function GenerationQueue({ active, recent, lines, onOpenLine, onStop, onRepertoire }: Props) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [watch, setWatch] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  const [ply, setPly] = useState(0)
  const [flipped, setFlipped] = useState(false)
  useEffect(() => { setSelected(null); setWatch(null) }, [active?.id])
  const current = selected ? recent.find(item => item.id === selected) : undefined
  const showActive = active && (!selected || selected === active.id)
  const jobs: Array<BatchJob | RecentBatch['jobs'][number]> = showActive ? active.jobs : current?.jobs || []
  const savedFor = (job: BatchJob | RecentBatch['jobs'][number]) => 'line' in job ? job.line || lines.find(item => item.id === job.lineId) : lines.find(item => item.id === job.lineId)
  const opening = showActive ? active.opening : current?.opening
  const side = showActive ? active.side : current?.side
  const watched = jobs.find(job => job.id === watch)
  const line = watched && savedFor(watched)
  const outcomeCounts = new Map<string, number>()
  for (const job of jobs) if (job.status === 'complete') { const saved = savedFor(job), reason = saved?.tablebase?.label || saved?.termination || 'Unresolved'; outcomeCounts.set(reason, (outcomeCounts.get(reason) || 0) + 1) }
  const outcomes = [...outcomeCounts].map(([reason, count]) => `${count} ${reason}`).join(' · ')
  const latest = line?.moves.length || 0
  useEffect(() => { if (!following || ply >= latest) return; const timer = setTimeout(() => setPly(value => spectatorPly(value, latest, true)), 180); return () => clearTimeout(timer) }, [following, latest, ply])
  const visiblePly = Math.min(ply, latest)
  let fen: string | undefined
  try { if (line) fen = lineFen(line, visiblePly) } catch { /* Invalid snapshots never replace the last valid position. */ }
  const last = line?.moves[visiblePly - 1]
  const squareStyles = last ? { [last.uci.slice(0, 2)]: { backgroundColor: '#d8e9a9' }, [last.uci.slice(2, 4)]: { backgroundColor: '#c0db80' } } : {}
  const watchingLive = watched?.status === 'running'
  const chooseWatch = (job: BatchJob | RecentBatch['jobs'][number]) => {
    setWatch(job.id); setFollowing(true); setFlipped(false)
    const draft = savedFor(job)
    setPly(draft?.moves.length || 0)
  }
  const spectator = watch && <section className="generation-spectator" aria-label="Live generation spectator">
        <div className="generation-spectator-head"><strong>LIVE GENERATION · Line {jobs.findIndex(job => job.id === watch) + 1}</strong><button onClick={() => setWatch(null)} aria-label="Close spectator">×</button></div>
        <div className="generation-spectator-tabs" role="group" aria-label="Switch generation worker">{jobs.map((job, index) => <button key={job.id} aria-pressed={job.id === watch} disabled={job.status === 'pending'} onClick={() => chooseWatch(job)}>Worker {index + 1}</button>)}</div>
        <small>{opening} · Playing {side} · Move {Math.ceil(visiblePly / 2)}/{watchingLive ? '?' : Math.ceil(latest / 2)}</small>
        {fen ? <div className="generation-spectator-board"><StableBoard options={{ position: fen, boardOrientation: flipped ? side === 'white' ? 'black' : 'white' : side || 'white', allowDragging: false, squareStyles, lightSquareStyle: { backgroundColor: '#f0d9b5' }, darkSquareStyle: { backgroundColor: '#b58863' }, animationDurationInMs: 180 }}/></div> : <p>Waiting for the first committed move.</p>}
        <div className="generation-spectator-moves" aria-label="Committed generation moves">{line?.moves.map((move, index) => <button className={visiblePly === index + 1 ? 'current' : ''} key={index} onClick={() => { setFollowing(false); setPly(index + 1) }}>{moveNumber(lineFen(line, index), move.san)}</button>)}</div>
        <p className="generation-spectator-stage">{watched?.status === 'running' ? 'phase' in watched ? watched.phase : 'Generating' : watched?.status === 'complete' ? 'Variation complete' : 'Generation stopped — partial line preserved.'}</p>
        {last && <small>Committed move: {last.san} · {last.aggressive ? 'Patricia candidate, Stockfish checked' : last.source === 'engine' ? 'Stockfish' : last.source === 'model' ? 'Maia' : last.source === 'lichess' ? 'Lichess' : last.source}</small>}
        <div className="generation-spectator-controls"><button onClick={() => { setFollowing(false); setPly(Math.max(0, visiblePly - 1)) }} aria-label="Previous spectator move">‹</button><button onClick={() => { setFollowing(false); setPly(Math.min(latest, visiblePly + 1)) }} aria-label="Next spectator move">›</button><button onClick={() => setFollowing(false)} aria-pressed={!following}>Pause viewing</button><button onClick={() => { setFollowing(true); setPly(latest) }} aria-pressed={following}>Follow live</button><button onClick={() => setFlipped(value => !value)}>Flip</button></div>
      </section>
  return <div className="generation-queue-anchor">
    {(active || recent.length > 0) && <button className="generation-queue-trigger" aria-label="Generation Queue" aria-expanded={open} onClick={() => setOpen(value => !value)}>{active && !ended(active.status) ? `◉ ${active.jobs.filter(job => job.status === 'running').length} running` : `✓ ${active?.completed ?? recent[0]?.completed ?? 0} completed`}</button>}
    {open && <aside className="generation-queue-panel" aria-label="Generation Queue" data-generation-id={showActive ? active.id : current?.id}>
      <div className="generation-queue-heading"><strong>GENERATION QUEUE</strong><button onClick={() => setOpen(false)} aria-label="Close Generation Queue">×</button></div>
      {opening ? <><div className="generation-queue-title"><strong>{opening}</strong><span>Playing {side} · {showActive ? active.completed : current?.completed}/{showActive ? active.total : current?.total} completed</span></div>
        {spectator}
        <div className="generation-queue-jobs">{jobs.map((job, index) => {
          const saved = savedFor(job)
          const icon = job.status === 'complete' ? '✓' : job.status === 'running' ? '◉' : job.status === 'pending' ? '○' : '!'
          return <div className="generation-queue-job" key={job.id}><div><strong title={saved?.customName || saved?.name}>{icon} Line {index + 1}{saved && ended(job.status) ? ` — ${saved.customName || saved.name}` : ''}</strong><span title={saved ? summary(saved) : undefined}>{saved ? summary(saved) : job.status === 'running' ? `Move ${Math.ceil(('ply' in job ? job.ply : 0) / 2)} · ${'phase' in job ? job.phase : 'Generating'}` : job.status === 'pending' ? 'Queued' : job.error || job.status}</span></div><div className="generation-queue-job-actions">{showActive && (job.status === 'running' || saved) && <button onClick={() => chooseWatch(job)}>{watch === job.id ? 'Watching live' : 'Watch live'}</button>}{saved && ended(job.status) && <button onClick={() => onOpenLine(lines.find(item => item.id === saved.id) || saved)}>{job.status === 'complete' ? 'View saved' : 'Open partial'}</button>}</div></div>
        })}</div>
        {showActive && !ended(active.status) && <button className="generation-queue-stop" onClick={onStop}>Stop all</button>}
        {showActive && ended(active.status) && <p className="generation-queue-result">{active.completed} saved · {active.failed} failed · {active.cancelled} cancelled</p>}
        {outcomes && <p className="generation-queue-result">{outcomes}</p>}
        {showActive && ended(active.status) && <button onClick={onRepertoire}>View in Repertoire</button>}
      </> : <p>No generation batch yet.</p>}

      {!!recent.length && <div className="generation-queue-recent"><strong>RECENT</strong>{recent.map(batch => <button key={batch.id} onClick={() => { setSelected(batch.id); setWatch(null) }}><span>{batch.opening} · {batch.side}</span><small>{date(batch.startedAt)} · {batch.completed}/{batch.total} saved · {batch.failed} failed · {batch.cancelled} cancelled</small></button>)}{selected && <button onClick={() => { setSelected(null); setWatch(null) }}>Current batch</button>}</div>}
    </aside>}
  </div>
}
