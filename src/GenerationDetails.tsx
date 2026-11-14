import { Chess } from 'chess.js'
import type { Variation } from './learning'
import { positions } from './gameAnalysis'
import { repertoireEvaluation, opponentProvenance } from './repertoireSummary'
import { generationProvenance } from './generationProvenance'
export function generationTimeline(line:Variation) { return generationProvenance(line).entries }
export function GenerationDetails({line}:{line:Variation}) {
 const provenance=generationProvenance(line), entries=provenance.entries,evaluation=repertoireEvaluation(line),info=line.recommendation
 const board=new Chess(positions(line).at(-1))
 const terminal=board.isGameOver()||!!line.tablebase
 const running=line.generationState==='running'||/^(Generating|Converting advantage)/.test(line.termination||'')
 const verified=info?.verification==='passed'&&info.verificationScope==='deep'&&!info.preliminary&&(info.depth??0)>=(info.configuration?.verificationDepth??24)
 const runs = opponentProvenance(line).runs
 return <div className="generation-summary">
  <span>Generation: {running?'In progress':line.generationState==='complete'?'Complete':line.generationState==='stopped'?'Stopped':line.status==='complete'?'Complete':'Saved continuation'}</span>
  <span>{info?.policy==='simple' && info.verification==='pending' ? 'Deep verification: Not performed · Preliminary' : <>Verification: {verified?`Complete · Stockfish depth ${info?.depth ?? 'unavailable'}`:info?.verification==='failed'?'Failed':info?.policy==='simple'?'Preliminary · no deep continuation verification performed':'Not established'}</>}</span>
  <span>{verified&&evaluation?.provenance==='Final'?'Final evaluation':'Current evaluation'}: {evaluation?.score||'Unavailable'}{evaluation?.depth!==undefined?` · Depth ${evaluation.depth}`:''}{evaluation?.provenance==='Latest'?' · earlier analyzed position':''}</span>
  <span>Endpoint: {terminal?(board.isCheckmate()?'Checkmate':line.tablebase?.label||'Draw'):`${(info?.conversion?.outcome||line.termination||'Unresolved').replace('Advantage secured','Advantage appears secured')} · Preliminary`}</span>
  <details><summary>Generation Details · {provenance.boundary === undefined ? provenance.start : provenance.boundary > 0 ? `Starting after ${entries[provenance.boundary-1].label}` : provenance.start}</summary>
   <p>Generation start: {provenance.start}</p>
   {provenance.context && <p>Opening context: {provenance.context}</p>}
   {runs.map((run,i)=><p key={i}>{provenance.boundary === undefined ? 'Opponent moves' : 'Generated opponent moves'}: {run.source} · {run.first}{run.last!==run.first?` through ${run.last}`:''}</p>)}
   {line.opponentTransition && <p>Stockfish takeover at {entries[line.opponentTransition.ply]?.label || `ply ${line.opponentTransition.ply + 1}`}: {line.opponentTransition.reason}</p>}
   {info?.conversion?.modelStatus && !info.conversion.modelStatus.startsWith('Maia not selected;') && <p>{info.conversion.modelStatus}</p>}<p>Stockfish move selection and deep continuation verification are separate. Instructional endpoints are heuristic, not proof of a win.</p>
   <ol>{entries.filter(entry=>!entry.contextual).map(({label,source,move},i)=><li key={i}>{label}: {source === 'Source unavailable' ? provenance.boundary === undefined ? 'Historical move · Source unavailable' : 'Generated move · Source unavailable' : source}{move.engineFallback?' (fallback)':''}{move.prediction?` · rating ${move.prediction.rating}`:''}{move.cp!==undefined?` · ${(move.cp/100).toFixed(2)} pawns for the side to move`:''}{move.depth!==undefined?` · selection depth ${move.depth}`:''} · {move.selectionAnalysis?move.selectionAnalysis.preliminary?'Preliminary when selected':'Selection target depth reached; deep verification not established':'Selection completeness unavailable'}{move.style?` · style check depth ${move.style.verifiedDepth}`:''}</li>)}</ol>
   {line.generationSettings && <details><summary>Generation settings</summary><pre>{JSON.stringify(line.generationSettings,null,2)}</pre></details>}
  </details>
 </div>
}
