import { useEffect, useRef, useState } from 'react'
import { Chess, type Color } from 'chess.js'
import { analyze, engineMetrics, type Evaluation } from './engine'
import { lookupTablebase } from './learning'
import { maia2 } from './maia2'
import { discoverPlans, formation, planArrows, preliminaryPlans, type Evidence, type Plan, type PlannerOptions, type PlannerResult } from './planner'
import './planner.css'
import { TraceControls, type TraceOverlayState } from './MovementTrace'
export type PlanPreview = { fen: string; future: string; full: boolean; baseline?: string; changed: ReturnType<typeof formation>['changed']; arrows: ReturnType<typeof planArrows>; highlights?: string[]; movement?: TraceOverlayState }
const planCache = new Map<string, PlannerResult>()
function preferences() { try { return JSON.parse(localStorage.getItem('atlas-planner') || '{}') || {} } catch { return {} } }
function Metrics({ value, label, human }: { value?: Evidence; label: string; human: boolean }) {
  return <div className="planner-metric"><strong>{label}</strong>{value ? <><span>Forgiveness: {value.acceptable}/{value.evaluated} evaluated moves within 70 cp · {value.evaluated}/{value.legal} legal moves evaluated · depth {value.depth}</span><span>Evaluated forcing choices: {value.forcing} · best/second gap {value.gap === undefined ? 'mate or unavailable' : `${value.gap} cp`}</span><span>{value.modelMass === undefined ? human ? 'Human difficulty: Maia unavailable' : 'Maia not used for strongest defense' : `Maia predicted serious-error mass ≥${(100 * value.mistakeMass!).toFixed(1)}% · finite-loss contribution ≥${value.expectedLoss!.toFixed(1)} cp · ${(100 * value.modelMass).toFixed(1)}% probability evaluated · mate-outcome risk ≥${(100 * value.mateRiskMass!).toFixed(1)}%`}</span></> : <span>No decision measured (terminal or unfinished).</span>}</div>
}
export function PlannerCards({ plans, selected, side, onPreview, onSelect }: { plans: Plan[]; selected: string | null; side: Color; onPreview: (id: string | null) => void; onSelect: (id: string) => void }) {
  return <div className="planner-plans" aria-label="Candidate plans">{plans.map((plan, i) => <button key={plan.id} aria-pressed={selected === plan.id} onMouseEnter={() => onPreview(plan.id)} onMouseLeave={() => onPreview(null)} onFocus={() => onPreview(plan.id)} onBlur={() => onPreview(null)} onClick={() => onSelect(plan.id)}><strong>Plan {String.fromCharCode(65+i)} · {plan.label}</strong>{plan.tablebase && <span>Tablebase root-move outcome (opponent to move): {plan.tablebase}</span>}<span>{plan.sans[plan.leadIn]} · {plan.root.mate === undefined ? `${(plan.root.cp/100).toFixed(2)} for ${side === 'w' ? 'White' : 'Black'}` : `Mate ${plan.root.mate}`} · depth {plan.root.depth}</span><span>{plan.stage === 'candidate' ? 'Preliminary · checking strongest defenses' : `${plan.refuted ? 'REFUTED / DOWNGRADED: outside the configured root-loss constraint' : plan.tablebase ? 'Exact tablebase outcome preserved; cp filter superseded' : plan.loss === 0 ? 'Best' : `Root loss ${plan.loss === null ? 'mate outcome compared separately' : `${plan.loss} cp`}`} · ${plan.preliminary ? 'Preliminary' : 'Depth target reached'}`}</span>{plan.error && <span>Partial evidence: {plan.error}</span>}</button>)}</div>
}

