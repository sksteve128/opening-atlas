import { GenerationDetails } from './GenerationDetails'
import type { Variation } from './learning'
import { numberedMoves } from './memorize'
import { OpponentSource } from './OpponentSource'
import { opponentProvenance, repertoireDate, repertoireEvaluation, repertoireOutcome } from './repertoireSummary'

export function currentLineStatus(line: Variation) {
  const termination = line.termination || ''
  if (/sound middlegame reached/i.test(termination)) return 'Sound middlegame reached'
  if (/cancelled|stopped/i.test(termination)) return 'Generation stopped'
  if (line.status === 'incomplete') return 'Incomplete'
  const outcome = repertoireOutcome(line)
  return outcome !== 'Unresolved' ? outcome : line.status === 'complete' ? 'Completed game' : 'Unresolved'
}

export function CurrentLineSummary({ line, memorized, target, attempts }: { line: Variation; memorized: number; target: number; attempts: number }) {
  const evaluation = repertoireEvaluation(line)
  const provenance = opponentProvenance(line)
  const date = repertoireDate(line.created)
  const verification = line.recommendation?.verification === 'failed' ? 'Verification failed' : evaluation?.quality || (line.recommendation?.verification === 'pending' ? 'Preliminary' : 'Verification unavailable')
  return <div className="current-line-summary">
    <h2>{line.customName || line.name}</h2>
    <p className="compact-line-meta">{line.sideUnconfirmed ? "Choose side" : line.side === "white" ? "White" : "Black"} · {numberedMoves(line.moves.length)} moves · {evaluation?.score.replace(/^(White|Black) /, "") || "Evaluation unavailable"}</p>
    <p className="compact-line-source" title={provenance.details}>{provenance.label.replace("Opponent: ", "")}</p>
    <details className="line-summary-details"><summary>Line details · Memorized {memorized}/{target}</summary><p>{line.opening}</p>
    <p className="line-guide-opening">{line.sideUnconfirmed ? 'Playing side unavailable' : `For ${line.side === 'white' ? 'White' : 'Black'}`} · {numberedMoves(line.moves.length)} moves · {date || 'Date unavailable'}</p>
    <p className="current-line-source"><OpponentSource line={line}/></p>
    <GenerationDetails line={line}/>
    <p className="memory-stats">Memorized {memorized}/{target} · Attempts {attempts}</p>
    <p>{line.recommendation?.verification === "pending" ? "Deep verification not established" : verification === "Deeply verified" ? "Saved deeper verification completed; this is not mathematical proof." : "Search depth and continuation verification are separate. See generation Details for scope."}</p></details>
  </div>
}
