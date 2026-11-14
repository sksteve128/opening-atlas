import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess, type Square } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { ReactFlow, Background, Controls, Handle, Position, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Activity, ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, CircleHelp, Compass, Crosshair, GitBranch, Moon, Play, RotateCcw, Search, Settings2, Sun, Target, TrendingUp, X } from 'lucide-react'
import { analyze, lineSan, scoreMove, type Evaluation } from './engine'
import { explorer, read, write, type Filters } from './data'
import { coverage, frequency, gameFrom, identity, isMyTurn, moveKey, nextFen, nextRepetition, playUci, PRESETS, recordReview, selectMove, total, type Choice, type ExplorerData, type GraphEdge, type GraphPosition, type Mode, type Repertoire, type Reviews, type Side } from './core'

type Session = { start: string; fen: string; startPly: number; ply: number; done: number; repetitions: number; endPly: number; mode: Mode; visits: Record<string, number>; started: number; busy: boolean }
type Attempt = { opening: string; move: string; success: boolean; durationMs: number; at: number }
type Saved = { repertoires: Record<string, Repertoire>; reviews: Reviews; history: Attempt[]; positions: Record<string, GraphPosition>; edges: GraphEdge[]; selected: string; preset: string; dark: boolean }
const initialFen = new Chess().fen()
const ratings = [1600, 1800, 2000, 2200]
const speeds = ['blitz', 'rapid', 'classical']
const modeLabels: Record<Mode, string> = { coverage: 'Coverage', realistic: 'Realistic', weakness: 'Weakness', spaced: 'Spaced repetition', breadth: 'Breadth first', depth: 'Depth first' }
const fmt = (n: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const pct = (n: number) => `${Math.round(n * 100)}%`

function PositionNode({ data }: { data: { label: string; sub: string; status: string; active: boolean; onPractice: () => void } }) {
  return <div className={`flow-node ${data.status} ${data.active ? 'active' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <div className="node-top"><span className="node-dot" /> <span>{data.label}</span></div>
    <div className="node-sub">{data.sub}</div>
    <button className="node-practice" onClick={event => { event.stopPropagation(); data.onPractice() }}>Practice from here <ArrowRight size={12}/></button>
    <Handle type="source" position={Position.Right} />
  </div>
}
const nodeTypes = { position: PositionNode }

export default function App() {
  const [preset, setPreset] = useState(PRESETS[2].name)
  const [customSide, setCustomSide] = useState<Side>('white')
  const [selected, setSelected] = useState(identity(initialFen))
  const [positions, setPositions] = useState<Record<string, GraphPosition>>({ [identity(initialFen)]: { fen: initialFen, path: [], ply: 0, expanded: false } })
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [repertoires, setRepertoires] = useState<Record<string, Repertoire>>({})
  const [reviews, setReviews] = useState<Reviews>({})
  const [history, setHistory] = useState<Attempt[]>([])
  const [data, setData] = useState<Record<string, ExplorerData>>({})
  const [filters, setFilters] = useState<Filters>({ ratings, speeds })
  const [minFrequency, setMinFrequency] = useState(1)
  const [targetCoverage, setTargetCoverage] = useState(90)
  const [maxDepth, setMaxDepth] = useState(16)
  const [repetitions, setRepetitions] = useState(3)
  const [mode, setMode] = useState<Mode>('coverage')
  const [session, setSession] = useState<Session | null>(null)
  const [feedback, setFeedback] = useState('Select a move or expand a position to begin.')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [dark, setDark] = useState(true)
  const [tab, setTab] = useState<'explore' | 'progress'>('explore')
  const [analysis, setAnalysis] = useState<Evaluation[] | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [ready, setReady] = useState(false)
  const [openingMenu, setOpeningMenu] = useState(false)
  const [search, setSearch] = useState('')
  const [customFen, setCustomFen] = useState('')
  const [selectedMove, setSelectedMove] = useState<string | null>(null)
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const abort = useRef<AbortController | null>(null)
  const decisionStart = useRef(Date.now())

  const currentPreset = PRESETS.find(p => p.name === preset)
  const side = currentPreset?.side || customSide
  const repertoire = repertoires[preset] || {}
  const position = positions[selected] || positions[identity(initialFen)]
  const boardFen = session?.fen || position.fen
  const boardKey = identity(boardFen)
  const explorerData = data[boardKey]
  const offline = explorerData?.source === 'book'
  const allMoves = explorerData?.moves || []
  const visibleMoves = allMoves.filter(m => explorerData?.source === 'book' || frequency(m, explorerData!) * 100 >= minFrequency)
  const selectedChoice = selectedMove ? repertoire[boardKey]?.[selectedMove] : undefined
  const practiced = new Set(Object.keys(reviews).filter(key => reviews[key].tries).map(key => key.split('|')[0])).size
  const accurate = Object.values(reviews).reduce((n, r) => n + r.successes, 0)
  const attempts = Object.values(reviews).reduce((n, r) => n + r.tries, 0)
  const failures = Object.values(reviews).reduce((n, r) => n + r.failures, 0)

  useEffect(() => { read<Saved>('state').then(saved => { if (saved) { setRepertoires(saved.repertoires || {}); setReviews(saved.reviews || {}); setHistory(saved.history || []); setPositions(saved.positions || {}); setEdges(saved.edges || []); setSelected(saved.selected || identity(initialFen)); setPreset(saved.preset || PRESETS[2].name); setDark(saved.dark ?? true) } else usePreset(PRESETS[2].name) }).catch(() => setError('Local storage is unavailable. Progress will not persist.')).finally(() => setReady(true)) }, [])
  useEffect(() => { if (ready) write('state', { repertoires, reviews, history, positions, edges, selected, preset, dark } satisfies Saved).catch(() => setError('Could not save progress locally.')) }, [ready, repertoires, reviews, history, positions, edges, selected, preset, dark])

  const fetchPosition = useCallback(async (fen: string, signal?: AbortSignal) => {
    const key = identity(fen)
    if (data[key]) return data[key]
    const result = await explorer(fen, filters, signal)
    setData(old => ({ ...old, [key]: result }))
    return result
  }, [data, filters])
  useEffect(() => { const controller = new AbortController(); setLoading(true); fetchPosition(boardFen, controller.signal).catch(e => { if (e.name !== 'AbortError') setError(e.message) }).finally(() => setLoading(false)); return () => controller.abort() }, [boardKey, filters])

  function usePreset(name: string) {
    const choice = PRESETS.find(p => p.name === name)
    if (!choice) return
    const game = new Chess()
    const nodes: Record<string, GraphPosition> = {}
    const links: GraphEdge[] = []
    let prior = identity(game.fen())
    nodes[prior] = { fen: game.fen(), path: [], ply: 0, expanded: true }
    choice.moves.forEach((san, index) => {
      const move = game.move(san)
      const key = identity(game.fen())
      const uci = move.from + move.to + (move.promotion || '')
      nodes[key] = { fen: game.fen(), path: choice.moves.slice(0, index + 1), ply: index + 1, expanded: index < choice.moves.length - 1 }
      links.push({ id: `${prior}|${uci}`, from: prior, to: key, san: move.san, uci, frequency: 0 })
      prior = key
    })
    setPositions(old => ({ ...old, ...nodes }))
    setEdges(old => [...old.filter(e => !links.some(l => l.id === e.id)), ...links])
    setPreset(name); setSelected(prior); setSession(null); setFeedback(`${name} loaded. Expand the graph or play a move.`); setOpeningMenu(false)
  }
  function useFen() {
    try { const game = new Chess(customFen); const key = identity(game.fen()); setPositions(old => ({ ...old, [key]: { fen: game.fen(), path: [], ply: (Number(game.fen().split(' ')[5]) - 1) * 2 + (game.turn() === 'b' ? 1 : 0), expanded: false } })); setSelected(key); setPreset('Custom'); setSession(null); setError('') } catch { setError('Enter a valid FEN.') }
  }
  async function expand(key = selected) {
    const node = positions[key]
    if (!node) return
    if (Object.keys(positions).length >= 100) { setError('Graph limit reached (100 positions). Collapse or start another opening.'); return }
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller
    setLoading(true); setError('')
    try {
      const result = await fetchPosition(node.fen, controller.signal)
      const moves = result.moves.filter(m => result.source === 'book' || frequency(m, result) * 100 >= minFrequency)
      const children: Record<string, GraphPosition> = {}
      const links: GraphEdge[] = []
      for (const m of moves.slice(0, Math.max(0, 100 - Object.keys(positions).length))) {
        const fen = nextFen(node.fen, m.uci); const child = identity(fen)
        if (!positions[child]) children[child] = { fen, path: [...node.path, m.san], ply: node.ply + 1, expanded: false }
        links.push({ id: `${key}|${m.uci}`, from: key, to: child, san: m.san, uci: m.uci, frequency: frequency(m, result) })
      }
      setPositions(old => ({ ...old, ...children, [key]: { ...old[key], expanded: true } }))
      setEdges(old => [...old.filter(e => !links.some(l => l.id === e.id)), ...links])
      setFeedback(`${moves.length} continuations loaded from ${result.source === 'book' ? 'the offline Lichess opening book (no game statistics)' : 'Lichess Explorer'}.`)
    } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message) } finally { setLoading(false) }
  }
  function collapse() { setPositions(old => ({ ...old, [selected]: { ...old[selected], expanded: false } })) }
  function toggleChoice(uci: string, choice: Choice) {
    setRepertoires(old => { const rep = old[preset] || {}; const choices = { ...(rep[boardKey] || {}) }; if (choices[uci] === choice) delete choices[uci]; else choices[uci] = choice; return { ...old, [preset]: { ...rep, [boardKey]: choices } } })
  }
  function setBoardMove(from: string, to: string, promotion = 'q') {
    const move = playUci(boardFen, from + to + promotion) || playUci(boardFen, from + to)
    if (!move) return false
    const uci = move.from + move.to + (move.promotion || '')
    if (session) { if (!isMyTurn(session.fen, side) || session.busy) return false; handlePracticeMove(uci); return true }
    const fen = nextFen(boardFen, uci), key = identity(fen)
    const ply = position.ply + 1
    setPositions(old => ({ ...old, [key]: old[key] || { fen, path: [...position.path, move.san], ply, expanded: false } }))
    setEdges(old => old.some(e => e.id === `${selected}|${uci}`) ? old : [...old, { id: `${selected}|${uci}`, from: selected, to: key, san: move.san, uci, frequency: explorerData?.moves.find(m => m.uci === uci) ? frequency(explorerData.moves.find(m => m.uci === uci)!, explorerData) : 0 }])
    setSelected(key); setSelectedMove(null); setFeedback(`Played ${move.san}. Explore continuations or mark your repertoire move.`)
    return true
  }
  function clickSquare(square: Square) {
    const game = new Chess(boardFen)
    const piece = game.get(square)
    if (selectedSquare === square) { setSelectedSquare(null); return }
    if (selectedSquare && setBoardMove(selectedSquare, square)) { setSelectedSquare(null); return }
    setSelectedSquare(piece?.color === game.turn() ? square : null)
  }
  function startPractice(key = selected) {
    const node = positions[key]
    if (!node) return
    setSelected(key); setTab('explore'); setSession({ start: node.fen, fen: node.fen, startPly: node.ply, ply: node.ply, done: 0, repetitions, endPly: Math.max(node.ply + 1, maxDepth * 2), mode, visits: {}, started: Date.now(), busy: false })
    decisionStart.current = Date.now(); setFeedback('Practice started. Recall your repertoire moves.'); setError('')
  }
  function finishLine(active: Session) {
    const done = active.done + 1
    const next = nextRepetition(active)
    if (!next) { setSession(null); setFeedback(`Session complete: ${done} line${done === 1 ? '' : 's'} practiced.`) }
    else { setSession({ ...next, busy: false }); setFeedback(`Line ${done} complete. Starting another variation.`); decisionStart.current = Date.now() }
  }
  async function handlePracticeMove(uci: string) {
    if (!session) return
    const key = moveKey(session.fen, uci)
    const choice = repertoire[identity(session.fen)]?.[uci]
    const elapsed = Date.now() - decisionStart.current
    if (choice !== 'preferred') {
      setReviews(old => ({ ...old, [key]: recordReview(old[key], false, elapsed) }))
      setHistory(old => [...old, { opening: preset, move: key, success: false, durationMs: elapsed, at: Date.now() }])
      setFeedback(choice === 'sound' ? 'Playable alternative, but outside this repertoire. Retry your preferred move.' : choice === 'blunder' || choice === 'inaccurate' ? `Marked ${choice}. Retry your repertoire move.` : 'Outside your repertoire. Checking the engine…')
      if (!choice) {
        try {
          const evals = await analyze(session.fen, 5, 12)
          const drop = scoreMove(uci, evals)
          setFeedback(drop === null ? 'Outside your repertoire. Engine did not rank this move; no chess mistake claimed. Retry or mark it preferred.' : drop > 180 ? `Engine: ${Math.round(drop / 100 * 10) / 10} pawns below best. Retry your repertoire move.` : 'Playable alternative outside your repertoire. Retry or mark it preferred.')
        } catch { setFeedback('Outside your repertoire. Engine unavailable; retry or mark it preferred.') }
      }
      decisionStart.current = Date.now(); return
    }
    setReviews(old => ({ ...old, [key]: recordReview(old[key], true, elapsed) }))
    setHistory(old => [...old, { opening: preset, move: key, success: true, durationMs: elapsed, at: Date.now() }])
    const fen = nextFen(session.fen, uci), ply = session.ply + 1
    const next = { ...session, fen, ply, started: Date.now() }
    setFeedback(`Correct: ${playUci(session.fen, uci)?.san}.`)
    decisionStart.current = Date.now()
    if (ply >= session.endPly || new Chess(fen).isGameOver()) finishLine(next)
    else setSession(next)
  }
  useEffect(() => {
    if (!session || isMyTurn(session.fen, side) || session.busy) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const result = await fetchPosition(session.fen)
        if (cancelled) return
        const eligible = result.moves.filter(m => result.source === 'book' || frequency(m, result) * 100 >= minFrequency)
        let sum = 0; const included = eligible.filter(m => { sum += frequency(m, result) * 100; return sum - frequency(m, result) * 100 < targetCoverage })
        const chosen = selectMove(included.length ? included : eligible, result, session.mode, session.visits, reviews, session.fen)
        if (!chosen) { setSession(null); setFeedback('No opponent continuation is available here. Choose another position or try again when Lichess Explorer responds.'); return }
        const key = moveKey(session.fen, chosen.uci)
        const fen = nextFen(session.fen, chosen.uci), ply = session.ply + 1
        const next = { ...session, fen, ply, visits: { ...session.visits, [key]: (session.visits[key] || 0) + 1 } }
        setFeedback(`Opponent played ${chosen.san}. Your move.`)
        decisionStart.current = Date.now()
        if (ply >= session.endPly || new Chess(fen).isGameOver()) finishLine(next)
        else setSession(next)
      } catch (e) { if (!cancelled) setError((e as Error).message) }
    }, 450)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [session?.fen, session?.done, filters, side, minFrequency, targetCoverage])
  async function runAnalysis() { setAnalyzing(true); setAnalysis(null); try { setAnalysis(await analyze(boardFen, 4, 14)) } catch (e) { setError((e as Error).message) } finally { setAnalyzing(false) } }
  function selectGraph(key: string) { if (session) setSession(null); setSelected(key); setSelectedMove(null); setAnalysis(null) }

  const graph = useMemo(() => {
    const visible = new Set<string>(); const root = identity(initialFen)
    const stack = [root]
    while (stack.length && visible.size < 100) { const key = stack.shift()!; if (visible.has(key)) continue; visible.add(key); if (positions[key]?.expanded) edges.filter(e => e.from === key).forEach(e => stack.push(e.to)) }
    if (!visible.has(selected)) { visible.add(selected); const p = positions[selected]; if (p) { let game = new Chess(); visible.add(identity(game.fen())); p.path.forEach(san => { try { game.move(san); visible.add(identity(game.fen())) } catch { /* custom FEN */ } }) } }
    const byPly: Record<number, string[]> = {}
    ;[...visible].forEach(key => { const ply = positions[key]?.ply ?? 0; (byPly[ply] ||= []).push(key) })
    const nodes: Node[] = [...visible].filter(key => positions[key]).map(key => {
      const p = positions[key]; const idx = byPly[p.ply].indexOf(key)
      const review = Object.entries(reviews).filter(([k]) => k.startsWith(key + '|')).map(([, r]) => r)
      const status = review.some(r => r.failures > r.successes) ? 'failed' : review.some(r => r.successes >= 3) ? 'mastered' : review.some(r => r.tries) ? 'learning' : Object.values(repertoire[key] || {}).some(v => v === 'preferred') ? 'prepared' : 'unstudied'
      return { id: key, type: 'position', position: { x: p.ply * 225, y: idx * 118 - (byPly[p.ply].length - 1) * 59 }, data: { label: p.path.at(-1) || (p.ply ? 'Position' : 'Start'), sub: `${p.ply ? `Move ${Math.ceil(p.ply / 2)}` : 'Initial position'} · ${status}`, status, active: selected === key, onPractice: () => startPractice(key) } }
    })
    const flowEdges: Edge[] = edges.filter(e => visible.has(e.from) && visible.has(e.to) && positions[e.from]?.expanded).map(e => ({ id: e.id, source: e.from, target: e.to, label: `${e.san}${e.frequency ? ` · ${pct(e.frequency)}` : ''}`, type: 'smoothstep', animated: selected === e.to, style: { stroke: e.frequency > 0.2 ? '#7e9caf' : '#94a3b8', strokeWidth: e.frequency > 0.2 ? 2 : 1 }, labelStyle: { fill: dark ? '#9eb1c3' : '#617384', fontSize: 11 } }))
    return { nodes, edges: flowEdges }
  }, [positions, edges, selected, reviews, repertoire, dark])

  const path = position.path.join('  ')
  const coverageValues = [5, 8, 10, 15].map(d => ({ depth: d, value: coverage(position.fen, side, repertoire, data, Math.max(0, d * 2 - position.ply)) }))
  const sortedPresets = PRESETS.filter(p => `${p.name} ${p.family}`.toLowerCase().includes(search.toLowerCase()))
  const byOpening = [...new Set(history.map(attempt => attempt.opening))].map(name => { const attempts = history.filter(attempt => attempt.opening === name); return { name, count: attempts.length, correct: attempts.filter(attempt => attempt.success).length, positions: new Set(attempts.map(attempt => attempt.move.split('|')[0])).size } })

  return <div className={`app ${dark ? 'dark' : 'light'}`}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><GitBranch size={22}/></span><span>Opening <b>Atlas</b><small>CHESS REPERTOIRE STUDIO</small></span></div>
      <div className="sidebar-label">WORKSPACE</div>
      <button className={`nav-item ${tab === 'explore' ? 'selected' : ''}`} onClick={() => setTab('explore')}><Compass size={18}/> Explorer</button>
      <button className={`nav-item ${tab === 'progress' ? 'selected' : ''}`} onClick={() => setTab('progress')}><Activity size={18}/> Progress <span className="nav-count">{practiced}</span></button>
      <div className="sidebar-label openings-label">OPENING LIBRARY</div>
      <button className="opening-current" onClick={() => setOpeningMenu(!openingMenu)}><span className="opening-icon">{side === 'white' ? '♔' : '♚'}</span><span><strong>{preset}</strong><small>{currentPreset?.family || 'Custom position'}</small></span><ChevronDown size={16}/></button>
      {openingMenu && <div className="opening-menu"><div className="searchbox"><Search size={15}/><input aria-label="Search openings" placeholder="Search openings" value={search} onChange={e => setSearch(e.target.value)}/></div><div className="opening-list">{sortedPresets.map(p => <button key={p.name} onClick={() => usePreset(p.name)}><span>{p.side === 'white' ? '♔' : '♚'}</span><span>{p.name}<small>{p.family}</small></span></button>)}</div><div className="custom-fen"><input aria-label="Custom FEN" placeholder="Or paste any legal FEN" value={customFen} onChange={e => setCustomFen(e.target.value)}/><button onClick={useFen}>Load</button></div></div>}
      <div className="sidebar-spacer"/>
      <div className="sidebar-tip"><Target size={17}/><strong>Build your repertoire</strong><p>Mark preferred moves at each position, then practice them from any node.</p></div>
      <button className="theme-button" onClick={() => setDark(!dark)}>{dark ? <Sun size={17}/> : <Moon size={17}/>} {dark ? 'Light mode' : 'Dark mode'}</button>
    </aside>

    <main className="workspace">
      <header className="topbar"><div className="breadcrumbs">Workspace <span>/</span> {tab === 'explore' ? 'Opening explorer' : 'Progress'}</div><div className="top-actions"><span className={`api-status ${offline ? 'offline' : ''}`}><span/> {offline ? 'Offline opening book · stats unavailable' : 'Lichess Explorer'}</span><button className="header-theme" onClick={() => setDark(!dark)} aria-label="Toggle theme">{dark ? <Sun size={17}/> : <Moon size={17}/>}</button></div></header>
      {tab === 'progress' ? <div className="progress-page"><div className="page-heading"><div><span className="eyebrow">YOUR DEVELOPMENT</span><h1>Progress overview</h1><p>Calculated from the practice attempts saved on this device.</p></div></div><div className="stat-grid"><div className="stat-card"><span>POSITIONS STUDIED</span><strong>{practiced}</strong><small>Unique board positions</small></div><div className="stat-card"><span>RECALL ACCURACY</span><strong>{attempts ? pct(accurate / attempts) : '—'}</strong><small>{accurate} correct of {attempts} attempts</small></div><div className="stat-card"><span>RECALL MISSES</span><strong>{failures}</strong><small>Outside repertoire attempts</small></div><div className="stat-card"><span>AVG DECISION</span><strong>{attempts ? `${Math.round(Object.values(reviews).reduce((n, r) => n + r.totalMs, 0) / attempts / 1000)}s` : '—'}</strong><small>Across all practice decisions</small></div></div><div className="panel progress-list"><div className="panel-heading"><h2>Review history</h2><span>{Object.keys(reviews).length} items</span></div>{Object.entries(reviews).sort((a,b) => b[1].last - a[1].last).slice(0, 25).map(([key, r]) => <div className="review-row" key={key}><span className={`review-dot ${r.failures > r.successes ? 'failed' : 'mastered'}`}/><span className="mono">{key.split('|').at(-1)}</span><span>{r.successes}/{r.tries} correct</span><span>Next {new Date(r.due).toLocaleDateString()}</span></div>)}{!attempts && <div className="empty-state">Practice a line to begin tracking recall.</div>}</div><div className="panel progress-list"><div className="panel-heading"><h2>By opening</h2><span>{byOpening.length} openings</span></div>{byOpening.map(item => <div className="opening-progress-row" key={item.name}><strong>{item.name}</strong><span>{item.positions} positions</span><span>{item.correct}/{item.count} recalled</span><b>{pct(item.correct / item.count)}</b></div>)}{!byOpening.length && <div className="empty-state">No opening-specific practice yet.</div>}</div></div> : <>
      <div className="page-heading"><div><span className="eyebrow">OPENING EXPLORER <span className="eyebrow-line"/></span><h1>{preset}</h1><p>{currentPreset?.family || 'Custom position'} <span>·</span> {side === 'white' ? 'Playing White' : 'Playing Black'} <span>·</span> {session ? `Practice line ${session.done + 1} of ${session.repetitions}` : `Move ${Math.ceil(position.ply / 2)}`}</p></div><button className="settings-button" onClick={() => document.getElementById('settings')?.scrollIntoView({ behavior: 'smooth' })}><Settings2 size={17}/> Settings</button></div>
      {error && <div className="error-banner">{error}<button onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
      <div className="content-grid">
        <section className="board-column"><div className="panel board-panel"><div className="panel-heading"><div><span className="section-kicker">CURRENT POSITION</span><h2>{session ? 'Training board' : 'Explore the board'}</h2></div><span className="live-pill"><span/> {session ? 'PRACTICE' : 'LIVE BOARD'}</span></div><div className="board-wrap"><Chessboard options={{ position: boardFen, boardOrientation: side, onPieceDrop: ({ sourceSquare, targetSquare }) => targetSquare ? setBoardMove(sourceSquare, targetSquare) : false, onSquareClick: ({ square }) => clickSquare(square as Square), squareStyles: selectedSquare ? { [selectedSquare]: { boxShadow: 'inset 0 0 0 4px #21cbaa' } } : {}, boardStyle: { borderRadius: 8 }, lightSquareStyle: { backgroundColor: dark ? '#e4e9e2' : '#f1eee5' }, darkSquareStyle: { backgroundColor: dark ? '#7c9d92' : '#88a89a' }, animationDurationInMs: 180 }} /></div><div className="move-strip"><span className="move-strip-label">LINE</span><span>{session ? 'Practicing from selected node' : path || 'Starting position'}</span></div><div className="board-controls"><button onClick={() => { if (session) setSession(null); else if (position.path.length) { const p = position.path.slice(0, -1); const key = identity(gameFrom(p).fen()); if (positions[key]) setSelected(key) } }} aria-label="Previous position"><ArrowLeft size={17}/></button><button onClick={() => { setSession(null); setSelected(identity(initialFen)); setFeedback('Returned to the initial position.') }}><RotateCcw size={16}/> Reset</button><button onClick={() => { const edge = edges.find(e => e.from === selected); if (edge) selectGraph(edge.to) }} aria-label="Next position"><ArrowRight size={17}/></button></div></div><div className={`feedback ${session ? 'training' : ''}`}><div className="feedback-icon">{session ? <Target size={18}/> : <CircleHelp size={18}/>}</div><p>{feedback}</p></div></section>
        <section className="graph-column"><div className="panel graph-panel"><div className="panel-heading graph-heading"><div><span className="section-kicker">VISUAL REPERTOIRE</span><h2>Variation map</h2></div><div className="graph-actions"><span>{graph.nodes.length} positions</span><button title="Expand selected position" onClick={() => expand()} disabled={loading}><GitBranch size={16}/> Expand</button></div></div><div className="graph-viewport"><ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} onNodeClick={(_, node) => selectGraph(node.id)} fitView minZoom={0.25} maxZoom={1.8}><Background color={dark ? '#27384a' : '#d5dde1'} gap={20} size={1}/><Controls showInteractive={false}/></ReactFlow></div><div className="graph-footer"><div className="legend"><span><i className="mastered"/> Mastered</span><span><i className="learning"/> Learning</span><span><i className="failed"/> Failed</span><span><i className="unstudied"/> Unstudied</span></div><button onClick={position.expanded ? collapse : () => expand()}>{position.expanded ? 'Collapse selected' : 'Expand selected'} <ArrowRight size={14}/></button></div></div><div className="graph-hint"><Crosshair size={15}/> Drag to pan, scroll to zoom. Click a node to inspect it.</div></section>
        <section className="info-column"><div className="panel position-panel"><div className="panel-heading"><div><span className="section-kicker">POSITION INSIGHTS</span><h2>{explorerData?.opening?.name || 'Position details'}</h2></div><span className="book-icon"><BookOpen size={17}/></span></div><div className="position-meta"><span>To move</span><strong>{boardFen.split(' ')[1] === 'w' ? 'White' : 'Black'}</strong></div><div className="position-meta"><span>Games in database</span><strong>{explorerData && !offline ? fmt(total(explorerData)) : loading ? 'Loading…' : '—'}</strong></div><div className="results-bar" title="White wins / draws / Black wins">{explorerData && total(explorerData) > 0 && <><span style={{ width: pct(explorerData.white / total(explorerData)) }}/><span style={{ width: pct(explorerData.draws / total(explorerData)) }}/><span style={{ width: pct(explorerData.black / total(explorerData)) }}/></>}</div><div className="results-legend"><span>White {explorerData && total(explorerData) ? pct(explorerData.white / total(explorerData)) : '—'}</span><span>Draw {explorerData && total(explorerData) ? pct(explorerData.draws / total(explorerData)) : '—'}</span><span>Black {explorerData && total(explorerData) ? pct(explorerData.black / total(explorerData)) : '—'}</span></div></div>
        <div className="panel moves-panel"><div className="panel-heading"><div><span className="section-kicker">FROM THIS POSITION</span><h2>{offline ? 'Book moves' : 'Popular moves'}</h2></div><span className="subtle-count">{visibleMoves.length} moves</span></div><div className="moves-table-header"><span>MOVE</span><span>GAMES</span><span>FREQ.</span></div><div className="moves-list">{visibleMoves.map((m, i) => <button key={m.uci} className={`move-row ${selectedMove === m.uci ? 'selected' : ''}`} onClick={() => setSelectedMove(m.uci)}><span className="move-name"><span className="move-rank">{i + 1}</span><strong>{m.san}</strong>{repertoire[boardKey]?.[m.uci] === 'preferred' && <Check size={14} className="preferred-check"/>}</span><span>{offline ? '—' : fmt(m.white + m.draws + m.black)}</span><span className="freq-cell">{offline ? '—' : pct(frequency(m, explorerData!))}{!offline && <i style={{ width: pct(frequency(m, explorerData!)) }}/>} </span></button>)}{!visibleMoves.length && <div className="empty-state">{loading ? 'Loading real Lichess statistics…' : 'No moves match these filters.'}</div>}</div>{selectedMove && <div className="move-details"><div><strong>{visibleMoves.find(m => m.uci === selectedMove)?.san || selectedMove}</strong><span>{selectedChoice ? `${selectedChoice} move` : 'Unclassified move'}</span></div><div className="choice-buttons">{(['preferred', 'sound', 'inaccurate', 'blunder'] as Choice[]).map(choice => <button key={choice} className={selectedChoice === choice ? 'active' : ''} onClick={() => toggleChoice(selectedMove, choice)}>{choice}</button>)}</div><button className="play-move" onClick={() => setBoardMove(selectedMove.slice(0,2), selectedMove.slice(2,4), selectedMove[4])}>Play move <ArrowRight size={14}/></button></div>}</div></section>
        <div className="panel training-panel"><div className="training-heading"><div className="training-icon"><Target size={20}/></div><div><span className="section-kicker">RECALL TRAINING</span><h2>Practice this position</h2></div></div><p>Train your moves against {offline ? 'published opening lines' : 'real opponent frequencies'}, starting exactly here.</p><div className="training-grid"><label>Selection<select value={mode} onChange={e => setMode(e.target.value as Mode)}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Repetitions<input type="number" min="1" max="50" value={repetitions} onChange={e => setRepetitions(Math.max(1, Number(e.target.value) || 1))}/></label></div>{session ? <button className="primary-button stop" onClick={() => { setSession(null); setFeedback('Practice stopped.') }}>Stop practice <X size={17}/></button> : <button className="primary-button" onClick={() => startPractice()}>Practice from here <Play size={17} fill="currentColor"/></button>}{session && <div className="session-progress">Line {session.done + 1} / {session.repetitions} · Ply {session.ply} / {session.endPly}</div>}</div>
        <div className="panel engine-panel"><div className="panel-heading"><div><span className="section-kicker">ENGINE CHECK</span><h2>Stockfish analysis</h2></div><TrendingUp size={17}/></div><button className="secondary-button" onClick={runAnalysis} disabled={analyzing}>{analyzing ? 'Analyzing…' : 'Analyze position'}</button>{analysis && <div className="engine-lines">{analysis.map((e, i) => <div key={i}><strong>{e.mate === undefined ? `${e.cp * (boardFen.split(' ')[1] === 'w' ? 1 : -1) >= 0 ? '+' : ''}${(e.cp * (boardFen.split(' ')[1] === 'w' ? 1 : -1) / 100).toFixed(2)}` : `M${e.mate * (boardFen.split(' ')[1] === 'w' ? 1 : -1)}`}</strong><span>{lineSan(boardFen, e.line)}</span></div>)}<small>Depth {analysis[0]?.depth}. Scores are from White’s perspective. A narrow choice alone is not a tactic.</small></div>}</div>
        <div className="panel coverage-panel"><div className="panel-heading"><div><span className="section-kicker">REPERTOIRE COVERAGE</span><h2>Prepared paths</h2></div></div><div className="coverage-rows">{coverageValues.map(v => <div key={v.depth}><span>Through move {v.depth}</span><strong>{v.value === null ? 'Need more data' : pct(v.value)}</strong></div>)}</div><small>Conditional Lichess frequencies. “Need more data” means branches have not been loaded.</small></div>
        <div className="panel settings-panel" id="settings"><div className="panel-heading"><div><span className="section-kicker">EXPLORER OPTIONS</span><h2>Study settings</h2></div><Settings2 size={17}/></div><label>Ratings<select value={filters.ratings.join(',')} onChange={e => { setData({}); setFilters(old => ({ ...old, ratings: e.target.value.split(',').map(Number) })) }}><option value="1000,1200,1400">1000–1400</option><option value="1600,1800,2000,2200">1600–2200</option><option value="2200,2500">2200–2500</option></select></label><label>Time controls<select value={filters.speeds.join(',')} onChange={e => { setData({}); setFilters(old => ({ ...old, speeds: e.target.value.split(',') })) }}><option value="bullet,blitz">Bullet + Blitz</option><option value="blitz,rapid,classical">Blitz + Rapid + Classical</option><option value="rapid,classical">Rapid + Classical</option></select></label><label>Minimum frequency <b>{minFrequency}%</b><input type="range" min="0" max="20" value={minFrequency} onChange={e => setMinFrequency(Number(e.target.value))}/></label><label>Opponent coverage <b>{targetCoverage}%</b><input type="range" min="50" max="100" value={targetCoverage} onChange={e => setTargetCoverage(Number(e.target.value))}/></label><label>Ending move depth<input type="number" min="1" max="50" value={maxDepth} onChange={e => setMaxDepth(Math.max(1, Number(e.target.value) || 1))}/></label>{preset === 'Custom' && <label>Repertoire side<select value={customSide} onChange={e => setCustomSide(e.target.value as Side)}><option value="white">White</option><option value="black">Black</option></select></label>}</div>
      </div></>}
    </main>
  </div>
}