export default function Planner({ fen, depth, delayMs = 350, history, rootAnalysis, onPreview }: { fen: string; depth: number; delayMs?: number; history?: PlannerOptions['history']; rootAnalysis?: Evaluation[]; onPreview: (value: PlanPreview | null) => void }) {
  const side = new Chess(fen).turn()
  const [horizon, setHorizon] = useState<PlannerOptions['horizon']>(() => [1,2,3,5].includes(preferences().horizon) ? preferences().horizon : 2)
  const [tolerance, setTolerance] = useState(() => Math.max(0, Math.min(100, Number(preferences().tolerance ?? 30) || 0)))
  const [rating, setRating] = useState(() => Math.max(400, Math.min(3000, Number(preferences().rating) || 1800)))
  const [response, setResponse] = useState<'strong'|'human'>(() => preferences().response === 'human' ? 'human' : 'strong')
  const [result, setResult] = useState<PlannerResult | null>(null), [selected, setSelected] = useState<string | null>(null), [hover, setHover] = useState<string | null>(null), [running, setRunning] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const cacheKey = JSON.stringify([fen, depth, horizon, tolerance, rating, response, history])
  useEffect(() => {
    request.current?.abort(); request.current = null; setRunning(false); setResult(null); setSelected(null); setHover(null); setError('')
    const cached = planCache.get(cacheKey)
    if (cached) { setResult(cached); setSelected(cached.plans[0]?.id || null); setError(cached.error || '') }
    const timer = cached ? undefined : setTimeout(() => void run(), delayMs)
    return () => { clearTimeout(timer); request.current?.abort(); request.current = null; onPreview(null) }
  }, [cacheKey, delayMs])
  useEffect(() => { try { localStorage.setItem('atlas-planner', JSON.stringify({ ...preferences(), horizon, tolerance, rating, response })) } catch { /* Session preferences still work. */ } }, [horizon, tolerance, rating, response])
  useEffect(() => {
    if (!rootAnalysis?.length || rootAnalysis.length < Math.min(4, new Chess(fen).moves().length) || rootAnalysis.some(e => e.source !== 'local' || e.search?.multiPVComplete === false || e.depth !== rootAnalysis[0].depth)) return
    const candidates = preliminaryPlans(fen, { side, horizon, depth, tolerance, budgetMs: 60000, rating, response, history }, rootAnalysis)
    if (candidates.length) setResult(old => old?.fen === fen && (old.plans.some(p => p.stage !== 'candidate') || (old.plans[0]?.root.depth ?? 0) >= candidates[0].root.depth) ? old : { fen, plans: candidates, elapsedMs: 0, searches: 0, duplicates: 0 })
  }, [rootAnalysis, fen, side, horizon, depth, tolerance, rating, response, cacheKey])
  const plans = result?.fen === fen ? result.plans.slice(0, 3) : []
  const active = plans.find(p => p.id === (hover || selected))
  async function run(nextHorizon = horizon, rootMove?: string, nextResponse = response) {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setRunning(true); setError(''); setHover(null)
    const nextDepth = depth
    if (!rootMove) { setResult(old => old?.fen === fen && old.plans.some(p => p.stage === 'candidate') ? old : null); setSelected(null) }
    try {
      const started = performance.now(), before = import.meta.env.DEV ? engineMetrics() : null
      let firstCandidateMs: number | undefined, firstVerifiedMs: number | undefined
      const output = await discoverPlans(fen, { side, horizon: nextHorizon, depth: nextDepth, tolerance, budgetMs: 60000, rating, response: nextResponse, rootMove, history }, { analyze, human: maia2, tablebase: lookupTablebase }, controller.signal, plan => {
        if (request.current !== controller) return
        firstVerifiedMs ??= performance.now() - started
        setResult(old => ({ fen, elapsedMs: 0, searches: 0, duplicates: 0, plans: rootMove ? [plan] : [...(old?.fen === fen ? old.plans.filter(p => p.stage !== 'candidate' && p.id !== plan.id) : []), plan, ...(old?.fen === fen ? old.plans.filter(p => p.stage === 'candidate' && p.id !== plan.id) : [])] }))
        setSelected(old => rootMove || old || plan.id)
      }, candidates => {
        if (request.current !== controller || !candidates.length) return
        firstCandidateMs ??= performance.now() - started
        setResult(old => old?.fen === fen && (old.plans.find(p => p.stage === 'candidate')?.root.depth ?? 0) > candidates[0].root.depth ? old : ({ fen, elapsedMs: 0, searches: 0, duplicates: 0, plans: [...(old?.fen === fen ? old.plans.filter(p => p.stage !== 'candidate') : []), ...candidates.filter(p => !old?.plans.some(existing => existing.id === p.id && existing.stage !== 'candidate'))] }))
      })
      if (request.current !== controller) return
      if (import.meta.env.DEV && before) { const after = engineMetrics(); console.debug('Planner timing ' + JSON.stringify({ firstCandidateMs, firstVerifiedMs, totalMs: performance.now() - started, analysisRequests: output.searches, stages: output.timings, sharedEngineDelta: { searches: after.searches - before.searches, cacheHits: after.cacheHits - before.cacheHits, queueMs: after.queueMs - before.queueMs, searchMs: after.searchMs - before.searchMs, nodes: after.nodes - before.nodes } })) }
      if (rootMove && !output.plans.length) {
        setResult(old => old && ({ ...old, plans: old.plans.map(plan => ({ ...plan, preliminary: true, error: 'Extension not completed; previous continuation retained.' })) })); setError(output.error || 'Extension not completed; previous continuation retained.'); return
      }
      if (output.plans.length) {
        planCache.set(cacheKey, output)
        if (planCache.size > 24) planCache.delete(planCache.keys().next().value!)
      }
      setResult(old => output.plans.length ? output : old?.fen === fen && old.plans.length ? { ...old, error: output.error, elapsedMs: output.elapsedMs, searches: output.searches } : output); setError(output.error || (output.plans.length ? '' : 'No complete sound candidate available within this budget.'))
    } catch (e) { if (request.current === controller) setError(controller.signal.aborted ? 'Cancelled. Completed previews retained.' : (e as Error).message) }
    finally { if (request.current === controller) { setRunning(false); request.current = null } }
  }
  const terminal = new Chess(fen).isGameOver()
  const select = (id: string) => { setSelected(id); setHover(null) }
  return <section className="planner" aria-label="Middlegame planner">
    <h2>Plans</h2>
    <p role="status">{terminal ? 'Terminal position — no future moves.' : running ? plans.length ? `${plans.filter(p => p.stage === 'candidate').length} preliminary · ${plans.filter(p => p.stage !== 'candidate').length} checked · target depth ${depth}` : 'Finding candidate moves…' : error || (result ? `${plans.length} distinct plans · ${(result.elapsedMs/1000).toFixed(1)}s · ${result.searches} analysis requests` : 'Waiting for position…')}</p>
    {running && <button onClick={() => request.current?.abort()}>Cancel planning</button>}
    <PlannerCards plans={plans} selected={selected} side={side} onPreview={setHover} onSelect={select}/>
    {active && <><TraceControls key={fen + active.id} fen={fen} moves={active.moves} onPreview={onPreview}/><p>{active.response}</p>
    <button disabled={running || active.stage === 'candidate' || active.steps.length > 5 || active.refuted} onClick={() => void run(active.steps.length < 4 ? 3 : 5, active.id)}>Extend plan</button>
    <details><summary>Plan evidence</summary><Metrics label="Your decision (root)" value={active.evidence[side]} human={response === 'human'}/><Metrics label="Opponent decision" value={active.evidence[side === 'w' ? 'b' : 'w']} human={response === 'human'}/>{response === 'human' && <p>Maia values are model predictions over evaluated candidates, not observed error rates or calibrated win probabilities.</p>}</details></>}
    <details className="planner-advanced"><summary>Advanced plan settings</summary><button disabled={running || terminal} onClick={() => void run()}>Refresh plans</button>
      <p>Planning for the side to move. Shared Stockfish target: depth {depth}. Objective evaluation determines ranking.</p>
      <div className="planner-controls"><label>Horizon <select aria-label="Planning horizon" value={horizon} onChange={e => setHorizon(Number(e.target.value) as PlannerOptions['horizon'])}>{[1,2,3,5].map(n => <option key={n}>{n}</option>)}</select></label><label>Maximum loss (cp) <input aria-label="Planner maximum loss" type="number" min={0} max={100} value={tolerance} onChange={e => setTolerance(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}/></label><label>Maia rating <input aria-label="Planner Maia rating" type="number" min={400} max={3000} value={rating} onChange={e => setRating(Math.max(400, Math.min(3000, Number(e.target.value) || 1800)))}/></label>
      <label>Opponent <select value={response} onChange={e => setResponse(e.target.value as 'strong'|'human')}><option value="strong">Strongest Stockfish defense</option><option value="human">Maia human-response simulation</option></select></label>
      </div>
    </details>
  </section>
}
