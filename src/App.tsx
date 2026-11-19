import { EvaluationBar } from './EvaluationBar'
import { generationProvenance } from './generationProvenance'
import { GenerationDetails } from './GenerationDetails'
import { opponentPreference, effectiveOpponent, availableGenerationMode } from './opponentSettings'
import PersonalGames from './PersonalGamesPanel'
import { gameView, getPersonalGame, updatePersonalGame, type PersonalGame } from './personalGames'
import { transformLine, originalLineId, linePerspective, type Perspective } from './lineTransform'
import { PAUSED_RECALL_STORAGE, readRecallHistory, PLAYLIST_PRACTICE_STORAGE, readPracticeHistory, rememberPractice, pausedPractice, queueNeighbor, type Practice } from './playlistPractice'
import { Playlist } from './Playlist'
import { PLAYLIST_STORAGE, playlistFromPosition, parsePlaylists, fromSession, rememberPlaylist, playlistEntries, matchingSession, resumableSession, playlistLabels, recallConcealed, type Collection, type PlaylistStore } from './playlists'
import { searchStatus } from './searchStatus'
import { MovementOverlay } from './MovementTrace'
import type { PlanPreview } from './PlannerMode'
import { explorationSettings } from './exploreVariations'
import type { AggressiveOptions } from './aggressiveGeneration'
import { parseCastlingPreference, castlingTolerance, type CastlingPreference } from './castlingPreference'
import type { RepertoireAction } from './RepertoirePage'
import { backgroundGeneration, pendingGeneration, type PendingGeneration } from './backgroundGeneration'
import { autoWorkers, backgroundBatch, newerBatch, pendingBatch, recentBatches, rememberBatch, type BatchHandle, type BatchStatus } from './backgroundBatch'
import GenerationQueue from './GenerationQueue'
import { cloudEvaluation } from './cloudEvaluation'
import { lazy, startTransition, Suspense } from 'react'
import { Profile } from './profiling'
import MoveExclusionsMenu from './GenerationMenu'
import type { GenerationStyle } from './generationStyle'
import { exclusionKey, readExclusions, EXCLUSIONS_STORAGE, type MoveExclusions } from './moveExclusions'
import MaterialCount, { materialBalance } from './MaterialCount'
import { queuePremove, premoveStatus, type Premove } from './premove'
import { branchVariation, branchLabel, divergenceLabel, migrateVariations, restoreKnownHistory } from './openingTree'
import { populationLabel } from './humanPopulation'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Chess, type Square } from 'chess.js'
import { StableBoard, GhostPieces, ghostArrowOptions } from './StableBoard'
import { StockfishPlans } from './StockfishPlans'
import { ArrowLeft, ArrowRight, BookOpen, Pause, Play, Search, Settings2, SkipBack, SkipForward, Sparkles, Square as StopIcon } from 'lucide-react'
const RepertoirePage = lazy(() => import('./RepertoirePage'))
const ClassicApp = lazy(() => import('./ClassicApp'))
import GameAnalysis from './AnalysisGraphs'
const Planner = lazy(() => import('./PlannerMode'))
const OpeningSelector = lazy(() => import('./OpeningSelector'))
import { PRESETS, frequency, identity, nextFen, outcomeRate, parseExplorerPerspective, playUci, sampleGames, sortExplorerMoves, total, type ExplorerData, type ExplorerMove, type ExplorerPerspective, type ExplorerSort, type Side } from './core'
import { readVariations, writeVariations, explorer, explorerCacheKey, explorerCacheStats, clearExplorerCache, read, write, type Filters } from './data'
import { connectLichess, disconnectLichess, finishLichessLogin, lichessToken } from './lichessAuth'
import { analyze, loadEngineCache, cachedAnalysis, scoreMove, type Evaluation } from './engine'
import { positionEvaluation, positions, recentLineEvaluation, type AnalysisPoint } from './gameAnalysis'
import { opponentProvenance } from './repertoireSummary'
import { CurrentLineSummary } from './CurrentLineSummary'
import { OpponentSource } from './OpponentSource'
import { continuationsAt, describeLineMove, lineFen, modelFallbackReason, moveNumber, nextLineIndex, restoreActiveLine, restoreTrainingSide, reviewMoveIndex, reviewPosition, saveVariation, terminal, waitingForGeneratedMove, type Generation, type GenerationMode, type LineMove, type Variation } from './learning'
import { loadOpenings, openingAt, openingFavoriteId, openingPositions, readOpeningFavorites, toggleOpeningFavorite, type OpeningRecord } from './openings'
import { analyzeFastSharpness, analyzeSharpness, invalidateFastSharpness, sharpnessLabel, type SharpnessResult, type SharpnessSettings } from './sharpness'
import { beginMemory, dueMemoryLines, emptyMemoryStats, finishMemory, memoryReviewPosition, numberedMoves, opponentReply, recallMove, revealMemory, type MemorySession, type MemoryStats } from './memorize'
import { ACTIVE_PRACTICE, FAMILY_STORAGE, rememberSession, sessionKey, finishFamilyAttempt, lineSignature, newBranch, newFamily, parseFamilies, practicePlaylist, startFamilyAttempt, type FamilyRecord } from './familyPractice'
import './learning.css'



const startFen = new Chess().fen()
const defaults: Filters = { ratings: [1600, 1800, 2000, 2200], speeds: ['blitz', 'rapid', 'classical'] }
const ACTIVE_LINE = 'opening-atlas-active-line-v1'
const EXPLORER_PERSPECTIVE = 'opening-atlas-explorer-perspective-v1'
const PLAYING_SIDE = 'opening-atlas-playing-side-v1'
const OPENING_FAVORITES = 'opening-atlas-opening-favorites-v1'
const MEMORY_STORAGE = 'memorize-stats-v1'
const ENGINE_SETTINGS = 'opening-atlas-engine-settings-v1'
const ANALYSIS_SECTIONS = 'opening-atlas-analysis-sections-v2'
const defaultSections = { line: true, playlist: false, engine: true, explorer: true }
type AnalysisSection = keyof typeof defaultSections
export const shouldRunPlanner = (expanded: boolean, generating: boolean, practicing: boolean, auto: boolean) => expanded && !generating && (!practicing || auto)
function initialEngineSettings() { try { return JSON.parse(localStorage.getItem(ENGINE_SETTINGS) || '{}') as { interactive?: number; generation?: number; verification?: number; grading?: number } } catch { return {} } }
const initialDepths = initialEngineSettings()
// Interactive deepening must not enlarge recall grading work. Preserve the older
// configured grading depth independently of the new interactive target.
const gradingDepth = initialDepths.grading ?? (initialDepths.interactive && initialDepths.interactive !== 24 ? initialDepths.interactive : 18)
const initialUrl = new URL(window.location.href)
const freshAnalysis = initialUrl.searchParams.get('analysis') === 'new'
function activeLine(): { line: Variation; ply: number; practice?: Practice | null } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVE_LINE) || 'null')
    if (!saved?.line?.id || !Array.isArray(saved.line.moves) || typeof saved.line.startFen !== 'string') return null
    lineFen(saved.line)
    return saved
  } catch { return null }
}
const MANUAL_HISTORY = 'opening-atlas-manual-history-v1'
const initialHistory = (() => {
  try { return restoreKnownHistory(JSON.parse(localStorage.getItem(MANUAL_HISTORY) || 'null'), initialUrl.searchParams.get('fen') || undefined) } catch { return undefined }
})()
const defaultHistory = (() => {
  if (freshAnalysis) return { startFen, moves: [] as string[], index: 0, opening: '', parentId: undefined }
  if (initialHistory) return initialHistory
  if (initialUrl.searchParams.has('fen')) return { startFen: initialFen(), moves: [] as string[], index: 0, opening: '', parentId: undefined }
  const game = new Chess(), moves = PRESETS[2].moves.map(san => { const m = game.move(san); return m.from + m.to + (m.promotion || '') })
  return { startFen, moves, index: moves.length, opening: PRESETS[2].name, parentId: undefined }
})()
const initialActive = activeLine()
const initialLineId = freshAnalysis || initialUrl.searchParams.has('game') ? null : initialUrl.searchParams.get('line') || (!initialUrl.searchParams.has('fen') ? initialActive?.line.id || null : null)
function initialFen() {
  try {
    if (initialUrl.searchParams.has('fen')) return new Chess(initialUrl.searchParams.get('fen')!).fen()
    const game = new Chess(); PRESETS[2].moves.forEach(move => game.move(move)); return game.fen()
  } catch { return startFen }
}
const results = sampleGames
const format = (n: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const score = (entry: Evaluation, fen: string) => entry.mate === undefined ? `${entry.cp * (fen.split(' ')[1] === 'w' ? 1 : -1) >= 0 ? '+' : ''}${(entry.cp * (fen.split(' ')[1] === 'w' ? 1 : -1) / 100).toFixed(2)}` : `M${entry.mate * (fen.split(' ')[1] === 'w' ? 1 : -1)}`

function ResultBar({ move }: { move: ExplorerMove }) {
  const games = results(move)
  if (!games) return <span className="no-results">No game results</span>
  const white = Math.round(move.white / games * 100)
  const black = Math.round(move.black / games * 100)
  return <div className="result-bar" aria-label={`${white}% white wins, ${Math.round(move.draws / games * 100)}% draws, ${black}% black wins`}><span className="result-white" style={{ width: `${move.white / games * 100}%` }}>{white >= 15 ? `${white}%` : ''}</span><span className="result-draw" style={{ width: `${move.draws / games * 100}%` }} /><span className="result-black" style={{ width: `${move.black / games * 100}%` }}>{black >= 15 ? `${black}%` : ''}</span></div>
}

function OutcomeSummary({ move, perspective }: { move: Pick<ExplorerMove, 'white' | 'draws' | 'black'>; perspective: ExplorerPerspective }) {
  if (!results(move)) return <span className="no-results">No game results</span>
  const order = perspective === 'black' ? ['black', 'draws', 'white'] as const : ['white', 'draws', 'black'] as const
  return <span className="outcome-summary">{order.map(outcome => <span key={outcome} className={perspective === outcome ? 'emphasized' : ''}>{outcome === 'draws' ? 'Draws' : `${outcome[0].toUpperCase()}${outcome.slice(1)} wins`} {Math.round(outcomeRate(move, outcome)! * 100)}%</span>)}</span>
}

function ConversionDetails({ line }: { line: Variation }) {
  const info = line.recommendation, evidence = info?.conversion
  if (!evidence) return null
  return <><p>{line.termination} {evidence.detail}</p><p>{info?.policy === "simple" && info.verification === "pending" ? "Deep verification: Not performed" : `Verification: ${info?.verification}`}; stability checks are preliminary. {evidence.modelStatus}</p><p>Advantage detected: {evidence.detectedPly === undefined ? 'not established' : `ply ${evidence.detectedPly}`}. Latest evaluation: {info?.objectiveCp === undefined ? 'unavailable' : `${info.objectiveCp / 100} pawns for ${line.side}, depth ${info.depth}, ply ${info.evaluationPly}`}.</p>{evidence.tablebase && <p>Tablebase at ply {evidence.tablebase.ply}: {evidence.tablebase.category} (side to move; cursed/blessed outcomes depend on the fifty-move rule).</p>}<details><summary>Conversion evidence</summary><p>Runtime {(info!.runtimeMs! / 1000).toFixed(2)}s · {info?.performance?.searches} engine searches · Seed {line.human?.seed}</p><ul>{evidence.points.map(p => <li key={p.ply}>Ply {p.ply}: evaluation {p.cp === undefined ? 'unavailable' : p.cp / 100}, depth {p.depth}; {p.mate === undefined ? '' : `predicted mate ${p.mate}; `}difficulty {p.difficulty ?? 'unavailable'}; acceptable moves {p.acceptable ?? 'unavailable'}; sensitivity {p.sensitivityCp ?? 'unavailable'} cp; stability {p.stable ? 'preliminary stable' : 'not established'}; tactical danger {p.danger ? `${p.danger.level} — ${p.danger.reason}${p.danger.responseDifficulty === undefined ? '' : ` After the preferred move, checked reply ${p.danger.reply} at depth ${p.danger.replyDepth}. Response difficulty ${p.danger.responseDifficulty}/100 at depth ${p.danger.responseDepth}; ${p.danger.responseChoices} responses preserve the prior evaluation.`}` : 'not assessed'}</li>)}</ul><ul>{evidence.material.map(p => <li key={p.ply}>Ply {p.ply}: White {p.white}, Black {p.black}; net change for {line.side}: {p.gain}; {p.event} (material alone is not proof)</li>)}</ul></details></>
}

function RecommendationSummary({ line }: { line: Variation }) {
  const info = line.recommendation
  if (!info) return null
  const cp = (value: number) => `${value >= 0 ? '+' : ''}${(value / 100).toFixed(2)}`
  if (info.policy === 'simple') return <GenerationDetails line={line}/>
  return <div className="recommendation-summary" aria-label="Recommendation verification"><strong>{(info.verification === 'failed' ? 'VERIFICATION FAILED' : line.human?.status) || (info.verification === 'passed' ? 'VERIFIED RECOMMENDATION' : info.verification === 'pending' ? 'CANDIDATE · VERIFYING' : 'VERIFICATION FAILED')}</strong>{line.human && <><span>VARIATION GENERATED · Source: {line.database === 'masters' ? 'Masters' : 'Lichess'} human games · Playing as {line.side}</span><span>Seed: {line.human.seed} · {line.human.policy} · Evaluations below are from {line.side}’s perspective.</span><span>Verification: {info.verification === 'pending' ? 'Preliminary' : info.verification} ({info.verificationScope || 'deep'} checks) · Verified generated user moves: {info.verifiedMoves ?? 'Not evaluated'} · {line.human.stopReason}</span><span>Opponent sampling: {line.moves.filter(m => m.sampling).length} human moves · Maximum omitted mass {Math.round(100 * Math.max(0, ...line.moves.map(m => m.sampling?.omittedMass || 0)))}%. Simulation probabilities are conditional on eligible returned moves.</span>{line.human.decisions.map((d, i) => <span key={i}>Decision {i + 1}: WDL expected-score bounds {(100 * d.lower).toFixed(1)}–{(100 * d.upper).toFixed(1)}% · evaluated mass {(100 * d.coverage).toFixed(1)}% (model estimate, not measured human win rate)</span>)}</>}{info.verification === 'passed' && <><span>Objective evaluation: {info.objectiveCp === undefined ? 'Unavailable' : cp(info.objectiveCp)} · Depth {info.depth ?? 'unavailable'}</span>{info.configuration?.discoveryDepth !== undefined && <span>Discovery depth {info.configuration.discoveryDepth} · Candidate soundness {info.configuration.candidateDepth} · Critical verification {info.configuration.verificationDepth}</span>}<span>Human model: {info.humanExpectedCp === undefined ? line.human ? 'Weighted sampling of eligible human moves' : 'Unavailable' : `${cp(info.humanExpectedCp)} from ${Math.round((info.humanCoverage || 0) * 100)}% sampled reply coverage`}</span><span>Preliminary difficulty: {info.userDifficulty === undefined ? 'Unavailable' : `${Math.round(info.userDifficulty)}/100`} · Opponent: {info.opponentDifficulty === undefined ? 'Unavailable' : `${Math.round(info.opponentDifficulty)}/100`}</span><span>Lowest checked evaluation: {info.objectiveStabilityCp === undefined ? 'Unavailable' : cp(info.objectiveStabilityCp)} · Reasonable choices: {info.practicalChoices ?? 'Not evaluated'}</span><span>Tactical fragility: {info.tacticalFragility === undefined ? 'Unavailable' : `${Math.round(info.tacticalFragility)}/100`} · Critical decisions: {info.criticalPoints ?? 'Unavailable'}</span><span>Material conceded: {info.sacrificeCp === undefined ? 'None detected' : `${(info.sacrificeCp / 100).toFixed(1)} pawns`}</span></>}<span>Generation style: {line.style === "aggressive" ? "Aggressive" : line.style === "solid" ? "Solid" : "Best move"}{line.style && line.style !== "best" ? ` · tolerance ${line.styleToleranceCp ?? 30} cp` : ""}</span><span>{info.reason}</span>{info.ranking && <span>{info.ranking}</span>}</div>
}

export default function App() {
  const [repertoirePage, setRepertoirePage] = useState(() => new URL(location.href).searchParams.get('page') === 'repertoire')
  const repertoireOrientation = useRef<Side | null>(null)
  useEffect(() => {
    const changed = () => setRepertoirePage(new URL(location.href).searchParams.get('page') === 'repertoire')
    window.addEventListener('popstate', changed)
    return () => window.removeEventListener('popstate', changed)
  }, [])
  function showRepertoire(show: boolean, line?: Variation) {
    const url = new URL(location.href)
    if (show) { url.searchParams.set('page', 'repertoire'); if (line) url.searchParams.set('repertoireLine', line.id); else url.searchParams.delete('repertoireLine') } else { url.searchParams.delete('page'); url.searchParams.delete('family'); url.searchParams.delete('repertoireLine') }
    history.pushState(null, '', url); setRepertoirePage(show); setPlaying(false)
    if (show) { stopGameAnalysis(); engineAbort.current?.abort(); sharpAbort.current?.abort() }
  }
  function repertoireAction(action: RepertoireAction, line: Variation, ply: number, facing: Side) {
    if (familyRecord) exitSession()
    showRepertoire(false)
    if (action === 'memorize') startMemory(line)
    else if (action === 'practice') startPractice(line, false, ply, line.moves.length, true)
    else { loadLine(line, ply); if (action === 'analysis') setAnalysisLineId(line.id); else setPlaying(true) }
    repertoireOrientation.current = selectedId !== line.id ? facing : null
    setFlipped(line.side !== facing)
  }
  function practiceRepertoire(group: Variation[]) {
    if (!group.length) return
    if (familyRecord) exitSession()
    showRepertoire(false); practiceQueue.current = group.slice(1).map(line => line.id); startPractice(group[0], true, 0, group[0].moves.length, true)
  }
  function saveSession(record: FamilyRecord) {
    try { const records = rememberSession(parseFamilies(localStorage.getItem(FAMILY_STORAGE)), record); localStorage.setItem(FAMILY_STORAGE, JSON.stringify(records)); localStorage.setItem(ACTIVE_PRACTICE, sessionKey(record.session)); setFamilyRecord(record); return true }
    catch { setError('Branch practice progress could not be saved. Browser storage is unavailable.'); return false }
  }
  function activateSession(record: FamilyRecord, navigate = true) {
    const source = fromSession(record)
    const existing = [...playlists.saved, ...playlists.recent, ...(playlists.review ? [playlists.review] : [])].find(p => p.id === record.session.playlistId || p.sessionKey === source.sessionKey && p.sessionStarted === source.sessionStarted)
    const collection = existing ? { ...existing, selected: source.selected, accessed: Date.now(), sessionKey: source.sessionKey, sessionStarted: source.sessionStarted } : source
    if (!persistPlaylists(rememberPlaylist(playlists, collection))) return
    record = { ...record, session: { ...record.session, playlistId: collection.id } }
    setSections(old => ({ ...old, line: true, playlist: true }))
    if (navigate) setPracticeAutoPlans(false)
    const current = record.session.memory
    const line = current && lines.find(line => line.id === current.lineId && lineSignature(line) === record.session.signatures[line.id])
    recoveredFamily.current = true
    if (line && current) { loadLine(line, current.index); setMemory(current); setIndex(current.index); setReviewIndex(null); setSide(record.session.side); setFlipped(false) }
    if (!saveSession(record)) return
    if (navigate) { showRepertoire(false); window.scrollTo(0, 0) }
  }
  function restartSession(reviewOnly = false) {
    if (!familyRecord) return
    const s = familyRecord.session, branch = s.branch
    const byId = new Map(lines.map(line => [line.id, line]))
    const latest = new Map(s.attempts.map(attempt => [attempt.id, attempt]))
    const ids = reviewOnly ? s.ids.filter(id => latest.get(id) && !latest.get(id)!.success) : branch?.allIds || s.ids
    const eligible = ids.flatMap(id => { const line = byId.get(id); return line && (!s.signatures[id] || lineSignature(line) === s.signatures[id]) ? [line] : [] })
    if (!eligible.length) return
    const record = branch ? newBranch(branch.key, s.family, s.side, eligible, branch.starts[eligible[0].id] || 0, { ...branch.options, coverage: reviewOnly ? 'once' : branch.options.coverage }, crypto.getRandomValues(new Uint32Array(1))[0], familyRecord, Date.now(), { filters, targetRating }) : newFamily(s.family, s.side, eligible, familyRecord)
    record.session.reviewMode = reviewOnly
    if (!reviewOnly) record.session.playlistId = activePlaylist?.id
    const started = startFamilyAttempt(record, byId)
    if (saveSession(started)) { activateSession(started, false); if (started.session.memory) setMemoryStats(old => ({ ...old, [started.session.memory!.lineId]: beginMemory(old[started.session.memory!.lineId] || emptyMemoryStats(), started.session.memory!.lineId, started.session.memory!.from, started.session.memory!.to).stats })) }
  }
  function stopSession() { if (!familyRecord) return; const s = familyRecord.session; const stopped = { ...familyRecord, session: { ...s, finished: Date.now(), stopped: true, memory: s.memory ? { ...s.memory, phase: 'complete' as const, message: 'Session stopped. The unfinished attempt was not graded.' } : null } }; if (saveSession(stopped)) setMemory(stopped.session.memory) }
  function exitSession() { try { localStorage.removeItem(ACTIVE_PRACTICE) } catch { /* The saved session record remains intact. */ } setFamilyRecord(null); setMemory(null); setPracticeAutoPlans(false); setReviewIndex(null) }
  function persistPlaylists(next: PlaylistStore) {
    try { localStorage.setItem(PLAYLIST_STORAGE, JSON.stringify(next)); setPlaylists(next); return true }
    catch { setError('Playlist changes could not be saved. Browser storage is unavailable.'); return false }
  }
  function suspendRecall() {
    if (!familyRecord && memory?.phase === 'active' && selected && !persistRecall(selected, memory)) return false
    if (familyRecord && memory?.phase === 'active' && !saveSession({ ...familyRecord, session: { ...familyRecord.session, memory } })) return false
    if (practice && selected && !persistPractice(selected, practice, index)) return false
    exitSession(); setPlaying(false); setPractice(null)
    return true
  }
  function openPlaylist(collection: Collection) {
    setPlaylistName(null)
    const entries = playlistEntries(collection, lines), line = entries.find(l => l.id === collection.selected) || entries[0]
    if (!suspendRecall() || !persistPlaylists(rememberPlaylist(playlists, { ...collection, selected: line?.id || '', accessed: Date.now() }))) return
    recoveredFamily.current = true
    if (line) enterPlaylistPractice(line, collection)
    else setError('This playlist has no remaining saved variations.')
    setSections(old => ({ ...old, playlist: true })); showRepertoire(false)
    return !!line
  }
  function generatePositionPlaylist() {
    const collection = playlistFromPosition(lines, {
      startFen: followingLine?.startFen || manual[0],
      moves: followingLine ? followingLine.moves.slice(0, positionIndex).map(move => move.uci) : manualMoves.slice(0, manualIndex),
      side: followingLine?.side || side,
      name: `${exactOpening?.name || followingLine?.opening || originName || 'Position'}${positionIndex ? ` · after ${currentMove}` : ''}`,
    })
    if (!collection) { setNotice('No existing continuations descend from this position.'); return }
    // Repeated clicks reuse the recent collection; saved collections remain untouched.
    const baseId = collection.id
    let suffix = 0
    while (playlists.saved.some(saved => saved.id === collection.id)) collection.id = `${baseId}:${++suffix}`
    if (openPlaylist(collection)) setNotice(`Playlist contains ${collection.ids.length} existing ${collection.ids.length === 1 ? 'line' : 'lines'}.`)
  }
  function exitPlaylist() {
    setPlaylistName(null)
    if (!suspendRecall()) return
    persistPlaylists({ ...playlists, active: null })
  }
  function persistRecall(line: Variation, attempt: MemorySession) {
    try { const history = readRecallHistory(localStorage.getItem(PAUSED_RECALL_STORAGE)); localStorage.setItem(PAUSED_RECALL_STORAGE, JSON.stringify({ ...history, [line.id]: { signature: lineSignature(line), memory: attempt } })); return true }
    catch { setError('Recall progress could not be saved. Your current attempt has been kept open.'); return false }
  }
  function persistPractice(line: Variation, attempt: Practice, ply: number) {
    try { const history = rememberPractice(readPracticeHistory(localStorage.getItem(PLAYLIST_PRACTICE_STORAGE)), line, attempt, ply); localStorage.setItem(PLAYLIST_PRACTICE_STORAGE, JSON.stringify(history)); return true }
    catch { setError('Practice progress could not be saved. Your current attempt has been kept open.'); return false }
  }
  function enterPlaylistPractice(line: Variation, collection: Collection | null = activePlaylist, retry = false) {
    if (line.sideUnconfirmed) { setError('Confirm the training side before practicing this line.'); return }
    try { line = trainingLine(line) } catch (error) { setError((error as Error).message); return }
    const from = collection?.branch?.ply || 0
    const record = perspective === 'normal' && collection && storedPlaylistSession(collection)
    if (!retry && record && resumableSession(record) && record.session.memory?.lineId === line.id && record.session.signatures[line.id] === lineSignature(line)) { activateSession(record); return }
    try {
      const recall = !retry && readRecallHistory(localStorage.getItem(PAUSED_RECALL_STORAGE))[line.id]
      if (recall && recall.signature === lineSignature(line) && recall.memory.phase === 'active' && recall.memory.from === from) { loadLine(line, recall.memory.index); setMemory(recall.memory); completedMemory.current = null; return }
      const paused = !retry && pausedPractice(readPracticeHistory(localStorage.getItem(PLAYLIST_PRACTICE_STORAGE)), line, from)
      if (paused) { loadLine(line, paused.index); completed.current = null; practicing.current = true; setPractice(paused.practice); return }
    } catch { setError('Saved practice progress could not be read. Existing attempts have been preserved.'); return }
    startPractice(line, false, from, line.moves.length, true)
  }
  function selectPlaylistLine(line: Variation, collection: Collection | null = activePlaylist, retry = false) {
    if (!line) return
    if (!retry && line.id === selectedId && (practice || memory?.phase === 'active') && collection?.id === activePlaylist?.id) return
    if (!suspendRecall()) return
    if (collection && !persistPlaylists(rememberPlaylist(playlists, { ...collection, selected: originalLineId(line.id), accessed: Date.now() }))) return
    enterPlaylistPractice(line, collection, retry)
  }
  function savePlaylist() {
    if (!activePlaylist) return
    const name = playlistName?.trim()
    if (name && persistPlaylists(rememberPlaylist(playlists, { ...activePlaylist, name, type: 'SAVED_CUSTOM', accessed: Date.now() }))) setPlaylistName(null)
  }
  function storedPlaylistSession(collection: Collection | null) {
    try { return collection ? matchingSession(collection, parseFamilies(localStorage.getItem(FAMILY_STORAGE))) : null }
    catch { return null }
  }
  function revealAnalysis(kind: 'engine' | 'explorer') {
    if (!memory || memory.phase !== 'active') return
    setMemory(old => old ? { ...old, reveals: old.reveals + 1 } : null)
    if (kind === 'engine') setAnalysisRevealed(memory.started); else setExplorerRevealed(memory.started)
  }
  const [moveExclusions, setMoveExclusions] = useState<MoveExclusions>(readExclusions)
  const [explorerAction, setExplorerAction] = useState<string | null>(null)
  useEffect(() => { void loadEngineCache() }, [])
  const [classic, setClassic] = useState(false)
  const [catalog, setCatalog] = useState<OpeningRecord[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [openingSelector, setOpeningSelector] = useState(false)
  const [openingChoice, setOpeningChoice] = useState<OpeningRecord | null>(null)
  const [openingFavorites, setOpeningFavorites] = useState<string[]>(() => { try { return readOpeningFavorites(localStorage.getItem(OPENING_FAVORITES)) } catch { return [] } })
  const [originName, setOriginName] = useState(defaultHistory.opening)
  const [side, setSide] = useState<Side>(() => { try { return localStorage.getItem(PLAYING_SIDE) === 'black' ? 'black' : 'white' } catch { return 'white' } })
  const [flipped, setFlipped] = useState(false)
  const [database, setDatabase] = useState<'lichess' | 'masters'>('lichess')
  const [cacheStats, setCacheStats] = useState<Awaited<ReturnType<typeof explorerCacheStats>> | null>(null)
  useEffect(() => { void explorerCacheStats().then(setCacheStats).catch(() => {}) }, [])
  const [explorerPerspective, setExplorerPerspective] = useState<ExplorerPerspective>(() => { try { return parseExplorerPerspective(localStorage.getItem(EXPLORER_PERSPECTIVE)) } catch { return 'both' } })
  const [explorerSort, setExplorerSort] = useState<ExplorerSort>('played')
  const [filters, setFilters] = useState<Filters>(defaults)
  const [initialPlies, setInitialPlies] = useState(40)
  const [maxPlies, setMaxPlies] = useState(80)
  const [generationSeconds, setGenerationSeconds] = useState(180)
  const [generationMode, setGenerationMode] = useState<GenerationMode>('advantage')
  const [exploration, setExploration] = useState(() => { try { return explorationSettings(JSON.parse(localStorage.getItem('atlas-exploration') || '{}')) } catch { return explorationSettings({}) } })
  useEffect(() => { try { localStorage.setItem('atlas-exploration', JSON.stringify(exploration)) } catch { /* Session setting remains available. */ } }, [exploration])
  const [castlingPreference, setCastlingPreference] = useState<CastlingPreference>(() => { try { return parseCastlingPreference(localStorage.getItem('atlas-castling-preference')) } catch { return 'none' } })
  const [castlingToleranceCp, setCastlingToleranceCp] = useState(() => { try { const saved = localStorage.getItem('atlas-castling-tolerance'); return castlingTolerance(saved === null ? undefined : Number(saved)) } catch { return 30 } })
  useEffect(() => { try { localStorage.setItem('atlas-castling-preference', castlingPreference); localStorage.setItem('atlas-castling-tolerance', String(castlingToleranceCp)) } catch { /* Session settings still apply. */ } }, [castlingPreference, castlingToleranceCp])
  const [generationStyle, setGenerationStyle] = useState<GenerationStyle>(() => { try { const value = localStorage.getItem('atlas-generation-style'); return value === 'aggressive' || value === 'solid' ? value : 'best' } catch { return 'best' } })
  const [variationCount, setVariationCount] = useState<1 | 3 | 5 | 10>(1)
  const [parallelWorkers, setParallelWorkers] = useState<'auto' | 1 | 2 | 4 | 6>('auto')
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null)
  const [recentBatchHistory, setRecentBatchHistory] = useState(recentBatches)
  const [generationToast, setGenerationToast] = useState<{ text: string; lineId?: string; results?: boolean } | null>(null)
  const [styleToleranceCp, setStyleToleranceCp] = useState(30)
  const [aggressive, setAggressive] = useState<AggressiveOptions>(() => { try { const saved = JSON.parse(localStorage.getItem('atlas-patricia-settings') || 'null'); return { engine: 'patricia', maxLossCp: Math.max(0, Math.min(50, Number(saved?.maxLossCp ?? 30))), relaxed: saved?.relaxed === true, equalCp: Math.max(0, Math.min(100, Number(saved?.equalCp ?? 50))), quietBelow: Math.max(0, Math.min(100, Number(saved?.quietBelow ?? 35))) } } catch { return { engine: 'patricia', maxLossCp: 30, relaxed: false } } })
  useEffect(() => { try { localStorage.setItem('atlas-patricia-settings', JSON.stringify(aggressive)) } catch { /* Session settings still apply. */ } }, [aggressive])
  useEffect(() => { try { localStorage.setItem('atlas-generation-style', generationStyle) } catch { /* Session setting still applies. */ } }, [generationStyle])
  const [advantageCp, setAdvantageCp] = useState(150)
  const [conversionMinPlies, setConversionMinPlies] = useState(4)
  const [conversionMaxDifficulty, setConversionMaxDifficulty] = useState(35)
  const [mastersFallback, setMastersFallback] = useState(true)
  const [targetRating, setTargetRating] = useState(1900)
  const [lastGeneration, setLastGeneration] = useState<Variation | null>(null)
  const [sharpnessPreference, setSharpnessPreference] = useState<'balanced' | 'critical'>('balanced')
  const [stabilityPreference, setStabilityPreference] = useState<'strict' | 'balanced'>('strict')
  const [opponentModel, setOpponentModel] = useState(() => { try { return opponentPreference(localStorage) } catch { return 'lichess-stockfish' as const } })
  const opponent = effectiveOpponent(opponentModel, generationMode)
  useEffect(() => { try { if (localStorage.getItem('atlas-opponent-model') === 'stockfish') localStorage.setItem('atlas-opponent-model', 'lichess-stockfish') } catch { /* Effective session preference still excludes Stockfish-only. */ } }, [])
  const [humanPolicy, setHumanPolicy] = useState<'simulation' | 'expansion'>(() => { try { return localStorage.getItem('atlas-human-policy') === 'simulation' ? 'simulation' : 'expansion' } catch { return 'expansion' } })
  const [samplingSeed, setSamplingSeed] = useState('')
  const [limitedHumanData, setLimitedHumanData] = useState<'stop' | 'sparse' | 'engine'>(() => { try { const saved = localStorage.getItem('atlas-limited-human-data'); return saved === 'sparse' || saved === 'engine' ? saved : 'stop' } catch { return 'stop' } })
  useEffect(() => { try { localStorage.setItem('atlas-limited-human-data', limitedHumanData) } catch { /* Session choice still applies. */ } }, [limitedHumanData])
  const [minPositionGames, setMinPositionGames] = useState(20)
  const [minMoveGames, setMinMoveGames] = useState(5)
  useEffect(() => { try { localStorage.setItem('atlas-human-policy', humanPolicy) } catch { /* Storage may be disabled. */ } }, [humanPolicy])
  const [useCloud, setUseCloud] = useState(false)
  const [engineDepth, setEngineDepth] = useState(initialDepths.interactive ?? 24)
  // Migrate the former routine defaults (20/24); deeper verification remains configurable.
  const [generationDepth, setGenerationDepth] = useState(initialDepths.generation && initialDepths.generation >= 16 && initialDepths.generation <= 18 ? initialDepths.generation : 16)
  const [verificationDepth, setVerificationDepth] = useState(initialDepths.verification && initialDepths.verification !== 24 ? initialDepths.verification : 20)
  const [analysisSeconds, setAnalysisSeconds] = useState(30)
  const [tolerance, setTolerance] = useState(35)
  const [manual, setManual] = useState<string[]>(() => positions({ startFen: defaultHistory.startFen, moves: defaultHistory.moves.map(uci => ({ uci, san: '', source: 'preset' })) }))
  const [manualMoves, setManualMoves] = useState<string[]>(defaultHistory.moves)
  const [manualParentId, setManualParentId] = useState<string | undefined>(defaultHistory.parentId)
  const [manualIndex, setManualIndex] = useState(defaultHistory.index)
  const [manualDirty, setManualDirty] = useState(false)
  const [lines, setLines] = useState<Variation[]>([])
  const [personalGame, setPersonalGame] = useState<PersonalGame|null>(null)
  const [personalRevision, setPersonalRevision] = useState(0)
  const [personalAnalysis, setPersonalAnalysis] = useState(false)
  const [personalBookmarkNote, setPersonalBookmarkNote] = useState('')
  const navigationVersion = useRef(0)
  const personalLoad = useRef(0)
  const [personalLoading, setPersonalLoading] = useState(initialUrl.searchParams.has('game'))
  const [saveGamePlaylist, setSaveGamePlaylist] = useState(false)
  const [gamePlaylistName, setGamePlaylistName] = useState('My difficult positions')
  function openPersonalGame(game:PersonalGame, ply=0) {
    if (!suspendRecall()) return
    navigationVersion.current++; stopGameAnalysis(); engineAbort.current?.abort(); sharpAbort.current?.abort()
    if(familyRecord) exitSession()
    setPersonalGame(game); setPersonalAnalysis(false); setPersonalBookmarkNote('')
    setSelectedId(`personal:${game.id}`); setIndex(ply); setAnalysisLineId(`personal:${game.id}`)
    setPractice(null);setMemory(null);practicing.current=false;setPlaying(false);setReviewIndex(null)
    setExploringLineId(null);setGraphPreview(null);setPlanPreview(null);setEnginePlanPreview(null);setPremove(null);setSquare(null);setError('')
  }
  async function bookmarkPersonalPosition() {
    if(!personalGame || !selectedId?.startsWith('personal:')) return
    const note=personalBookmarkNote.trim() || personalGame.bookmarks.find(b=>b.ply===boardIndex)?.note || ''
    try{const updated=await updatePersonalGame(personalGame.id,game=>({...game,bookmarks:[...game.bookmarks.filter(b=>b.ply!==boardIndex),{ply:boardIndex,fen:boardFen,note}]}));setPersonalGame(old=>old?.id===updated.id?updated:old);setPersonalRevision(v=>v+1);setNotice('Position bookmarked.')}catch(e){setError((e as Error).message)}
  }
  function addGameLineToPlaylist(id?:string) {
    if(!selected || !selected.sourceGame)return
    const existing=playlists.saved.find(p=>p.id===id), now=Date.now()
    const collection:Collection=existing?{...existing,ids:[...new Set([...existing.ids,selected.id])],selected:selected.id,accessed:now}:{id:crypto.randomUUID(),type:'SAVED_CUSTOM',name:gamePlaylistName.trim()||'My difficult positions',ids:[selected.id],selected:selected.id,accessed:now,family:'Personal games',side:selected.side,sessionKey:'personal-games',sessionStarted:now}
    if(persistPlaylists(rememberPlaylist(playlists,collection))){setSaveGamePlaylist(false);setSections(old=>({...old,playlist:true}));setNotice('Training line added to playlist.')}
  }
  const [savedReady, setSavedReady] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(initialLineId)
  const [analysisLineId, setAnalysisLineId] = useState<string | null>(initialUrl.searchParams.get('view') === 'analysis' ? initialLineId : null)
  const [index, setIndex] = useState(() => Math.max(0, Number(initialUrl.searchParams.get('ply') ?? (initialActive?.line.id === initialLineId ? initialActive.ply : 0)) || 0))
  const [lichessConnected, setLichessConnected] = useState(!!lichessToken())
  const [authRevision, setAuthRevision] = useState(0)
  const [data, setData] = useState<ExplorerData | null>(null)
  const [engine, setEngine] = useState<Evaluation[]>([])
  const [engineFen, setEngineFen] = useState('')
  const [generationAnalyses, setGenerationAnalyses] = useState<Record<string, Evaluation[]>>({})
  const [generationEvals, setGenerationEvals] = useState<Record<string, Evaluation>>({})
  const [showEngineArrows, setShowEngineArrows] = useState(false)
  const [loadingData, setLoadingData] = useState(false)
  const [loadingEngine, setLoadingEngine] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generationProgress, setGenerationProgress] = useState('')
  const [error, setError] = useState('')
  const [, setNotice] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loop, setLoop] = useState(false)
  const [practice, setPractice] = useState<Practice | null>(() => initialActive?.line.id === initialLineId && initialActive.practice?.lineId === initialLineId && initialActive.ply < (initialActive.practice.endIndex ?? initialActive.line.moves.length) ? initialActive.practice : null)
  const [memory, setMemory] = useState<MemorySession | null>(null)
  const [practiceAutoPlans, setPracticeAutoPlans] = useState(false)
  const [playlists, setPlaylists] = useState(() => { try { return parsePlaylists(localStorage.getItem(PLAYLIST_STORAGE)) } catch { return parsePlaylists(null) } })
  const [playlistName, setPlaylistName] = useState<string | null>(null)
  const [analysisRevealed, setAnalysisRevealed] = useState<number | null>(null)
  const [explorerRevealed, setExplorerRevealed] = useState<number | null>(null)
  const [familyRecord, setFamilyRecord] = useState<FamilyRecord | null>(() => { try { const key = localStorage.getItem(ACTIVE_PRACTICE); return key ? parseFamilies(localStorage.getItem(FAMILY_STORAGE))[key] || null : null } catch { return null } })
  const [memoryStats, setMemoryStats] = useState<Record<string, MemoryStats>>({})
  const [memoryReady, setMemoryReady] = useState(false)
  const [promotionChoice, setPromotionChoice] = useState<'q' | 'r' | 'b' | 'n'>('q')
  const [sharpness, setSharpness] = useState<SharpnessResult | null>(null)
  const [sharpFen, setSharpFen] = useState('')
  const [sharpProgress, setSharpProgress] = useState('')
  const [sharpRunning, setSharpRunning] = useState(false)
  const [fastSharpness, setFastSharpness] = useState<SharpnessResult | null>(null)
  const [fastFen, setFastFen] = useState('')
  const [fastRunning, setFastRunning] = useState(false)
  const [gameRunning, setGameRunning] = useState(false)
  const [gameProgress, setGameProgress] = useState('')
  const [gameBudget, setGameBudget] = useState(2500)
  const [sharpDepth, setSharpDepth] = useState(16)
  const [sharpBudget, setSharpBudget] = useState(45)
  const [sharpCandidates, setSharpCandidates] = useState(12)
  const [sharpBranches, setSharpBranches] = useState(2)
  const [sharpExcellent, setSharpExcellent] = useState(30)
  const [sharpPlayable, setSharpPlayable] = useState(70)
  const [sharpSerious, setSharpSerious] = useState(150)
  const [sections, setSections] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ANALYSIS_SECTIONS) || '{}')
      return Object.fromEntries(Object.entries(defaultSections).map(([key, value]) => [key, typeof saved[key] === 'boolean' ? saved[key] : value])) as typeof defaultSections
    } catch { return defaultSections }
  })
  function toggleSection(name: AnalysisSection) {
    setSections(old => ({ ...old, [name]: !old[name] }))
  }
  const [advancedPlannerOpen, setAdvancedPlannerOpen] = useState(false)
  function togglePracticeAutoPlans() {
    setPlanPreview(null)
    setPracticeAutoPlans(on => !on)
    setAdvancedPlannerOpen(true)
  }
  useEffect(() => {
    try { localStorage.setItem(ANALYSIS_SECTIONS, JSON.stringify(sections)) } catch { /* Collapse state remains usable for this visit. */ }
  }, [sections])
  const [planPreview, setPlanPreview] = useState<PlanPreview | null>(null)
  const [enginePlanPreview, setEnginePlanPreview] = useState<PlanPreview | null>(null)
  const [graphPreview, setGraphPreview] = useState<number | null>(null)
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)
  const [premove, setPremove] = useState<Premove | null>(null)
  const [square, setSquare] = useState<Square | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'newest' | 'name' | 'practiced'>('newest')
  const [statusFilter, setStatusFilter] = useState<'all' | 'unpracticed' | 'practiced'>('all')
  const [openingFilter, setOpeningFilter] = useState('all')
  const [fenInput, setFenInput] = useState('')
  const engineMenu = useRef<HTMLDetailsElement>(null)
  const lineMenu = useRef<HTMLDetailsElement>(null)
  const [pgnInput, setPgnInput] = useState('')
  const abort = useRef<AbortController | null>(null)
  const engineAbort = useRef<AbortController | null>(null)
  const sharpAbort = useRef<AbortController | null>(null)
  const gameWorker = useRef<Worker | null>(null)
  const gameSearch = useRef<AbortController | null>(null)
  const gameBatch = useRef<{ lineId: string; points: Map<number, AnalysisPoint>; done: number; total: number } | null>(null)
  const gameFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gameLastFlush = useRef(0)
  const memoryGradeAbort = useRef<AbortController | null>(null)
  const completedMemory = useRef<number | null>(null)
  const recoveredFamily = useRef(false)
  const practiceQueue = useRef<string[]>([])
  const completed = useRef<string | null>(null)
  const generatingLineId = useRef<string | null>(null)
  const practicing = useRef(!!practice)
  const [exploringLineId, setExploringLineId] = useState<string | null>(null)
  const [perspectiveAnalysis, setPerspectiveAnalysis] = useState<Record<string, NonNullable<Variation['analysis']>>>({})
  const perspective = linePerspective(selectedId || '')
  const personalSelected = !!personalGame && selectedId === `personal:${personalGame.id}`
  const personalView = useMemo(() => personalGame ? gameView(personalGame, side) : null, [personalGame, side])
  const originalSelected = personalSelected ? personalView : lines.find(line => line.id === originalLineId(selectedId || '')) || null
  const selected = useMemo(() => { if (!originalSelected) return null; const view = transformLine(originalSelected, perspective); return perspective !== 'normal' && perspectiveAnalysis[view.id] ? { ...view, analysis: perspectiveAnalysis[view.id] } : view }, [originalSelected, perspective, perspectiveAnalysis])
  function changePerspective(mode: Perspective) {
    if (!originalSelected || generating) return
    try {
      const next = transformLine(originalSelected, mode)
      if (!suspendRecall()) return
      if (familyRecord) exitSession()
      stopGameAnalysis(); memoryGradeAbort.current?.abort()
      setPractice(null); setMemory(null); practicing.current = false; setPlaying(false)
      setReviewIndex(null); setGraphPreview(null); setPlanPreview(null); setEnginePlanPreview(null)
      setExploringLineId(null); setPremove(null); setSquare(null)
      setSelectedId(next.id); setAnalysisLineId(null); setSide(next.side); setFlipped(false); setError('')
    } catch (error) { setError((error as Error).message) }
  }
  function trainingLine(line: Variation): Variation {
    return linePerspective(line.id) === 'normal' && perspective !== 'normal' ? transformLine(line, perspective) : line
  }
  const activePlaylist = [...playlists.recent, ...playlists.saved, ...(playlists.review ? [playlists.review] : [])].find(p => p.id === playlists.active) || null
  const playlistLines = activePlaylist ? playlistEntries(activePlaylist, lines) : []
  const queueLabels = useMemo(() => playlistLabels(playlistLines), [activePlaylist, lines])
  const previousPlaylistId = queueNeighbor(playlistLines.map(l=>l.id), originalLineId(selectedId || ''), -1)
  const nextPlaylistId = queueNeighbor(playlistLines.map(l=>l.id), originalLineId(selectedId || ''), 1, activePlaylist?.branch?.options.coverage === 'continuous' || loop)
  const playlistComplete = !!selected && (!!memory && memory.phase === 'complete' && !familyRecord?.session.stopped || !memory && index >= selected.moves.length && completed.current === selected.id)
  const analysisHidden = recallConcealed(memory, analysisRevealed)
  const explorerHidden = recallConcealed(memory, explorerRevealed)
  const playlistRecord = useMemo(() => familyRecord || storedPlaylistSession(activePlaylist), [familyRecord, activePlaylist])

  const familyProgress = useMemo(() => playlistRecord ? practicePlaylist(playlistRecord, memoryStats) : null, [playlistRecord, memoryStats])
  const exploring = !!selected && exploringLineId === selected.id
  const followingLine = selected && !exploring ? selected : null
  const analysisMode = !!selected && analysisLineId === selected.id
  useEffect(() => { setShowEngineArrows(analysisMode) }, [analysisMode])
  const positionIndex = followingLine && (practice || memory) && reviewIndex !== null ? reviewIndex : followingLine ? index : manualIndex
  const fen = followingLine ? lineFen(followingLine, positionIndex) : manual[manualIndex]
  const boardIndex = graphPreview ?? positionIndex
  const boardFen = followingLine && graphPreview !== null ? lineFen(followingLine, graphPreview) : fen
  const plannerEnabled = (!personalSelected || personalAnalysis) && shouldRunPlanner(advancedPlannerOpen, generating, !!practice || memory?.phase === 'active', practiceAutoPlans)
  const candidatePreview = plannerEnabled && planPreview?.fen === fen ? planPreview : enginePlanPreview
  const preview = !analysisHidden && graphPreview === null && candidatePreview?.fen === fen ? candidatePreview : null
  const material = useMemo(() => materialBalance(preview?.full ? preview.future : preview?.baseline || boardFen), [boardFen, preview?.full, preview?.future, preview?.baseline])
  const exactOpening = useMemo(() => catalog.length ? openingAt(catalog, fen, openingChoice) : undefined, [catalog, fen, openingChoice])
  const practiceFen = selected ? lineFen(selected, index) : fen
  const board = new Chess(fen)
  const streamedEngine = generationAnalyses[fen] || (generationEvals[fen] ? [generationEvals[fen]] : [])
  const localEngine = engineFen === fen ? engine : []
  const displayedEngine = analysisHidden ? [] : streamedEngine[0] && (!localEngine[0] || streamedEngine[0].depth >= localEngine[0].depth) ? streamedEngine : localEngine
  const shownDeepSharpness = sharpFen === fen && !!sharpness
  const shownSharpness = shownDeepSharpness ? sharpness : fastFen === fen ? fastSharpness : null
  const memoryExpected = memory?.phase === 'active' ? selected?.moves[memory.index] : undefined
  const engineArrows = analysisHidden && memory ? reviewIndex === null && memory.hint && memoryExpected ? [{ startSquare: memoryExpected.uci.slice(0, 2), endSquare: memoryExpected.uci.slice(2, 4), color: '#e19134cc' }] : [] : showEngineArrows ? displayedEngine.slice(0, 3).filter(entry => entry.line[0]?.length >= 4).map((entry, index) => ({ startSquare: entry.line[0].slice(0, 2), endSquare: entry.line[0].slice(2, 4), color: ['#4a9634bb', '#327ca8aa', '#ad8748aa'][index] })) : []
  const orientation = flipped ? (side === 'white' ? 'black' : 'white') : side
  const barEvaluation = analysisHidden ? undefined : positionEvaluation(boardFen, boardIndex, followingLine?.moves[boardIndex], followingLine?.analysis?.points[boardIndex], engineFen === boardFen ? engine[0] : undefined, generationEvals[boardFen], cachedAnalysis(boardFen, 1, 8)?.[0]) || (followingLine && (generating || playing) ? recentLineEvaluation(followingLine, boardIndex) : undefined)
  const atEnd = !!selected && index >= selected.moves.length
  const myTurn = !!selected && practiceFen.split(' ')[1] === (selected.side === 'white' ? 'w' : 'b')
  const instructionIndex = memory?.index ?? (practice && reviewIndex === null ? index + Number(!myTurn) : positionIndex)
  const nextInstruction = selected && !exploring && instructionIndex < (memory?.to ?? practice?.endIndex ?? selected.moves.length) ? describeLineMove(lineFen(selected, instructionIndex), selected.moves[instructionIndex], selected.side) : null
  const explorerMoves = data ? sortExplorerMoves(data.moves, explorerSort) : []
  const currentExclusions = moveExclusions[exclusionKey(fen, side)] || []
  const saveExclusions = (value: MoveExclusions) => { try { localStorage.setItem(EXCLUSIONS_STORAGE, JSON.stringify(value)); setMoveExclusions(value) } catch { setError('Move exclusions could not be saved.') } }
  const toggleExplorerExclusion = (uci: string) => {
    const next = { ...moveExclusions }, updated = currentExclusions.includes(uci) ? currentExclusions.filter(move => move !== uci) : [...currentExclusions, uci]
    if (updated.length) next[exclusionKey(fen, side)] = updated
    else delete next[exclusionKey(fen, side)]
    saveExclusions(next); setExplorerAction(null)
  }
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!(event.target as Element).closest('.explorer-row-action')) setExplorerAction(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExplorerAction(null) }
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [])
  useEffect(() => { setExplorerAction(null) }, [personalSelected, personalAnalysis, fen, side])

  useEffect(() => { finishLichessLogin().then(connected => { if (connected) { setLichessConnected(true); setAuthRevision(value => value + 1) } }).catch(error => setError(error.message)) }, [])
  useEffect(() => {
    const syncLichess = (event: StorageEvent) => {
      if (event.key === EXCLUSIONS_STORAGE || event.key === null) setMoveExclusions(readExclusions())
      if (event.key !== 'opening-atlas-lichess-token' && event.key !== null) return
      setLichessConnected(!!lichessToken()); setAuthRevision(value => value + 1)
    }
    window.addEventListener('storage', syncLichess)
    return () => window.removeEventListener('storage', syncLichess)
  }, [])
  useEffect(() => { practicing.current = !!practice }, [practice])
  useEffect(() => { try { localStorage.setItem(PLAYING_SIDE, side) } catch { /* The selector still works without storage. */ } }, [side])
  useEffect(() => { try { localStorage.setItem(OPENING_FAVORITES, JSON.stringify(openingFavorites)) } catch { /* Favorites remain usable for this session. */ } }, [openingFavorites])
  useEffect(() => { try { localStorage.setItem(EXPLORER_PERSPECTIVE, explorerPerspective) } catch { /* The explorer still works without persistent browser storage. */ } }, [explorerPerspective])
  useEffect(() => { try { localStorage.setItem(ENGINE_SETTINGS, JSON.stringify({ interactive: engineDepth, generation: generationDepth, verification: verificationDepth, grading: gradingDepth })) } catch { /* Session settings still work. */ } }, [engineDepth, generationDepth, verificationDepth])

  useEffect(() => {
    loadOpenings().then(setCatalog).catch(error => setCatalogError((error as Error).message))
  }, [])
  useEffect(() => {
    readVariations().then(async saved => {
      // ponytail: one synchronous snapshot protects the active line from a refresh before IndexedDB commits.
      const active = activeLine()
      const snapshot = active?.line.id === initialLineId ? restoreTrainingSide(active.line) : null
      const original = restoreActiveLine((saved || []).map(restoreTrainingSide), snapshot, initialLineId)
      // Recover a final result if an earlier reload saved only its progress snapshot.
      if (!pendingGeneration() && !pendingBatch()) for (const line of original) {
        if (!/^(Generating|Converting advantage)\.\.\.$/.test(line.termination || '')) continue
        const job = recentBatches().find(batch => batch.total === 1 && batch.status === 'complete' && batch.jobs.some(job => job.lineId === line.id))
        if (!job) continue
        try {
          const response = await fetch(`/api/generation/${job.id}`, { signal: AbortSignal.timeout(3000) })
          if (!response.ok) continue
          const result = await response.json()
          if (result.status === 'complete' && result.line?.id === line.id && result.line.moves.length >= line.moves.length) {
            original[original.indexOf(line)] = { ...line, ...result.line, name: line.name, customName: line.customName, branch: line.branch, openingId: line.openingId, parentId: line.parentId, stats: line.stats, lastPracticed: line.lastPracticed }
          }
        } catch { /* The saved partial remains available if the server has restarted. */ }
      }
      const migrated = migrateVariations(original)
      const before = original.find(line => line.id === initialLineId), after = migrated.find(line => line.id === initialLineId)
      if (before && after && after.moves.length > before.moves.length) {
        const offset = after.moves.length - before.moves.length
        setIndex(value => value + offset)
        setPractice(value => value ? { ...value, endIndex: value.endIndex === undefined ? undefined : value.endIndex + offset, retryIndex: value.retryIndex === undefined ? undefined : value.retryIndex + offset } : value)
      }
      if (migrated.some((line, i) => line !== original[i]) && !(await read<Variation[]>('generated-lines-before-tree-v1'))) await write('generated-lines-before-tree-v1', original)
      setLines(migrated)
      setSavedReady(true)
    }).catch(() => { const snapshot = initialActive?.line.id === initialLineId ? restoreTrainingSide(initialActive.line) : null; if (snapshot) setLines([snapshot]); setError('Saved variations could not be loaded.') })
  }, [])
  const recoveryStarted = useRef(false)
  useEffect(() => {
    if (!savedReady || recoveryStarted.current) return
    recoveryStarted.current = true
    const batch = pendingBatch(), pending = pendingGeneration()
    if (batch) void runBatch(batch.options, batch)
    else if (pending) void generate(pending)
  }, [savedReady])
  useEffect(() => {
    if (activePlaylist && selectedId && activePlaylist.ids.includes(selectedId) && activePlaylist.selected !== selectedId)
      persistPlaylists(rememberPlaylist(playlists, { ...activePlaylist, selected: selectedId, accessed: Date.now() }))
  }, [selectedId])
  useEffect(() => {
    const id=initialUrl.searchParams.get('game')
    if(!id)return
    const request=++personalLoad.current, version=navigationVersion.current
    getPersonalGame(id).then(game=>{if(game&&request===personalLoad.current&&navigationVersion.current===version)openPersonalGame(game,Math.max(0,Math.min(game.plies,Number(initialUrl.searchParams.get('ply'))||0)))}).catch(e=>setError(e.message)).finally(()=>setPersonalLoading(false))
  }, [])
  useEffect(() => { if (savedReady) writeVariations(lines).catch(() => setError('Variations could not be saved.')) }, [savedReady, lines])
  useEffect(() => { if (!generationToast) return; const timer = setTimeout(() => setGenerationToast(null), 6500); return () => clearTimeout(timer) }, [generationToast])
  useEffect(() => { read<Record<string, MemoryStats>>(MEMORY_STORAGE).then(saved => setMemoryStats(saved || {})).catch(() => setError('Memorization progress could not be loaded.')).finally(() => setMemoryReady(true)) }, [])
  useEffect(() => {
    if (recoveredFamily.current || !familyRecord || !savedReady || !memoryReady || !familyRecord.session.memory) return
    const current = familyRecord.session.memory, line = lines.find(line => line.id === current.lineId && lineSignature(line) === familyRecord.session.signatures[line.id])
    if (line && !familyRecord.session.finished) activateSession(familyRecord, false)
  }, [familyRecord, lines, savedReady, memoryReady])
  useEffect(() => { if (memoryReady) write(MEMORY_STORAGE, memoryStats).catch(() => setError('Memorization progress could not be saved.')) }, [memoryReady, memoryStats])
  useEffect(() => {
    if (!savedReady) return
    if (selectedId && !selected) { setError('This saved line is unavailable in this browser. Open it where it was saved.'); return }
    if (selected && index > selected.moves.length) { setIndex(selected.moves.length); return }
    try {
      if (personalSelected) { localStorage.removeItem(ACTIVE_LINE) }
      else if (selected) localStorage.setItem(ACTIVE_LINE, JSON.stringify({ line: originalSelected, ply: index, practice: perspective === 'normal' && practice?.lineId === selected.id ? practice : null }))
      else {
        localStorage.removeItem(ACTIVE_LINE)
        localStorage.setItem(MANUAL_HISTORY, JSON.stringify({ startFen: manual[0], moves: manualMoves, index: manualIndex, opening: originName || openingChoice?.name || '', parentId: manualParentId }))
      }
    } catch { /* IndexedDB remains the main saved-line store. */ }
    const url = new URL(window.location.href)
    url.searchParams.delete('game'); url.searchParams.delete('analysis'); url.searchParams.delete('line'); url.searchParams.delete('ply'); url.searchParams.delete('fen'); url.searchParams.delete('view')
    if (personalSelected && personalGame) { url.searchParams.set('game', personalGame.id); url.searchParams.set('ply',String(index)) }
    else if (selectedId) { url.searchParams.set('line', originalLineId(selectedId)); if (index) url.searchParams.set('ply', String(index)) }
    else if (manual[manualIndex] !== startFen) url.searchParams.set('fen', manual[manualIndex])
    if (analysisMode) url.searchParams.set('view', 'analysis')
    window.history.replaceState(null, '', url)
  }, [savedReady, selectedId, selected, index, practice, manual, manualIndex, manualMoves, originName, openingChoice, manualParentId, analysisMode])
  useEffect(() => {
    if (!selected) return
    if (!personalSelected && !selected.sideUnconfirmed) { setSide(selected.side); setFlipped(repertoireOrientation.current ? repertoireOrientation.current !== selected.side : false); repertoireOrientation.current = null }
    setDatabase(selected.database)
    setFilters(selected.filters)
    if (selected.generationMode) {
      const mode = availableGenerationMode(selected.generationMode)
      setGenerationMode(mode)
      setMaxPlies(mode === 'complete' ? 180 : 80)
    }
    if (selected.advantageCp) setAdvantageCp(selected.advantageCp)

  }, [selected?.id])
  useEffect(() => {
    if (repertoirePage || !useCloud || analysisHidden || generating || playing || (personalLoading || personalSelected && !personalAnalysis)) return
    const controller = new AbortController()
    const timer = setTimeout(() => { void cloudEvaluation(fen, controller.signal).then(lines => {
      if (lines && !controller.signal.aborted) { setEngine(old => old.length && old[0].depth >= lines[0].depth ? old : lines); setEngineFen(fen) }
    }) }, 700)
    return () => { clearTimeout(timer); controller.abort() }
  }, [personalLoading, personalSelected, personalAnalysis, fen, useCloud, analysisHidden, generating, playing, repertoirePage])
  useEffect(() => {
    if (repertoirePage || explorerHidden) { setData(null); setLoadingData(false); return }
    const controller = new AbortController()
    setLoadingData(true); setData(null)
    explorer(fen, filters, controller.signal, database).then(result => { if (!controller.signal.aborted) setData(result) }).catch(e => { if (e.name !== 'AbortError') setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoadingData(false) })
    const refreshed = (event: Event) => { if (!controller.signal.aborted && (event as CustomEvent<string>).detail === explorerCacheKey(fen, filters, database)) void explorer(fen, filters, controller.signal, database).then(setData).catch(() => {}) }
    window.addEventListener('explorer-refreshed', refreshed)
    return () => { controller.abort(); window.removeEventListener('explorer-refreshed', refreshed) }
  }, [personalSelected, personalAnalysis, fen, filters, database, explorerHidden, authRevision, generating, repertoirePage])
  useEffect(() => {
    if (repertoirePage || analysisHidden) { setEngine([]); setEngineFen(''); setLoadingEngine(false); setFastSharpness(null); setFastFen(''); setFastRunning(false); return }
    if (personalLoading || personalSelected && !personalAnalysis) { setEngine([]);setEngineFen('');setLoadingEngine(false);setFastSharpness(null);setFastFen('');setFastRunning(false);return }
    const position = new Chess(fen)
    if (position.isCheckmate() || position.isStalemate()) {
      setEngine([]); setEngineFen(fen); setLoadingEngine(false); setFastSharpness(null); setFastFen(''); setFastRunning(false)
      setError(old => old === 'Invalid engine output: no coherent complete MultiPV analysis' ? '' : old)
      return
    }
    const controller = new AbortController()
    engineAbort.current = controller
    const immediate = cachedAnalysis(fen, 4, 8) || cachedAnalysis(fen, 1, 8) || []
    setLoadingEngine(true); setEngine(immediate); setEngineFen(immediate.length ? fen : ''); setFastSharpness(null); setFastFen(''); setFastRunning(true)
    if (playing) {
      setFastRunning(false)
      const timer = setTimeout(async () => {
        try {
          const lines = cachedAnalysis(fen, 1, 8) || await analyze(fen, 1, 8, controller.signal, 1000)
          if (!controller.signal.aborted) { setEngine(old => old[0]?.source !== 'cloud' && old[0]?.depth > lines[0]?.depth ? old : lines); setEngineFen(fen) }
        } catch { /* Saved line scores can still drive the bar during fast playback. */ }
        finally { if (!controller.signal.aborted) setLoadingEngine(false) }
      }, 0)
      return () => { clearTimeout(timer); controller.abort() }
    }
    const timer = setTimeout(async () => {
      await loadEngineCache()
      const restored = cachedAnalysis(fen, 4, 8) || cachedAnalysis(fen, 1, 8)
      if (restored && !controller.signal.aborted) { setEngine(restored); setEngineFen(fen) }
      const updateFast = (result: SharpnessResult) => { if (!controller.signal.aborted) { setFastSharpness(result); setFastFen(fen) } }
      let fastSucceeded = false
      try {
        const result = await analyzeFastSharpness(fen, { analyze, cached: cachedAnalysis }, controller.signal, lines => {
          if (!controller.signal.aborted) { setEngine(old => old[0]?.source !== 'cloud' && old[0]?.depth > lines[0]?.depth ? old : lines); setEngineFen(fen) }
        }, updateFast)
        updateFast(result); fastSucceeded = true
      } catch { /* The regular Stockfish analysis can still run. */ }
      finally { if (!controller.signal.aborted) setFastRunning(false) }
      if (controller.signal.aborted) return
      try {
        const target = engineDepth
        const publish = (lines: Evaluation[]) => { if (!controller.signal.aborted) { setEngine(old => old[0]?.depth > lines[0]?.depth ? old : lines); setEngineFen(fen) } }
        const lines = cachedAnalysis(fen, 4, target) || await analyze(fen, 4, target, controller.signal, analysisSeconds * 1000, false, undefined, { priority: 'visible', onDepth: publish })
        if (!controller.signal.aborted) { setEngine(old => old[0]?.source !== 'cloud' && old[0]?.depth > lines[0]?.depth ? old : lines); setEngineFen(fen) }
        if (!fastSucceeded && !controller.signal.aborted) updateFast(await analyzeFastSharpness(fen, { analyze, cached: cachedAnalysis }, controller.signal))
      } catch (error) { if (!controller.signal.aborted && (error as Error).name !== 'AbortError') setError((error as Error).message) }
      finally { if (!controller.signal.aborted) setLoadingEngine(false) }
    }, 160)
    return () => { clearTimeout(timer); controller.abort() }
  }, [personalLoading, personalSelected, personalAnalysis, fen, engineDepth, analysisSeconds, analysisHidden, generating, playing, repertoirePage])
  useEffect(() => { sharpAbort.current?.abort(); setSharpRunning(false); setSharpness(null); setSharpFen(''); setSharpProgress('') }, [personalSelected, personalAnalysis, fen, sharpDepth, sharpBudget, sharpCandidates, sharpBranches, sharpExcellent, sharpPlayable, sharpSerious, !!memory])
  useEffect(() => () => { stopGameAnalysis() }, [selectedId])
  useEffect(() => { if (!personalSelected && !repertoirePage && analysisMode && selected && !gameWorker.current) analyzeSelectedGame('fast') }, [analysisLineId, selected?.id, repertoirePage])
  useEffect(() => {
    if (repertoirePage || !playing || !selected || practice || memory) return
    const timer = setTimeout(() => {
      if (index < selected.moves.length) setIndex(index + 1)
      else if (loop) setIndex(0)
      else setPlaying(false)
    }, 1100 / speed)
    return () => clearTimeout(timer)
  }, [playing, selectedId, index, speed, loop, practice, !!memory, repertoirePage])
  useEffect(() => {
    if (memory && !familyRecord && selected && memory.lineId === selected.id) persistRecall(selected, memory)
  }, [memory, familyRecord, selectedId])
  useEffect(() => {
    if (practice && selected && practice.lineId === selected.id) persistPractice(selected, practice, index)
  }, [practice, selectedId, index])
  useEffect(() => {
    if (repertoirePage || !practice || !selected || practice.lineId !== selected.id || !savedReady || (pendingGeneration() && !abort.current)) return
    if (atEnd || index >= (practice.endIndex ?? selected.moves.length)) {
      if (waitingForGeneratedMove(index, selected.moves.length, generating && generatingLineId.current === selected.id, !!practice.followGeneration)) {
        setPractice(old => old && old.message !== 'Caught up. Waiting for the next generated move.' ? { ...old, message: 'Caught up. Waiting for the next generated move.' } : old)
        return
      }
      if (completed.current === practice.lineId) return
      completed.current = practice.lineId
      const elapsed = Date.now() - practice.started
      setLines(old => old.map(line => line.id === selected.id ? { ...line, lastPracticed: Date.now(), stats: { firstTry: line.stats.firstTry + practice.firstTry, errors: line.stats.errors + practice.errors, reveals: line.stats.reveals + practice.reveals, completions: line.stats.completions + 1, totalMs: line.stats.totalMs + elapsed } } : line))
      setNotice(`Line complete in ${Math.round(elapsed / 1000)} seconds. Watch it again or repeat practice.`)
      practicing.current = false; setPractice(null)
      const nextId = practiceQueue.current.shift()
      if (nextId) { const nextLine = lines.find(line => line.id === nextId); if (nextLine) setTimeout(() => startPractice(nextLine, true), 900) }
      return
    }
    if (practice.followGeneration && practice.message === 'Caught up. Waiting for the next generated move.') setPractice(old => old ? { ...old, message: 'Next move ready.' } : null)
    if (reviewIndex !== null || practiceFen.split(' ')[1] === (selected.side === 'white' ? 'w' : 'b')) return
    const timer = setTimeout(() => setIndex(value => value + 1), 600 / speed)
    return () => clearTimeout(timer)
  }, [practice, selectedId, selected?.moves.length, index, practiceFen, reviewIndex, atEnd, speed, generating, repertoirePage])
  useEffect(() => {
    if (repertoirePage || !memory || !selected || memory.lineId !== selected.id || memory.phase !== 'active') return
    if (familyRecord) {
      if (familyRecord.session.stopped) return
      if (memory.index >= memory.to) {
        const finished = finishFamilyAttempt(familyRecord, memory)
        if (finished !== familyRecord && saveSession(finished)) {
          setMemory(finished.session.memory)
          setMemoryStats(old => ({ ...old, [memory.lineId]: memory.index >= memory.to ? finishMemory(old[memory.lineId] || emptyMemoryStats(), memory) : { ...(old[memory.lineId] || emptyMemoryStats()), wrong: (old[memory.lineId]?.wrong || 0) + memory.wrong, reveals: (old[memory.lineId]?.reveals || 0) + memory.reveals, lastPracticed: Date.now() } }))
        }
        return
      }
      if (familyRecord.session.memory !== memory) saveSession({ ...familyRecord, session: { ...familyRecord.session, memory } })
      if (reviewIndex !== null || lineFen(selected, memory.index).split(' ')[1] === (selected.side === 'white' ? 'w' : 'b')) return
      const timer = setTimeout(() => { setMemory(old => old ? opponentReply(old) : null); setIndex(memory.index + 1) }, 450)
      return () => clearTimeout(timer)
    }
    if (memory.index >= memory.to) {
      if (completedMemory.current === memory.started) return
      completedMemory.current = memory.started
      setMemoryStats(old => ({ ...old, [memory.lineId]: finishMemory(old[memory.lineId] || emptyMemoryStats(), memory) }))
      const goal = memoryStats[memory.lineId]?.target || 5
      const achieved = memory.fullLine && !memory.wrong && !memory.reveals && (memoryStats[memory.lineId]?.perfect || 0) + 1 >= goal
      setMemory(old => old ? { ...old, phase: 'complete', message: achieved ? 'Memorization goal achieved.' : old.fullLine ? old.wrong || old.reveals ? 'Line complete. Repeat to build a perfect recall streak.' : 'Perfect recall. Ready to repeat?' : 'Segment complete. Repeat it or restart the full line to build your streak.' } : null)
      return
    }
    if (reviewIndex !== null) return
    const myColor = selected.side === 'white' ? 'w' : 'b'
    if (lineFen(selected, memory.index).split(' ')[1] === myColor) return
    const timer = setTimeout(() => { setMemory(old => old ? opponentReply(old) : null); setIndex(memory.index + 1) }, 550)
    return () => clearTimeout(timer)
  }, [memory, selectedId, reviewIndex, repertoirePage, familyRecord])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (repertoirePage || event.defaultPrevented) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
      if (event.key === 'ArrowLeft') { event.preventDefault(); previous() }
      if (event.key === 'ArrowRight') { event.preventDefault(); next() }
      if (event.key === 'Home') { event.preventDefault(); jump(0) }
      if (event.key === 'End') { event.preventDefault(); jump(followingLine ? followingLine.moves.length : manualMoves.length) }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  })
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => { for (const ref of [engineMenu, lineMenu]) if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false }
    const closeEscape = (event: KeyboardEvent) => { for (const ref of [engineMenu, lineMenu]) if (event.key === 'Escape' && ref.current?.open) { ref.current.open = false; ref.current.querySelector('summary')?.focus() } }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [])

  function jump(to: number) { navigationVersion.current++; setPremove(null); setGraphPreview(null); setSquare(null); setPlaying(false); if (selected && memory) { const target = memoryReviewPosition(memory, to); setReviewIndex(target === memory.index ? null : target) } else if (selected && practice) { const target = reviewPosition(to, index); setReviewIndex(target === index ? null : target) } else if (followingLine) setIndex(Math.max(0, Math.min(followingLine.moves.length, to))); else setManualIndex(Math.max(0, Math.min(manual.length - 1, to))) }
  function flushGameAnalysis() {
    if (gameFlushTimer.current) { clearTimeout(gameFlushTimer.current); gameFlushTimer.current = null }
    const batch = gameBatch.current
    if (!batch) return
    gameBatch.current = null
    gameLastFlush.current = Date.now()
    setGameProgress(`Analyzing ${batch.done} / ${batch.total} positions`)
    if (!batch.points.size) return
    if (batch.lineId.startsWith('personal:')) {
      const id=batch.lineId.slice(9), additions=[...batch.points.values()]
      updatePersonalGame(id,game=>{const points=[...(game.analysis?.points||[])];for(const point of additions)points[point.index]=point;return {...game,analysis:{version:1,points},analyzed:true}}).then(updated=>{setPersonalGame(old=>old?.id===id?updated:old);setPersonalRevision(v=>v+1)}).catch(e=>setError(e.message))
      return
    }
    if (linePerspective(batch.lineId) !== 'normal') {
      setPerspectiveAnalysis(old => { const points = [...(old[batch.lineId]?.points || [])]; for (const point of batch.points.values()) points[point.index] = point; return { ...old, [batch.lineId]: { version: 1, points } } })
      return
    }
    setLines(old => old.map(item => {
      if (item.id !== batch.lineId) return item
      const fens = positions(item), points = [...(item.analysis?.version === 1 ? item.analysis.points : [])]
      for (const point of batch.points.values()) if (fens[point.index] === point.fen) points[point.index] = point
      return { ...item, analysis: { version: 1 as const, points } }
    }))
  }
  function stopGameAnalysis() {
    gameWorker.current?.terminate(); gameWorker.current = null
    gameSearch.current?.abort(); gameSearch.current = null
    flushGameAnalysis(); setGameRunning(false)
  }
  function analyzeSelectedGame(level: 'fast' | 'deep') {
    if (!selected || gameWorker.current) return
    const line = selected
    let worker: Worker
    try { worker = new Worker(new URL('./gameAnalysis.worker.ts', import.meta.url), { type: 'module' }) }
    catch (error) { setError(`Game analysis could not start: ${(error as Error).message}`); return }
    gameWorker.current = worker
    gameLastFlush.current = Date.now()
    setGameRunning(true); setGameProgress(`Analyzing 0 / ${line.moves.length + 1} positions`)
    worker.onmessage = async (event: MessageEvent<{ type: string; id?: number; fen?: string; count?: number; depth?: number; timeoutMs?: number; point?: AnalysisPoint; done?: number; total?: number; message?: string }>) => {
      if (gameWorker.current !== worker) return
      const message = event.data
      if (message.type === 'engine') {
        const controller = new AbortController(); gameSearch.current = controller
        try {
          const lines = cachedAnalysis(message.fen!, message.count!, message.depth!) || await analyze(message.fen!, message.count!, message.depth!, controller.signal, message.timeoutMs!, false, undefined, { priority: 'background' })
          if (gameWorker.current === worker) worker.postMessage({ type: 'engine-result', id: message.id, lines })
        } catch (error) { if (gameWorker.current === worker) worker.postMessage({ type: 'engine-result', id: message.id, error: (error as Error).message }) }
        finally { if (gameSearch.current === controller) gameSearch.current = null }
      } else if (message.type === 'point' && message.point) {
        const batch = gameBatch.current ||= { lineId: line.id, points: new Map(), done: 0, total: 0 }
        batch.points.set(message.point.index, message.point); batch.done = message.done!; batch.total = message.total!
        if (batch.points.size >= 8 && Date.now() - gameLastFlush.current >= 1000) flushGameAnalysis()
        else gameFlushTimer.current ||= setTimeout(flushGameAnalysis, 10000)
      } else if (message.type === 'complete') stopGameAnalysis()
      else if (message.type === 'error') { stopGameAnalysis(); setError(message.message || 'Game analysis failed.') }
    }
    worker.onerror = event => { if (gameWorker.current === worker) { stopGameAnalysis(); setError(`Game analysis worker failed: ${event.message}`) } }
    worker.postMessage({ type: 'start', line, existing: line.analysis, level, budgetMs: gameBudget })
  }
  function previous() { jump(positionIndex - 1) }
  function next() { jump(positionIndex + 1) }
  function newAnalysis() { navigationVersion.current++;
    const keepBatch = generating && !!batchStatus && batchStatus.total > 1 && (batchStatus.status === 'running' || batchStatus.status === 'stopping')
    if (!keepBatch) { abort.current?.abort(); abort.current = null }
    memoryGradeAbort.current?.abort(); engineAbort.current?.abort(); sharpAbort.current?.abort(); stopGameAnalysis()
    generatingLineId.current = null; practicing.current = false; practiceQueue.current = []
    if (!keepBatch) { setGenerating(false); setGenerationProgress('') } setLastGeneration(null)
    setSelectedId(null); setExploringLineId(null); setIndex(0); setPractice(null); setMemory(null); setReviewIndex(null); setPlaying(false)
    setPremove(null); setSquare(null); setGraphPreview(null)
    setManual([startFen]); setManualMoves([]); setManualIndex(0); setManualDirty(false); setManualParentId(undefined)
    setOpeningChoice(null); setOriginName(''); setOpeningSelector(false); setError(''); setNotice('')
  }
  function chooseOpening(record: OpeningRecord) {
    showRepertoire(false)
    if (!selected && manualDirty && !window.confirm('Switching openings will discard the unsaved moves on this board. Continue?')) return
    setPremove(null)
    const positions = openingPositions(record)
    setManual(positions); setManualMoves(record.uci.split(' ').filter(Boolean)); setManualIndex(positions.length - 1); setManualDirty(false)
    setManualParentId(undefined); setOpeningChoice(record); setOriginName(record.name); setSelectedId(null); setIndex(0); setPractice(null); setMemory(null); setReviewIndex(null); setPlaying(false); setFlipped(false); setOpeningSelector(false); setError('')
    setNotice(`${record.eco} ${record.name} loaded. Generate continues from this position.`)
  }
  function toggleFavorite(id: string) { setOpeningFavorites(ids => toggleOpeningFavorite(ids, id)) }
  function favoriteStar(record: OpeningRecord) { const id = openingFavoriteId(record), saved = openingFavorites.includes(id); return <button type="button" className="current-opening-star" aria-label={`${saved ? 'Remove from' : 'Add to'} favorites: ${record.name}`} aria-pressed={saved} title={`${saved ? 'Remove from' : 'Add to'} favorites`} onClick={() => toggleFavorite(id)}>{saved ? '★' : '☆'}</button> }
  function chooseGenerationMode(mode: GenerationMode) { setGenerationMode(availableGenerationMode(mode)); setMaxPlies(80) }
  function currentPly(line: Variation) { return selectedId === line.id && !exploring ? positionIndex : 0 }
  function loadLine(line: Variation, from = 0) { navigationVersion.current++; setAnalysisRevealed(null); setExplorerRevealed(null); stopGameAnalysis(); setPremove(null); setExploringLineId(null); setAnalysisLineId(null); setGraphPreview(null); memoryGradeAbort.current?.abort(); try { localStorage.setItem(ACTIVE_LINE, JSON.stringify({ line: lines.find(saved => saved.id === originalLineId(line.id)) || line, ply: from })) } catch { /* IndexedDB remains the main saved-line store. */ } setSelectedId(line.id); setIndex(from); setPlaying(false); setPractice(null); setMemory(null); setReviewIndex(null); if (!line.sideUnconfirmed) { setSide(line.side); setFlipped(false) } setError('') }
  function analyzeLine(line: Variation) { if (analysisMode && selectedId === line.id) { window.scrollTo(0, 0); return } if (selectedId === line.id && exploring) { setPlaying(false); setPractice(null); setMemory(null); setReviewIndex(null) } else loadLine(line, currentPly(line)); setAnalysisLineId(line.id); window.scrollTo(0, 0) }
  function chooseSide(next: Side) { setPremove(null); setSide(next); setFlipped(false) }
  function confirmLineSide(line: Variation, next: Side) { setLines(old => old.map(item => item.id === line.id ? { ...item, side: next, sideUnconfirmed: false } : item)); chooseSide(next) }
  function startWatch(line: Variation) { if (selectedId === line.id && exploring) { setError('Return to the saved line before watching it.'); return } loadLine(line, currentPly(line)); setFlipped(line.side !== orientation); setPlaying(true) }
  function startMemory(line: Variation, from = 0, to = line.moves.length) {
    if (line.sideUnconfirmed) { setError('Choose whether this older variation is for White or Black before memorizing it.'); return }
    if (!line.moves.length) { setError('This line has no moves to memorize.'); return }
    if (from >= line.moves.length) { setError('Choose an earlier move before memorizing this line.'); return }
    const start = Math.max(0, from)
    const end = Math.max(start + 1, Math.min(line.moves.length, to))
    if (!line.moves.slice(start, end).some((_, offset) => lineFen(line, start + offset).split(' ')[1] === (line.side === 'white' ? 'w' : 'b'))) { setError('Choose a segment containing at least one of your moves.'); return }
    if (familyRecord) exitSession()
    setPracticeAutoPlans(false)
    loadLine(line, start)
    const started = beginMemory(memoryStats[line.id] || emptyMemoryStats(), line.id, start, end, Date.now(), line.moves.length)
    setMemoryStats(old => ({ ...old, [line.id]: { ...(old[line.id] || emptyMemoryStats()), attempts: (old[line.id]?.attempts || 0) + 1 } }))
    completedMemory.current = null
    setMemory(started.session); setIndex(start)
  }
  function startDueMemory() {
    const due = dueMemoryLines(lines.filter(line => !line.sideUnconfirmed), memoryStats)[0]
    if (due) startMemory(due)
    else setNotice('No variations are due for memorization review yet.')
  }
  function showMemoryMove() {
    if (!memory || reviewIndex !== null || memory.phase !== 'active' || !memoryExpected || !selected || lineFen(selected, memory.index).split(' ')[1] !== (selected.side === 'white' ? 'w' : 'b')) return
    setMemory(old => old ? revealMemory(old, memoryExpected.san) : null)
  }
  function runSharpness() {
    if (analysisHidden) return
    engineAbort.current?.abort(); setLoadingEngine(false); setFastRunning(false)
    sharpAbort.current?.abort()
    const controller = new AbortController(); sharpAbort.current = controller
    setSharpness(null); setSharpRunning(true); setSharpProgress('Starting sharpness analysis…')
    const settings: SharpnessSettings = { depth: sharpDepth, budgetMs: sharpBudget * 1000, candidates: sharpCandidates, branches: sharpBranches, excellentCp: sharpExcellent, playableCp: sharpPlayable, seriousCp: sharpSerious, cacheKey: `${database}|${filters.ratings}|${filters.speeds}` }
    analyzeSharpness(fen, settings, { analyze, explorer: (position, signal) => explorer(position, filters, signal, database) }, controller.signal, progress => { if (!controller.signal.aborted) setSharpProgress(progress) }).then(result => {
      if (!controller.signal.aborted) { setSharpness(result); setSharpFen(fen); setSharpProgress(result.complete ? '' : 'Preliminary: some decisions could not be evaluated.') }
    }).catch(error => { if (!controller.signal.aborted) setSharpProgress((error as Error).name === 'AbortError' ? 'Insufficient analysis within the budget.' : `Sharpness analysis unavailable: ${(error as Error).message}`) }).finally(() => { if (sharpAbort.current === controller) setSharpRunning(false) })
  }
  function gradeMemoryAlternative(position: string, uci: string, ply: number) {
    memoryGradeAbort.current?.abort()
    const controller = new AbortController(); memoryGradeAbort.current = controller
    const unassessed = () => setMemory(old => old?.phase === 'active' && old.index === ply ? { ...old, message: `That differs from the saved continuation. Expected move: ${selected?.moves[ply]?.san || 'saved move'}. Chess quality could not be assessed; play the saved move to continue.` } : old)
    Promise.all([analyze(position, 1, gradingDepth, controller.signal, 12000), analyze(position, 1, gradingDepth, controller.signal, 12000, false, [uci])]).then(([best, played]) => {
      if (controller.signal.aborted) return
      if (!best[0] || !played[0]) { unassessed(); return }
      const loss = best[0].cp - played[0].cp
      const label = best[0].mate !== undefined || played[0].mate !== undefined ? 'Stockfish sees a mate-related difference; pawn-loss grading is unavailable.' : loss <= 70 ? 'Stockfish considers it a sound alternative.' : loss > 150 ? 'Stockfish flags a serious chess mistake.' : 'Stockfish sees an inaccuracy.'
      setMemory(old => old?.phase === 'active' && old.index === ply ? { ...old, message: `That differs from the saved continuation. ${label} Expected move: ${selected?.moves[ply]?.san || 'saved move'}. Play it to continue.` } : old)
    }).catch(() => { if (!controller.signal.aborted) unassessed() })
  }
  useEffect(() => {
    if (!premove) return
    const status = premoveStatus(premove, fen)
    if (status === 'waiting') return
    setPremove(null)
    if (status === 'play') playMove(premove.uci)
  }, [personalSelected, personalAnalysis, fen, premove])
  useEffect(() => { setPremove(null) }, [selectedId, side, !!memory, !!practice])

  function submitBoardMove(uci: string) {
    if (graphPreview !== null || memory?.phase === 'complete') return false
    if (analysisMode) return playMove(uci)
    const queued = familyRecord && memory ? null : queuePremove(fen, uci, side)
    if (queued) { setPremove(queued); setSquare(null); return false }
    if (board.turn() === (side === 'white' ? 'w' : 'b')) setPremove(null)
    return playMove(uci)
  }
  function playMove(uci: string) { navigationVersion.current++;
    const move = playUci(fen, uci)
    if (!move) return false
    setSquare(null)
    setGraphPreview(null)
    if (memory && selected) {
      if (reviewIndex !== null) return false
      if (memory.phase !== 'active' || memory.index >= memory.to || fen.split(' ')[1] !== (selected.side === 'white' ? 'w' : 'b')) return false
      const expected = selected.moves[memory.index]
      if (uci === expected?.uci) { memoryGradeAbort.current?.abort(); setMemory(old => old ? recallMove(old, uci, expected) : null); setIndex(memory.index + 1); return true }
      setMemory(old => old && expected ? recallMove(old, uci, expected) : old)
      if (!familyRecord) gradeMemoryAlternative(fen, uci, memory.index)
      return false
    }
    if (practice && selected) {
      if (reviewIndex !== null) {
        const continued = reviewMoveIndex(selected, reviewIndex, index, uci)
        if (continued === null) { setPractice(old => old ? { ...old, message: `Reviewing the saved line. Play ${selected.moves[reviewIndex]?.san || 'the shown move'}.` } : null); return false }
        setPremove(null)
        setReviewIndex(continued >= index ? null : continued)
        setPractice(old => old ? { ...old, message: '' } : null)
        return true
      }
      const expected = selected.moves[index]
      if (uci === expected?.uci) { setPractice(old => old ? { ...old, firstTry: old.firstTry + Number(old.clean), clean: true, alternative: undefined, message: `Correct: ${expected.san}` } : null); setIndex(index + 1); return true }
      const loss = scoreMove(uci, displayedEngine)
      const label = loss === null ? 'Outside the saved line' : loss <= tolerance ? 'Sound alternative' : loss <= 100 ? 'Inaccuracy' : 'Mistake'
      setPractice(old => old ? { ...old, errors: old.errors + 1, clean: false, alternative: loss !== null && loss <= tolerance ? uci : undefined, message: `${label}. The saved move is ${expected?.san || 'unavailable'}. Play it or use Show move to continue.` } : null)
      return false
    }
    const continued = followingLine ? nextLineIndex(followingLine, positionIndex, uci) : null
    if (continued !== null) { setPlaying(false); setIndex(continued); return true }
    setPlaying(false); setPractice(null)
    if (selected) setExploringLineId(selected.id)
    if (followingLine) {
      const prior = followingLine.moves.slice(0, positionIndex).map(move => move.uci)
      const game = new Chess(followingLine.startFen), positions = [game.fen()]
      for (const move of [...prior, uci]) { game.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] }); positions.push(game.fen()) }
      setManual(positions); setManualMoves([...prior, uci]); setManualIndex(positions.length - 1); setOriginName(followingLine.opening); setManualParentId(followingLine.id); setOpeningChoice(null)
    }
    else { setManual(old => [...old.slice(0, manualIndex + 1), nextFen(fen, uci)]); setManualMoves(old => [...old.slice(0, manualIndex), uci]); setManualIndex(manualIndex + 1) }
    setManualDirty(true)
    return true
  }
  function startPractice(line: Variation, queued = false, from = 0, endIndex = line.moves.length, fromRepertoire = false) {
    if (!fromRepertoire && selectedId === line.id && exploring) { setError('Return to the saved line before practicing it.'); return }
    if (line.sideUnconfirmed) { setError('Choose whether this older variation is for White or Black before practicing it.'); return }
    if (from >= endIndex) { setError('Choose an earlier move before practicing this line.'); return }
    const followGeneration = generating && generatingLineId.current === line.id
    const session: Practice = { lineId: line.id, from, started: Date.now(), firstTry: 0, errors: 0, reveals: 0, clean: true, endIndex: followGeneration ? undefined : endIndex, followGeneration, message: '' }
    if (!persistPractice(line, session, from)) return
    if (familyRecord) exitSession()
    setPracticeAutoPlans(false)
    if (!queued) practiceQueue.current = []
    loadLine(line, from); completed.current = null
    practicing.current = true; setPractice(session)
    try { localStorage.setItem(ACTIVE_LINE, JSON.stringify({ line: lines.find(saved => saved.id === originalLineId(line.id)) || line, ply: from, practice: linePerspective(line.id) === 'normal' ? session : null })) } catch { /* IndexedDB remains the main saved-line store. */ }
  }
  function showMove() { if (!selected || !practice || atEnd || !myTurn) return; setPractice(old => old ? { ...old, reveals: old.reveals + 1, clean: false, retryIndex: index, message: `Shown: ${selected.moves[index].san}. You can retry this move.` } : null); setIndex(index + 1) }
  function retryMove() { if (!practice || practice.retryIndex === undefined) return; setIndex(practice.retryIndex); setPractice(old => old ? { ...old, retryIndex: undefined, message: 'Try that move again.' } : null) }
  function practiceOpening(random = false) { const matching = lines.filter(line => line.opening === (selected?.opening || openingChoice?.name || exactOpening?.name || originName)); if (!matching.length) { setError('Generate a variation for this opening first.'); return } const order = random ? [matching[Math.floor(Math.random() * matching.length)]] : matching; practiceQueue.current = order.slice(1).map(line => line.id); startPractice(order[0], true) }
  function restartAnalysis() {
    engineAbort.current?.abort()
    const controller = new AbortController(); engineAbort.current = controller
    invalidateFastSharpness(fen)
    setEngine([]); setEngineFen(''); setLoadingEngine(true); setFastSharpness(null); setFastFen(''); setFastRunning(true)
    analyze(fen, 4, engineDepth, controller.signal, analysisSeconds * 1000, true).then(async lines => {
      if (controller.signal.aborted) return
      setEngine(old => old[0]?.source !== 'cloud' && old[0]?.depth > lines[0]?.depth ? old : lines); setEngineFen(fen)
      const result = await analyzeFastSharpness(fen, { analyze, cached: cachedAnalysis }, controller.signal)
      if (!controller.signal.aborted) { setFastSharpness(result); setFastFen(fen) }
    }).catch(e => { if (!controller.signal.aborted && e.name !== 'AbortError') setError(e.message) }).finally(() => { if (!controller.signal.aborted) { setLoadingEngine(false); setFastRunning(false) } })
  }

  async function runBatch(options: Generation, recovery?: BatchHandle) {
    const controller = new AbortController(); abort.current = controller
    const handle: BatchHandle = recovery || { id: crypto.randomUUID(), options, count: variationCount as 3 | 5 | 10, workers: parallelWorkers === 'auto' ? autoWorkers(navigator.hardwareConcurrency || 2) : parallelWorkers, seed: options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] }
    setGenerating(true); setBatchStatus(null); setGenerationProgress('Starting batch…'); setError(''); setPlaying(false)
    const processed = new Set<number>()
    let initialized = false, notificationCount = 0, notificationLine: string | undefined, latestStatus: BatchStatus | null = null
    let notificationTimer: ReturnType<typeof setTimeout> | undefined
    const update = (status: BatchStatus) => {
      if (abort.current !== controller) return
      latestStatus = status
      startTransition(() => {
        setBatchStatus(previous => newerBatch(previous, status))
        setGenerationProgress(`${status.completed}/${status.total} complete · ${status.running} running · ${status.failed} failed · ${status.cancelled} cancelled`)
      })
      const finished = status.jobs.map((job, index) => ({ job, index })).filter(({ job, index }) => !processed.has(index) && (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') && job.line && job.line.moves.length > options.prefix.length)
      const newCompletions = finished.filter(({ job }) => job.status === 'complete')
      if ((!recovery || initialized) && newCompletions.length) {
        notificationCount += newCompletions.length
        notificationLine ||= newCompletions[0].job.line?.id
        if (!notificationTimer) notificationTimer = setTimeout(() => { setGenerationToast({ text: notificationCount === 1 ? `Variation generated — ${options.opening}` : `${notificationCount} variations generated`, lineId: notificationCount === 1 ? notificationLine : undefined, results: notificationCount > 1 }); notificationTimer = undefined; notificationCount = 0; notificationLine = undefined }, 700)
      }
      initialized = true
      if (status.status !== 'running' && status.status !== 'stopping') setRecentBatchHistory(rememberBatch(status))
      if (!finished.length) return
      finished.forEach(({ index }) => processed.add(index))
      setLines(old => {
        let next = old
        for (const { job } of finished) {
          const source = job.line!
          const parent = next.find(line => line.id === options.parentId) || next.find(line => line.id !== source.id && line.startFen === source.startFen && line.side === source.side && line.opening === options.opening)
          const line = branchVariation(job.status === 'complete' ? source : { ...source, status: 'incomplete', termination: job.error || 'Batch stopped before verification.' }, { ...options, parentId: options.parentId || parent?.id }, parent)
          const prior = next.find(saved => saved.id === line.id)
          if (prior) next = next.map(saved => saved.id === line.id ? { ...line, customName: prior.customName, stats: prior.stats, analysis: line.analysis || prior.analysis } : saved)
          else next = saveVariation(next, line)
        }
        return next
      })
      const latest = finished.find(({ job }) => job.status === 'complete')?.job.line
      if (latest) setLastGeneration(latest)
    }
    try {
      const result = await backgroundBatch(handle, lines, controller.signal, update, !!recovery)
      if (notificationTimer) { clearTimeout(notificationTimer); notificationTimer = undefined }
      if (result.completed) setGenerationToast({ text: `Batch complete — ${result.completed} variation${result.completed === 1 ? '' : 's'} saved`, results: true })
      if (result.failed) setError(`${result.failed} batch job${result.failed === 1 ? '' : 's'} failed. Completed lines were saved.`)
    } catch (error) { if (abort.current === controller) {
      const interrupted: BatchStatus = latestStatus || { id: handle.id, opening: options.opening, side: options.side, status: 'running', startedAt: Date.now(), revision: 0, total: handle.count, completed: 0, running: 0, failed: 0, cancelled: 0, workers: handle.workers, jobs: Array.from({ length: handle.count }, (_, index) => ({ id: `${handle.id}:${index + 1}`, status: 'pending' as const, phase: 'Waiting', attempts: 0, sequence: 0, events: [], ply: options.prefix.length })) }
      if (interrupted.status === 'running' || interrupted.status === 'stopping') {
        const jobs = interrupted.jobs.map(job => job.status === 'running' || job.status === 'pending' ? { ...job, status: 'failed' as const, error: 'Server generation interrupted.' } : job)
        update({ ...interrupted, status: 'failed', jobs, running: 0, failed: jobs.filter(job => job.status === 'failed').length, revision: interrupted.revision + 1 })
      }
      setError((error as Error).message)
    } }
    finally { if (abort.current === controller) { setGenerating(false); abort.current = null } }
  }

  async function generate(recovery?: PendingGeneration) {
    if (perspective !== 'normal') { setError('Return to Normal before generating a saved variation.'); return }
    if ((generating && !recovery) || memory) return
    if (!recovery && pendingGeneration()) return generate(pendingGeneration())
    if (!recovery && pendingBatch()) return runBatch(pendingBatch()!.options, pendingBatch())
    if (!recovery && (generationMode === 'advanced' || generationMode === 'complete') && Object.keys(moveExclusions).length) { setError('Move exclusions are supported by Stockfish + human variations and Human mainline. Choose one of those modes to generate with exclusions.'); return }
    if (!recovery && terminal(new Chess(boardFen), 1)) { setError('This game has ended. Navigate to an earlier position before generating.'); return }
    const rootFen = recovery?.options.rootFen || boardFen, previousId = selectedId, previousIndex = index, previousExploration = exploringLineId
    const startFen = recovery?.options.startFen || (personalSelected ? rootFen : followingLine?.startFen || manual[0])
    const prefix: LineMove[] = recovery?.options.prefix || (personalSelected ? [] : followingLine ? followingLine.moves.slice(0, boardIndex) : (() => {
      const game = new Chess(startFen)
      return manualMoves.slice(0, manualIndex).map(uci => { const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); return { uci, san: move.san, source: 'preset' as const } })
    })())
    const graph = continuationsAt(lines, rootFen, selected?.side === side && !selected.sideUnconfirmed ? selectedId : null, side)
    const opening = selected?.opening || openingChoice?.name || originName || (manualMoves.length ? exactOpening?.name : undefined) || 'Custom position'
    const options: Generation = recovery?.options || { opponentModel: opponent, ...(personalSelected && personalGame ? { sourceGame: { id:personalGame.id, ply:boardIndex, fen:rootFen } } : {}), exploration, castlingPreference, castlingToleranceCp, style: generationStyle, aggressive, styleToleranceCp, initialPlies: generationMode === 'advantage' || generationMode === 'mainline' ? initialPlies : undefined, exclusions: structuredClone(moveExclusions), freshOpening: !selected && !openingChoice && !originName && prefix.length === 0 && rootFen === new Chess().fen(), opening, startFen, prefix, rootFen, excludeRootMoves: graph.covered, parentId: personalSelected ? undefined : selected?.id || manualParentId, side: personalSelected ? new Chess(rootFen).turn()==='w'?'white':'black' : side, database, filters, maxPlies, maxMs: generationMode === 'advanced' || generationMode === 'complete' ? generationSeconds * 1000 : undefined, engineDepth: generationDepth, verificationDepth, engineTimeoutMs: analysisSeconds * 1000, tolerance, mode: 'main', playMode: generationMode, advantageCp, conversionMinPlies, conversionMaxDifficulty, mastersFallback, targetRating, humanPolicy, seed: samplingSeed === '' ? undefined : Number(samplingSeed), minPositionGames, minMoveGames, limitedHumanData, engineFallback: limitedHumanData === 'engine', sharpnessPreference, stabilityPreference }
    if (!recovery && variationCount > 1) return runBatch(options)
    engineAbort.current?.abort(); sharpAbort.current?.abort(); stopGameAnalysis()
    generatingLineId.current = recovery && practice?.followGeneration ? practice.lineId : null; if (!recovery) practicing.current = false
    setPremove(null); setLastGeneration(null); setGenerationEvals({}); setGenerationAnalyses({}); setGenerating(true); setGenerationProgress(generationMode === 'complete' ? 'Generating complete game…' : 'Generating...'); setPlaying(false); if (!recovery) setPractice(null); setReviewIndex(null); setError('')
    const controller = new AbortController(); abort.current = controller
    const singleId = recovery?.id || crypto.randomUUID(), startedAt = Date.now()
    const single = (status: BatchStatus['status'], phase: string, line?: Variation, error?: string): BatchStatus => ({ id: singleId, opening: options.opening, side: options.side, status, startedAt, revision: Date.now(), total: 1, completed: status === 'complete' ? 1 : 0, running: status === 'running' ? 1 : 0, failed: status === 'failed' ? 1 : 0, cancelled: status === 'cancelled' ? 1 : 0, workers: 1, jobs: [{ id: `${singleId}:1`, status: status === 'stopping' ? 'running' : status, phase, attempts: 1, sequence: line?.moves.length || 0, events: [], ply: line?.moves.length || options.prefix.length, line, error }] })
    setBatchStatus(single('running', 'Starting generation…'))
    const generationNavigation = navigationVersion.current
    const followingGeneration = () => navigationVersion.current === generationNavigation
    let activated = false, latest: Variation | null = null, draftId: string | null = null
    try {
      const attachBranch = (draft: Variation) => branchVariation(draft, options, lines.find(line => line.id === options.parentId))
      const updateDraft = (incoming: Variation, phase: string) => {
        if (abort.current !== controller) return
        const draft = attachBranch(incoming)
        const partial = draft.recommendation?.verification === 'pending' ? { ...draft, status: 'incomplete' as const } : draft
        draftId = partial.id
        if (partial.moves.length > prefix.length) latest = partial
        setBatchStatus(single('running', phase, partial))
        if (!activated && followingGeneration()) { generatingLineId.current = partial.id; setExploringLineId(null); setSelectedId(partial.id); activated = true }
        if (!practicing.current && followingGeneration()) setIndex(partial.moves.length)
        setLines(old => old.some(item => item.id === partial.id) ? old.map(item => item.id === partial.id ? { ...partial, customName: item.customName || partial.customName, stats: item.stats, analysis: item.analysis || partial.analysis } : item) : [...old, partial])
      }
      const generated = await backgroundGeneration(options, lines, controller.signal, (phase, partial, evaluations, analyses) => {
        if (abort.current !== controller) return
        setGenerationProgress(phase)
        setBatchStatus(previous => previous?.id === singleId ? { ...previous, revision: Date.now(), jobs: [{ ...previous.jobs[0], phase }] } : previous)
        if (evaluations) setGenerationEvals(evaluations)
        if (analyses) setGenerationAnalyses(analyses)
        if (partial) updateDraft(partial, phase)
      }, recovery, singleId)
      if (abort.current !== controller) return
      const line = recovery || !lines.some(line => line.id === generated.id) ? attachBranch(generated) : generated
      setLastGeneration(line)
      if (line.moves.length <= prefix.length && !line.tablebase) throw new Error(line.termination || 'Unresolved — no continuation generated.')
      if (!recovery && lines.some(saved => saved.id === line.id)) {
        if (draftId && draftId !== line.id) setLines(old => old.filter(saved => saved.id !== draftId))
        const existing = single('complete', 'Already saved', line); setBatchStatus(existing); setRecentBatchHistory(rememberBatch(existing))
        if(followingGeneration()){setExploringLineId(null); setSelectedId(line.id); setIndex(line.moves.length)}; setNotice('This continuation is already saved. Try repertoire expansion for uncovered human responses.'); return
      }
      if (!recovery && saveVariation(lines, line).length === lines.length) {
        setLines(old => old.filter(item => item.id !== line.id))
        if(followingGeneration()){setSelectedId(previousId); setIndex(previousIndex); setExploringLineId(previousExploration); practicing.current = false; setPractice(null)}
        throw new Error('That continuation is already saved. Choose another board position or change generation settings.')
      }
      setLines(old => { const cleaned = draftId && draftId !== line.id ? old.filter(item => item.id !== draftId) : old; return cleaned.some(item => item.id === line.id) ? cleaned.map(item => item.id === line.id ? { ...line, customName: item.customName || line.customName, stats: item.stats, analysis: line.analysis || item.analysis } : item) : [...cleaned, line] })
      const completed = single('complete', 'Variation saved', line); setBatchStatus(completed); setRecentBatchHistory(rememberBatch(completed)); setGenerationToast({ text: `Variation generated — ${line.opening}`, lineId: line.id })
      if(followingGeneration()){setExploringLineId(null); setSelectedId(line.id); if (!practicing.current) setIndex(line.moves.length)}
      setNotice(`Continuation saved${line.fallback ? ' with labeled engine fallback' : ''}. ${line.recommendation?.reason || line.termination || 'Ready to watch or memorize.'}`)
    } catch (error) {
      if (abort.current !== controller) return
      const status = (error as Error).name === 'AbortError' ? 'cancelled' : 'failed'
      const stopped = single(status, (error as Error).message, latest || undefined, (error as Error).message); setBatchStatus(stopped); setRecentBatchHistory(rememberBatch(stopped))
      if ((error as Error).name !== 'AbortError') setError((error as Error).message)
      if (latest && draftId) setLines(old => old.map(item => item.id === draftId ? { ...item, status: 'incomplete', recommendation: item.recommendation?.verification === 'pending' ? { ...item.recommendation, verification: 'pending', reason: (error as Error).name === 'AbortError' ? 'Generation cancelled before verification.' : `Verification incomplete: ${(error as Error).message}` } : item.recommendation } : item))
      else { if (draftId) setLines(old => old.filter(item => item.id !== draftId)); if(followingGeneration()){setSelectedId(previousId); setIndex(previousIndex); setExploringLineId(previousExploration); practicing.current = false; setPractice(null)} }
    } finally { if (abort.current === controller) { setGenerating(false); setGenerationProgress(''); generatingLineId.current = null; abort.current = null } }
  }

  function loadFen() { navigationVersion.current++; try { const next = new Chess(fenInput).fen(); setPremove(null); setSelectedId(null); setManual([next]); setManualMoves([]); setManualIndex(0); setManualDirty(false); setOpeningChoice(null); setOriginName(''); setManualParentId(undefined); setNotice('Custom position loaded. Generate continues from this position.'); setError('') } catch { setError('Enter a legal FEN.') } }
  function importPgn() {
    navigationVersion.current++; try {
      const game = new Chess(); game.loadPgn(pgnInput)
      const history = game.history({ verbose: true })
      if (!history.length) throw new Error('The PGN has no moves.')
      const headers = game.getHeaders()
      const beginning = headers.FEN || startFen
      const moves: LineMove[] = history.map(move => ({ uci: move.from + move.to + (move.promotion || ''), san: move.san, source: 'import' }))
      const name = headers.Opening || `Imported — ${moves.slice(0, 4).map(move => move.san).join(' ')}`
      const ended = terminal(game, game.isThreefoldRepetition() ? 3 : 1)
      const candidate: Variation = { id: crypto.randomUUID(), opening: headers.Opening || 'Imported PGN', name, startFen: beginning, moves, pgn: game.pgn(), side, database, filters, created: Date.now(), stats: { firstTry: 0, errors: 0, reveals: 0, completions: 0, totalMs: 0 }, endPosition: identity(game.fen()), fallback: false, imported: true, status: ended ? 'complete' : 'incomplete', result: ended?.result, termination: ended?.reason }
      const updated = saveVariation(lines, candidate)
      if (updated.length === lines.length) throw new Error('This move sequence is already saved.')
      setLines(updated); loadLine(candidate); setIndex(candidate.moves.length); setPgnInput(''); setNotice('PGN imported and saved. Generate continues from its displayed endpoint.')
    } catch (e) { setError((e as Error).message || 'Could not import PGN.') }
  }
  function exportPgn(line: Variation) { const url = URL.createObjectURL(new Blob([line.pgn], { type: 'application/x-chess-pgn' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${(line.customName || line.name).replace(/[^a-z0-9-]+/gi, '-')}.pgn`; anchor.click(); URL.revokeObjectURL(url) }
  function rename(line: Variation) { const name = prompt('Variation name', line.customName || line.name)?.trim(); if (name) setLines(old => old.map(item => item.id === line.id ? { ...item, customName: name } : item)) }
  function remove(line: Variation) { if (!confirm(`Delete ${line.customName || line.name}?`)) return; setLines(old => old.filter(item => item.id !== line.id)); if (selectedId === line.id) { try { localStorage.removeItem(ACTIVE_LINE) } catch { /* Saved line deletion still proceeds. */ } setSelectedId(null); setPractice(null); setPlaying(false) } }

  const sortedLines = useMemo(() => lines.filter(line => (openingFilter === 'all' || line.opening === openingFilter) && `${line.opening} ${line.customName || line.name}`.toLowerCase().includes(search.toLowerCase()) && (statusFilter === 'all' || (statusFilter === 'practiced' ? line.stats.completions > 0 : line.stats.completions === 0))).sort((a, b) => sort === 'name' ? (a.customName || a.name).localeCompare(b.customName || b.name) : sort === 'practiced' ? (b.lastPracticed || 0) - (a.lastPracticed || 0) : b.created - a.created), [lines, search, sort, statusFilter, openingFilter])
  const lastUci = followingLine ? followingLine.moves[boardIndex - 1]?.uci : manualMoves[manualIndex - 1]
  const currentMove = boardIndex && lastUci ? (() => { const before = followingLine ? lineFen(followingLine, boardIndex - 1) : manual[manualIndex - 1]; const played = new Chess(before).move({ from: lastUci.slice(0, 2), to: lastUci.slice(2, 4), promotion: lastUci[4] }); return moveNumber(before, played.san) })() : 'Starting position'
  const lastFrom = lastUci?.slice(0, 2), lastTo = lastUci?.slice(2, 4)
  const squares: Record<string, CSSProperties> = {}
  if (lastFrom) squares[lastFrom] = { boxShadow: 'inset 0 0 0 4px #f8c76b88' }
  if (lastTo) squares[lastTo] = { boxShadow: 'inset 0 0 0 4px #f8c76b88' }
  if (memory?.hint && memoryExpected) { squares[memoryExpected.uci.slice(0, 2)] = { boxShadow: 'inset 0 0 0 5px #e19134' }; squares[memoryExpected.uci.slice(2, 4)] = { boxShadow: 'inset 0 0 0 5px #e19134' } }
  if (premove) for (const target of [premove.uci.slice(0, 2), premove.uci.slice(2, 4)]) squares[target] = { boxShadow: 'inset 0 0 0 5px #9575cdaa' }
  if (square && graphPreview === null) { squares[square] = { boxShadow: 'inset 0 0 0 4px #22a895' }; board.moves({ square, verbose: true }).forEach(move => { squares[move.to] = { boxShadow: 'inset 0 0 0 5px #22a89566' } }) }

  const ratingFilter = <details className="rating-filter">
    <summary>Ratings: {filters.ratings.join(', ')}</summary>
    <fieldset><legend>Choose game ratings</legend>{[1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500].map(rating => <label key={rating}><input type="checkbox" checked={filters.ratings.includes(rating)} disabled={filters.ratings.length === 1 && filters.ratings.includes(rating)} onChange={event => { const checked = event.target.checked; setFilters(old => ({ ...old, ratings: checked ? [...old.ratings, rating].sort((a, b) => a - b) : old.ratings.filter(value => value !== rating) })) }}/>{rating}</label>)}</fieldset>
  </details>


  const savedLineDescription = (line: Variation) => <span><strong>{line.customName || line.name}</strong><small><OpponentSource line={line}/> · {line.sideUnconfirmed ? 'Choose side' : `For ${line.side === 'white' ? 'White' : 'Black'}`} · {line.style === 'aggressive' ? 'Aggressive' : line.style === 'solid' ? 'Solid' : line.style === 'best' ? 'Best move' : 'Style unavailable'} · {numberedMoves(line.moves.length)} moves {line.branch && <>· {branchLabel(line)} · {line.branch.kind} </>} · {line.tablebase || line.recommendation?.policy === 'simple' ? line.termination?.split('.')[0] : line.status === 'complete' ? 'Complete' : line.status === 'favorable' ? 'Advantage achieved' : line.status === 'instructional' ? 'Configured length reached' : 'Incomplete'} · Memorized {memoryStats[line.id]?.perfect || 0}/{memoryStats[line.id]?.target || 5} · Attempts {memoryStats[line.id]?.attempts || 0}</small></span>

  return classic ? <><button className="return-learn" onClick={() => setClassic(false)}>← Learning workspace</button><Suspense fallback={<p>Loading workspace…</p>}><ClassicApp/></Suspense></> : <div className={["learn-shell", analysisHidden ? "memorizing" : "", familyRecord ? "branch-practice" : "", analysisMode ? "analyzing-line" : ""].join(" ")}>
    {generationToast && <div className="generation-toast" role="status"><span>{generationToast.text}</span><button onClick={() => { const line = lines.find(item => item.id === generationToast.lineId); if (line) loadLine(line, line.moves.length); else showRepertoire(true); setGenerationToast(null) }}>{generationToast.results ? 'View results' : 'View'}</button><button onClick={() => setGenerationToast(null)} aria-label="Dismiss generation notification">×</button></div>}
    {openingSelector && (catalog.length ? <Suspense fallback={<p>Loading openings…</p>}><OpeningSelector records={catalog} favorites={openingFavorites} onToggleFavorite={toggleFavorite} onChoose={chooseOpening} onClose={() => setOpeningSelector(false)}/></Suspense> : <div className="opening-overlay"><section className="opening-dialog" role="dialog" aria-modal="true" aria-label="Select opening"><button onClick={() => setOpeningSelector(false)} aria-label="Close opening selector">×</button><p>{catalogError || 'Loading the opening catalog…'}</p></section></div>)}
    <header className="learn-header"><a className="learn-brand" href="?analysis=new" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); newAnalysis() } }} aria-label="Opening Atlas — new analysis board" title="New analysis board"><span aria-hidden="true">♞</span><strong>Opening Atlas</strong></a><div className="learn-header-actions">
      <nav className="workspace-mode" aria-label="Main navigation"><button aria-current={!repertoirePage && !openingSelector ? 'page' : undefined} onClick={() => { showRepertoire(false); setOpeningSelector(false); setMemory(null); setPractice(null); setReviewIndex(null) }}>Analysis</button><button aria-current={repertoirePage && !openingSelector ? 'page' : undefined} onClick={() => showRepertoire(true)}>Repertoire</button><button aria-current={openingSelector ? 'page' : undefined} onClick={() => setOpeningSelector(true)}>Openings</button></nav>
      <div className="header-generation">      <button className="generate-action" onClick={() => void generate()} disabled={generating || !!memory}><Sparkles size={16}/> Generate</button>
      <MoveExclusionsMenu exploration={exploration} onExplorationChange={setExploration} fen={boardFen} side={side} label={currentMove} data={boardFen === fen ? data : null} value={moveExclusions} disabled={generating || !!memory} onChange={saveExclusions} aggressive={aggressive} onAggressiveChange={setAggressive} style={generationStyle} onStyleChange={setGenerationStyle} castlingPreference={castlingPreference} onCastlingChange={setCastlingPreference} castlingToleranceCp={castlingToleranceCp} onCastlingToleranceChange={setCastlingToleranceCp} count={variationCount} onCountChange={setVariationCount} workers={parallelWorkers} onWorkersChange={setParallelWorkers}/>
</div>
      <GenerationQueue active={batchStatus} recent={recentBatchHistory} lines={lines} onOpenLine={line => { showRepertoire(false); loadLine(line, line.moves.length) }} onStop={() => abort.current?.abort()} onRepertoire={() => showRepertoire(true)}/>
      {generating && <><span role="status" className="generation-progress">{generationProgress}</span><button onClick={() => abort.current?.abort()}><StopIcon size={15}/> Stop</button></>}
      <details className="learn-settings"><summary aria-label="Settings" title="Settings"><Settings2 size={16}/></summary><div>
        <label>Generation policy <select value={generationMode} onChange={e => chooseGenerationMode(e.target.value as GenerationMode)}><option value="advantage">Training continuation</option><option value="mainline">Mainline (most common database replies)</option><option value="advanced">Advanced repertoire optimization (database hybrid)</option></select></label>
        <label>Opponent <select aria-label="Generation opponent" value={opponent} disabled={generationMode==='complete'||generationMode==='advanced'} onChange={e=>{const value=e.target.value as typeof opponentModel;setOpponentModel(value);try{localStorage.setItem('atlas-opponent-model',value)}catch{/* Session choice remains available. */}}}><option value="lichess-stockfish">Lichess → Stockfish (Default)</option><option value="maia">Maia — Human-like Opponent</option><option value="lichess">Lichess — Database Opponent</option><option value="hybrid">Hybrid — Database → Maia → optional Stockfish</option></select></label>{opponent === "lichess-stockfish" && <p>Follow commonly played human opening moves, then switch to Stockfish when database coverage becomes insufficient.</p>}
        <small>{opponent==='maia'?'Learn how to respond to realistic human moves.':opponent==='lichess'?'Explore commonly played database moves.':'Use the existing database coverage and human fallback policy.'}{generationMode==='advanced'?' Advanced optimization retains its database policy.':''}</small>
        {ratingFilter}
        <label>Time controls <select value={filters.speeds.join(',')} onChange={e => setFilters(old => ({ ...old, speeds: e.target.value.split(',') }))}><option value="bullet,blitz">Bullet + Blitz</option><option value="blitz,rapid,classical">Blitz + Rapid + Classical</option><option value="rapid,classical">Rapid + Classical</option></select></label>
        <label>Advantage target (pawns) <input type="number" min="0.5" max="5" step="0.1" value={advantageCp / 100} onChange={e => setAdvantageCp(Math.round(Math.max(0.5, Math.min(5, Number(e.target.value) || 1.5)) * 100))}/></label>
        <label>Sharpness preference <select value={sharpnessPreference} onChange={e => setSharpnessPreference(e.target.value as typeof sharpnessPreference)}><option value="balanced">Common sound moves</option><option value="critical">Prefer critical replies</option></select></label>
        <label>Stability preference <select value={stabilityPreference} onChange={e => setStabilityPreference(e.target.value as typeof stabilityPreference)}><option value="strict">Strict advantage check</option><option value="balanced">Balanced advantage check</option></select></label>
        <label>Human selection <select value={humanPolicy} onChange={e => setHumanPolicy(e.target.value as typeof humanPolicy)}><option value="expansion">Repertoire expansion</option><option value="simulation">Human simulation (weighted random)</option></select></label>
        <label>Sampling seed (blank = new seed) <input type="number" min="0" max="4294967295" step="1" value={samplingSeed} onChange={e => setSamplingSeed(e.target.value)}/></label>
        <label>Minimum position games <input type="number" min="1" value={minPositionGames} onChange={e => setMinPositionGames(Math.max(1, Number(e.target.value) || 20))}/></label>
        <label>Minimum conversion moves <input type="number" min="2" max="20" value={conversionMinPlies / 2} onChange={e => setConversionMinPlies(Math.max(2, Math.min(20, Number(e.target.value) || 2)) * 2)}/></label>
        <label>Preferred endpoint difficulty <input type="number" min="0" max="100" value={conversionMaxDifficulty} onChange={e => setConversionMaxDifficulty(Math.max(0, Math.min(100, Number(e.target.value))))}/></label>
        <label><input type="checkbox" checked={mastersFallback} onChange={e => setMastersFallback(e.target.checked)}/> Allow Masters fallback</label>
        {(opponent === 'maia' || opponent === 'hybrid') && <><label>Human-model target rating <input type="number" min="400" max="3000" value={targetRating} onChange={e => setTargetRating(Math.max(400, Math.min(3000, Number(e.target.value) || 1900)))}/></label>
        <small>Maia-2 predicts opponent moves at the selected rating. In hybrid mode it is used when database coverage runs out. If unavailable, your limited-data choice applies.</small></>}
        <label>When human data is limited <select disabled={opponent === "lichess-stockfish"} value={opponent === "lichess-stockfish" ? "engine" : limitedHumanData} onChange={e => setLimitedHumanData(e.target.value as typeof limitedHumanData)}><option value="stop">Stop generation</option><option value="sparse">Use sparse human data</option><option value="engine">Use Stockfish (engine-only continuation)</option></select></label>
        <label>Minimum move games <input type="number" min="1" value={minMoveGames} onChange={e => setMinMoveGames(Math.max(1, Number(e.target.value) || 5))}/></label>
        <details className="explorer-cache-settings"><summary>Explorer cache</summary><p>{cacheStats ? `${cacheStats.positions.toLocaleString()} positions · ${(cacheStats.bytes / 1048576).toFixed(1)} MB · ${(cacheStats.hitRate * 100).toFixed(0)}% hit rate this session · ${cacheStats.networkAvoided.toLocaleString()} requests avoided · oldest ${Number.isFinite(cacheStats.oldest) ? Math.floor((Date.now() - cacheStats.oldest) / 86400000) + (Math.floor((Date.now() - cacheStats.oldest) / 86400000) === 1 ? ' day' : ' days') : 'none'}` : 'Loading cache statistics…'}</p><button onClick={() => void explorerCacheStats().then(setCacheStats)}>Refresh statistics</button><button onClick={() => { if (window.confirm('Clear only cached Explorer statistics? Saved variations and practice history stay intact.')) void clearExplorerCache().then(() => explorerCacheStats().then(setCacheStats)) }}>Clear Explorer cache</button></details>
        {(generationMode === 'advantage' || generationMode === 'mainline') && <label>Initial target (full moves) <input type="number" min="5" max={numberedMoves(maxPlies)} value={numberedMoves(initialPlies)} onChange={e => setInitialPlies(Math.max(5, Math.min(numberedMoves(maxPlies), Number(e.target.value) || 5)) * 2)}/></label>}
        <label>Maximum generated moves <input type="number" min={generationMode === 'advantage' || generationMode === 'mainline' ? numberedMoves(initialPlies) : 10} max="200" value={numberedMoves(maxPlies)} onChange={e => setMaxPlies(Math.max(generationMode === 'advantage' || generationMode === 'mainline' ? numberedMoves(initialPlies) : 10, Math.min(200, Number(e.target.value) || 10)) * 2)}/></label>
        <label>Routine engine depth <input type="number" min="16" max="18" value={generationDepth} onChange={e => setGenerationDepth(Math.max(16, Math.min(18, Number(e.target.value) || 16)))}/></label>
        <label>Verification engine depth <input type="number" min="20" max="28" value={verificationDepth} onChange={e => setVerificationDepth(Math.max(20, Math.min(28, Number(e.target.value) || 24)))}/></label>
        {(generationMode === 'advanced' || generationMode === 'complete') && <label>Maximum generation seconds <input type="number" min="10" max="1800" value={generationSeconds} onChange={e => setGenerationSeconds(Math.max(10, Math.min(1800, Number(e.target.value) || 10)))}/></label>}
        <label>Max analysis seconds <input type="number" min="5" max="60" value={analysisSeconds} onChange={e => setAnalysisSeconds(Math.max(5, Math.min(60, Number(e.target.value) || 5)))}/></label><label>Game analysis seconds per position <input type="number" min="1" max="10" value={gameBudget / 1000} onChange={e => setGameBudget(Math.max(1, Math.min(10, Number(e.target.value) || 1)) * 1000)}/></label>
        <label>Style soundness tolerance (centipawns) <input type="number" min="0" max="100" value={styleToleranceCp} onChange={e => setStyleToleranceCp(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}/></label><label>Soundness tolerance (centipawns) <input type="number" min="0" max="200" value={tolerance} onChange={e => setTolerance(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}/></label>
        <label>Start from FEN <input value={fenInput} onChange={e => setFenInput(e.target.value)} placeholder="Paste legal FEN"/></label><button onClick={loadFen}>Load FEN</button>
        <label>Import PGN <textarea value={pgnInput} onChange={e => setPgnInput(e.target.value)} placeholder="Paste PGN"/></label><button onClick={importPgn}>Import PGN</button>
      </div></details>
    </div></header>
    {repertoirePage ? <Suspense fallback={<p>Loading repertoire…</p>}><RepertoirePage embedded filters={filters} targetRating={targetRating} lines={lines} catalog={catalog} stats={memoryStats} ready={savedReady && memoryReady} busy={generating} remove={remove} back={() => showRepertoire(false)} act={repertoireAction} practice={practiceRepertoire} practiceSession={record => { if (record.session.memory && !record.session.finished) activateSession(record); else { const source = fromSession(record); openPlaylist([...playlists.saved,...playlists.recent].find(p=>p.sessionKey === source.sessionKey && p.sessionStarted === source.sessionStarted) || source) } }} updateStats={(id, change) => setMemoryStats(old => ({ ...old, [id]: change(old[id] || emptyMemoryStats()) }))}/></Suspense> : <main className="learn-main">
      {error && <div className="learn-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button>{lastGeneration && <details><summary>Generation details</summary><ConversionDetails line={lastGeneration}/></details>}</div>}
      <div className={`${selected ? "learn-grid has-line" : "learn-grid"} integrated-analysis`}>
        <section className="learn-center">{(personalSelected || selected?.sourceGame) && <div className="personal-game-header"><strong>{personalSelected ? `Personal Game · ${personalGame?.headers.Opening || personalGame?.headers.White || 'Imported game'} · ${personalGame?.headers.Result || '*'}` : 'Training continuation · original game preserved'}</strong><div className="personal-tools">{personalSelected ? <><button onClick={previous}>Previous</button><button onClick={next}>Next</button><button onClick={()=>setPersonalAnalysis(true)}>Analyze position</button><button onClick={()=>{setPersonalAnalysis(true);analyzeSelectedGame('fast')}}>Analyze game</button><button disabled={generating} onClick={()=>void generate()}>Generate from here</button><input aria-label="Bookmark note (optional)" placeholder="Position note (optional)" value={personalBookmarkNote} onChange={e=>setPersonalBookmarkNote(e.target.value)}/><button onClick={()=>void bookmarkPersonalPosition()}>Bookmark position</button><button onClick={()=>{navigationVersion.current++;setSelectedId(null);setManual([boardFen]);setManualMoves([]);setManualIndex(0);setPersonalAnalysis(false);stopGameAnalysis()}}>Return to Games</button></> : <><button onClick={()=>{const source=selected?.sourceGame;if(source)void getPersonalGame(source.id).then(game=>{if(game)openPersonalGame(game,source.ply)})}}>Return to original game</button><button onClick={()=>setSaveGamePlaylist(!saveGamePlaylist)}>Save to Playlist</button><span>Saved as a standalone training line</span></>}</div>{saveGamePlaylist&&selected?.sourceGame&&<div className="personal-tools"><input aria-label="New game training playlist name" value={gamePlaylistName} onChange={e=>setGamePlaylistName(e.target.value)}/><button onClick={()=>addGameLineToPlaylist()}>Create playlist</button>{playlists.saved.map(p=><button key={p.id} onClick={()=>addGameLineToPlaylist(p.id)}>Add to {p.name}</button>)}</div>}</div>}<div className="board-heading"><div className="position-label" aria-label="Current position"><strong><span className="position-name">{exactOpening?.name || (selected ? selected.opening : originName ? originName : 'Custom FEN')}</span>{exactOpening && favoriteStar(exactOpening)}</strong><span>{lastUci ? `After ${currentMove}` : `${fen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move`}{exactOpening ? ` · ${exactOpening.eco}` : ''}</span></div><div className="playing-controls"><span>Playing:</span><div className="playing-side" role="group" aria-label="Playing as"><button aria-pressed={side === 'white'} onClick={() => chooseSide('white')} disabled={generating || !!memory}>White</button><button aria-pressed={side === 'black'} onClick={() => chooseSide('black')} disabled={generating || !!memory}>Black</button></div><button className="flip-board" onClick={() => setFlipped(value => !value)} aria-label="Flip board" title="Flip board">↻</button></div></div><MaterialCount material={material} side={orientation === 'white' ? 'black' : 'white'}/><div className="board-row"><EvaluationBar evaluation={barEvaluation} orientation={orientation}/><div className="learn-board"><Profile id="board"><StableBoard options={{ position: preview?.full ? preview.future : preview?.baseline || boardFen, allowDragging: !preview?.full && !preview?.baseline, boardOrientation: orientation, onPieceDrag: () => setSquare(null), onPieceDrop: ({ sourceSquare, targetSquare }) => targetSquare ? submitBoardMove(sourceSquare + targetSquare + (new Chess(fen).get(sourceSquare as Square)?.type === 'p' && (targetSquare[1] === '8' || targetSquare[1] === '1') ? memory ? promotionChoice : 'q' : '')) : false, onSquareClick: ({ square: clicked }) => { if (preview?.full || preview?.baseline) return; const target = clicked as Square; if (square === target) { setSquare(null); return } if (square && submitBoardMove(square + target + (new Chess(fen).get(square)?.type === 'p' && (target[1] === '8' || target[1] === '1') ? memory ? promotionChoice : 'q' : ''))) return; setSquare(board.get(target) && (board.get(target)?.color === board.turn() || board.get(target)?.color === (side === 'white' ? 'w' : 'b')) ? target : null) }, squareStyles: preview ? { ...squares, ...Object.fromEntries((preview.movement ? [] : preview.changed).map(piece => [piece.square, { backgroundColor: '#33c4c580' }])), ...Object.fromEntries((preview.movement ? [] : preview.highlights || []).map(square => [square, { backgroundColor: '#e2a44799' }])) } : squares, arrowOptions: preview ? ghostArrowOptions : undefined, arrows: preview ? preview.arrows : graphPreview === null ? engineArrows : [], boardStyle: { borderRadius: 8 }, lightSquareStyle: { backgroundColor: '#f0d9b5' }, darkSquareStyle: { backgroundColor: '#b58863' }, animationDurationInMs: graphPreview === null && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 180 : 0 }} /></Profile>{preview && !preview.full && <GhostPieces changed={preview.changed} orientation={orientation}/>}{preview?.movement && <Profile id="movement-overlay"><MovementOverlay state={preview.movement} orientation={orientation}/></Profile>}</div></div><MaterialCount material={material} side={orientation}/><div className="move-list" aria-label="Line moves">{followingLine ? followingLine.moves.slice(0, memory ? memory.index : practice ? index : undefined).map((move, i) => <button key={i} className={[positionIndex === i + 1 ? 'current' : '', followingLine.branch && i >= followingLine.branch.ply ? 'generated-move' : ''].join(' ')} onClick={() => jump(i + 1)} title={`${move.source}${move.frequency === undefined ? '' : ` · ${Math.round(move.frequency * 100)}%`}`}>{followingLine.branch?.ply === i && <span className="branch-marker" title="Variation begins" aria-label="Variation begins">│</span>}{moveNumber(lineFen(followingLine, i), move.san)}</button>) : manualMoves.length ? manualMoves.map((uci, i) => {
          const move = playUci(manual[i], uci)!
          return <button key={i} className={manualIndex === i + 1 ? 'current' : ''} aria-current={manualIndex === i + 1 ? 'step' : undefined} onClick={() => jump(i + 1)}>{moveNumber(manual[i], move.san)}</button>
        }) : <span>Starting position · No moves played yet.</span>}</div><div className="transport"><button aria-label="Restart" onClick={() => jump(0)}><SkipBack size={18}/></button><button aria-label="Previous move" onClick={previous}><ArrowLeft size={18}/></button><button className="transport-main" onClick={() => selected ? (setPremove(null), setExploringLineId(null), setPractice(null), setReviewIndex(null), setPlaying(!playing)) : setNotice('Select a saved variation to watch it.')} disabled={!selected || generating}>{playing ? <Pause size={18}/> : <Play size={18}/>} {playing ? 'Pause' : 'Play'}</button><button aria-label="Next move" onClick={next}><ArrowRight size={18}/></button><button aria-label="End" onClick={() => jump(followingLine ? followingLine.moves.length : manualMoves.length)}><SkipForward size={18}/></button></div><div className="current-move" aria-live="polite">Current position: <strong>{currentMove}</strong>{premove && <span role="status"> · Premove: {premove.uci.slice(0, 2)}–{premove.uci.slice(2, 4)} <button onClick={() => setPremove(null)}>Cancel premove</button></span>}{(practice || memory) && reviewIndex !== null && <span> · Reviewing played moves</span>}</div><div className="watch-options has-perspective">{selected && !personalSelected && <div className="perspective-controls" role="group" aria-label="Line perspective"><button disabled={generating || exploring} aria-pressed={perspective === 'normal'} onClick={() => changePerspective('normal')}>Normal</button><button disabled={generating || exploring} aria-pressed={perspective === 'reverse' || perspective === 'combined'} onClick={() => changePerspective(perspective === 'mirror' ? 'combined' : 'reverse')}>Reverse Colors</button><details><summary>Advanced</summary><label><input type="checkbox" checked={perspective === 'mirror' || perspective === 'combined'} disabled={generating || exploring} onChange={e => changePerspective(e.target.checked ? perspective === 'reverse' ? 'combined' : 'mirror' : perspective === 'combined' ? 'reverse' : 'normal')}/>Mirror Files (experimental)</label></details>{perspective !== 'normal' && <span role="status">{perspective === 'reverse' ? 'Reversed-color study' : 'Experimental mirrored study'} · Separate practice progress · Move order preserved; opening theory may differ.</span>}</div>}<button onClick={generatePositionPlaylist} disabled={!savedReady || !!preview || graphPreview !== null || perspective !== 'normal'} title="Create a playlist from existing descendants of the current position">Generate Playlist</button><label className="watch-speed">Watch speed <input type="range" aria-label="Watch speed" aria-valuetext={`${speed}×`} min="0.25" max="3" step="0.25" value={speed} onChange={e => setSpeed(Number(e.target.value))}/><output>{speed}×</output></label><label><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)}/> Loop</label>{practice && <details className="legacy-practice"><summary>Practice options</summary><button onClick={showMove} disabled={!myTurn || reviewIndex !== null}>Show move</button><button onClick={retryMove} disabled={practice.retryIndex === undefined || reviewIndex !== null}>Retry move</button><button onClick={() => { const alternative = practice.alternative; if (!alternative || !selected) return; const history = [...selected.moves.slice(0, positionIndex), { uci: alternative, san: '', source: 'engine' as const }]; setPractice(null); setReviewIndex(null); setExploringLineId(selected.id); setManual(positions({ startFen: selected.startFen, moves: history })); setManualMoves(history.map(move => move.uci)); setManualIndex(history.length); setOriginName(selected.opening); setManualParentId(selected.id) }} disabled={!practice.alternative || reviewIndex !== null}>Explore alternative</button></details>}</div>{practice?.message && practice.message !== 'Play the move shown for your side.' && <div className="practice-message">{practice.message}</div>}{selected && !memory && !exploring && <Profile id="graphs"><GameAnalysis line={selected} current={positionIndex} hover={graphPreview} onHover={setGraphPreview} onNavigate={jump} running={gameRunning} progress={gameProgress} onAnalyze={analyzeSelectedGame} onCancel={stopGameAnalysis}/></Profile>}</section>
        <aside className="analysis-rail" aria-label="Analysis tools">
        <section className="analysis-slot slot-line" aria-label="Repertoire"><button type="button" className="analysis-slot-toggle" aria-expanded={sections.line} onClick={()=>toggleSection('line')}><span>Repertoire</span><span aria-hidden="true">{sections.line ? '▾' : '▸'}</span></button><div className="analysis-slot-body" hidden={!sections.line}>

        {selected && <section className="learn-panel learn-line-guide" aria-label={memory ? 'Memorize mode' : 'Selected line'}><div className="line-guide-body">
          {memory ? <><h2>{selected.opening}</h2><p className="line-guide-opening">For {selected.side === 'white' ? 'White' : 'Black'} · {numberedMoves(selected.moves.length)} moves · Recall practice</p></> : <CurrentLineSummary line={selected} memorized={memoryStats[selected.id]?.perfect || 0} target={memoryStats[selected.id]?.target || 5} attempts={memoryStats[selected.id]?.attempts || 0}/>}
          {selected.sideUnconfirmed && <div className="confirm-side"><span>This older line has no saved training side.</span><button onClick={() => confirmLineSide(selected, 'white')}>For White</button><button onClick={() => confirmLineSide(selected, 'black')}>For Black</button></div>}{!selected.sideUnconfirmed && side !== selected.side && !memory && <p className="side-note">Generate prepares {side === 'white' ? 'White' : 'Black'} from this position. Memorize restores this saved line to {selected.side === 'white' ? 'White' : 'Black'}.</p>}
          {!memory && !personalSelected && <div className="line-guide-actions current-line-actions"><button onClick={() => startPractice(selected)} disabled={selected.sideUnconfirmed}>Practice</button><button onClick={() => startWatch(selected)} disabled={generating}>Watch</button><button onClick={() => analysisMode ? (stopGameAnalysis(), setAnalysisLineId(null)) : analyzeLine(selected)} disabled={generating}>{analysisMode ? 'Exit analysis' : 'Analyze'}</button><button onClick={() => startMemory(selected)} disabled={selected.sideUnconfirmed}>Memorize</button><button onClick={() => showRepertoire(true, originalSelected || selected)}>Open in Repertoire</button><details className="line-overflow" ref={lineMenu}><summary aria-label="More line actions">⋯</summary><div onClick={event => { const button = (event.target as HTMLElement).closest('button'); if (button && !button.disabled && lineMenu.current) { lineMenu.current.open = false; lineMenu.current.querySelector('summary')?.focus() } }}><button onClick={() => void navigator.clipboard.writeText(selected.pgn).then(() => setNotice('PGN copied')).catch(() => setError('Could not copy PGN.'))}>Copy PGN</button><button onClick={() => exportPgn(selected)}>Export PGN</button><button disabled={perspective !== 'normal'} onClick={() => remove(selected)}>Delete line</button></div></details></div>}
          {memory && selected.branch && positionIndex === selected.branch.ply && <p className="branch-info">Variation begins</p>}
          <div className="line-progress" role="progressbar" aria-label={memory ? "Memorization progress" : practice ? "Practice progress" : "Line progress"} aria-valuemin={0} aria-valuemax={memory?.to ?? selected.moves.length} aria-valuenow={memory?.index ?? index}><span style={{ width: `${(memory?.index ?? index) / Math.max(1, memory?.to ?? selected.moves.length) * 100}%` }}/></div>
          <div className="line-turn" aria-live="polite">{exploring ? <><strong>Exploring an alternative</strong><button onClick={() => void generate()} disabled={generating || !!memory}>Generate new line</button><button onClick={() => { setPremove(null); setExploringLineId(null); setGraphPreview(null); setSquare(null) }}>Return to line</button></> : memory ? <strong>{reviewIndex !== null ? 'Reviewing played moves · Press → to return' : memory.phase === 'complete' ? familyRecord ? familyRecord.session.stopped ? 'Practice stopped · unfinished attempt not graded' : 'Line practiced' : 'Memorization complete' : 'Recall the next move'}</strong> : nextInstruction ? <><strong>{analysisMode ? `Next in line: ${selected.moves[instructionIndex].san}` : practice && reviewIndex === null ? `Next move to play: ${selected.moves[instructionIndex].san}` : nextInstruction.title}</strong><span>{nextInstruction.detail}</span></> : <strong>{practice?.followGeneration && generating ? 'Waiting for the next move' : 'End of saved line'}</strong>}</div>
          {memory ? <><p className="memory-position">Move {Math.min(numberedMoves(memory.index + 1), numberedMoves(memory.to))} of {numberedMoves(memory.to)} · {lineFen(selected, memory.index).split(' ')[1] === 'w' ? 'White' : 'Black'} to move · ←/→ review played moves</p>{(!familyRecord || memory.message.startsWith('That differs')) && <p className="memory-feedback" role="status">{memory.message}</p>}{!familyRecord && <div className="memory-helpers">{memory.phase === 'complete' && <button onClick={() => startMemory(selected, memory.from, memory.to)}>Repeat</button>}{memory.phase === 'active' && <><button onClick={showMemoryMove} disabled={reviewIndex !== null || !memoryExpected || lineFen(selected, memory.index).split(' ')[1] !== (selected.side === 'white' ? 'w' : 'b')}>Show move</button><button onClick={() => { memoryGradeAbort.current?.abort(); setMemory(null) }}>Stop</button><label>Promote to <select aria-label="Promotion piece" value={promotionChoice} onChange={e => setPromotionChoice(e.target.value as typeof promotionChoice)}><option value="q">Queen</option><option value="r">Rook</option><option value="b">Bishop</option><option value="n">Knight</option></select></label></>}</div>}</> : null}
          {selected.exploration?.mode === 'explore' && <details className="exploration-details"><summary>Explore Variations</summary><p>Maximum loss: {(selected.exploration.lossCp / 100).toFixed(2)} pawns · Temperature: {selected.exploration.temperature === 'auto' ? 'Auto (0.10)' : selected.exploration.temperature} · Seed: {selected.exploration.seed}</p><ul>{selected.moves.map((move,i) => move.exploration && <li key={i}>{move.exploration.deviation ? 'Alternative selected at ' : 'Decision at '}{moveNumber(lineFen(selected,i),move.san)}{move.exploration.deviation && <> · Stockfish preferred {moveNumber(lineFen(selected,i),new Chess(lineFen(selected,i)).moves({verbose:true}).find(m=>m.from+m.to+(m.promotion||'')===move.exploration!.best)?.san || move.exploration.best)} · Evaluation loss: {(move.exploration.lossCp / 100).toFixed(2)} pawns · Depth {move.exploration.depth}</>}. {move.exploration.reason}</li>)}</ul></details>}
          {memory && <div className="memory-stats"><span>Memorized: {memoryStats[selected.id]?.perfect || 0}/{memoryStats[selected.id]?.target || 5}</span><span>Attempts: {memoryStats[selected.id]?.attempts || 0}</span></div>}<details className="memory-details"><summary>Details</summary>{!memory && <><p>Generation start: {generationProvenance(selected).start}{selected.branch && divergenceLabel(selected) ? ` · ${divergenceLabel(selected)}` : ""}</p><p>Start FEN: <code>{selected.branch?.fen || selected.startFen}</code></p><p>Engine: {selected.engineConfig ? `Depth ${selected.engineConfig.depth} · timeout ${selected.engineConfig.timeoutMs} ms` : "Configuration unavailable"}</p><p>{selected.recommendation?.policy === "simple" && selected.recommendation.verification === "pending" ? "Deep verification: Not performed" : `Verification: ${selected.recommendation?.verification || "Unavailable"}`}</p><pre className="line-source-details">{opponentProvenance(selected).details}</pre></>}{!memory && <div className="line-guide-moves">{selected.moves.map((move, moveIndex) => moveNumber(lineFen(selected, moveIndex), move.san)).join(' ')}</div>}{!memory && <RecommendationSummary line={selected}/>}{!memory && <div className="line-analysis-pgn"><div><strong>PGN · Full line</strong><button onClick={() => exportPgn(selected)}>Download PGN</button></div><textarea aria-label="Line PGN" readOnly value={selected.pgn} rows={6}/>{analysisMode && <p>Play any legal move to explore. The saved line and PGN remain available.</p>}</div>}<p>Generation style: {selected.style || 'best'}{selected.aggressive ? selected.style === 'aggressive' ? ' · Aggressive engine: Patricia' : ' · Patricia inactive for this style' : ''}</p>{selected.moves.some(move => move.aggressive) && <ul aria-label="Aggressive generation decisions">{selected.moves.map((move, i) => move.aggressive && <li key={i}>Ply {i + 1}: Patricia {move.aggressive.consulted ? 'consulted' : 'not consulted'} · Stockfish {move.aggressive.stockfish} · Proposed {move.aggressive.proposed || 'none'} · Selected {move.aggressive.selected} · Evaluation loss {move.aggressive.lossCp === undefined ? 'not established' : (move.aggressive.lossCp / 100).toFixed(2)} · Verification depth {move.aggressive.verifiedDepth ?? 'not completed'} · Preference {move.aggressive.rejected ? 'not used' : 'accepted'}: {move.aggressive.reason}</li>)}</ul>}{!memory && selected.recommendation?.policy === 'simple' && <><ConversionDetails line={selected}/><p>Generation: {((selected.recommendation.runtimeMs || 0) / 1000).toFixed(2)}s · Stockfish searches: {selected.recommendation.performance?.searches ?? 0}. Explorer display filters are unchanged by generation fallback.</p><ul>{selected.moves.map((move, i) => move.population || move.engineFallback || move.prediction ? <li key={i}>Ply {i + 1} ({move.san}): {move.prediction ? `Predicted human move · ${move.prediction.model} ${move.prediction.version} · rating ${move.prediction.rating} · ${(move.prediction.probability * 100).toFixed(1)}% model probability · ${modelFallbackReason(selected, i)}` : move.population ? `${populationLabel(move.population)}${move.explorerCache ? ` · ${move.explorerCache.state === "live" ? "refreshed" : move.explorerCache.state} ${new Date(move.explorerCache.retrievedAt).toLocaleDateString()}` : ""}` : 'Engine-only continuation'}{move.sampling ? ` · ${move.games} games · ${(move.sampling.probability * 100).toFixed(1)}% of eligible replies` : ''}</li> : null)}</ul><details><summary>Human coverage checks</summary><ul>{selected.recommendation.populationAttempts?.map((attempt, i) => <li key={i}>Before ply {attempt.ply + 1}: {populationLabel(attempt)} · {attempt.error || `${attempt.games} games, ${attempt.eligibleGames} eligible${attempt.issue ? ' · ' + attempt.issue : ''}`}</li>)}</ul></details></>}<p>Completed {memoryStats[selected.id]?.completed || 0} · Streak {memoryStats[selected.id]?.streak || 0} · Best {memoryStats[selected.id]?.bestStreak || 0}</p><p>Incorrect {memoryStats[selected.id]?.wrong || 0} · Revealed {memoryStats[selected.id]?.reveals || 0} · Average completion {memoryStats[selected.id]?.completed ? Math.round(memoryStats[selected.id].totalMs / memoryStats[selected.id].completed / 1000) : 0}s</p><p>Last practiced {memoryStats[selected.id]?.lastPracticed ? new Date(memoryStats[selected.id]?.lastPracticed || 0).toLocaleDateString() : 'Never'} · Next review {memoryStats[selected.id]?.dueAt ? new Date(memoryStats[selected.id]?.dueAt || 0).toLocaleString() : 'Due now'}</p><label>Goal <select aria-label="Perfect repetition target" value={memoryStats[selected.id]?.target || 5} onChange={e => setMemoryStats(old => ({ ...old, [selected.id]: { ...(old[selected.id] || emptyMemoryStats()), target: Number(e.target.value) } }))}><option value="5">5 perfect</option><option value="10">10 perfect</option><option value="20">20 perfect</option></select></label></details>
        </div></section>}
          {!selected && <p className="empty-note">Select a saved variation to see its line and actions.</p>}
        <div className="slot-playlist" aria-label="Saved variations"><button type="button" className="analysis-slot-toggle" aria-expanded={sections.playlist} onClick={()=>toggleSection('playlist')}><span>Playlists</span><span aria-hidden="true">{sections.playlist ? '▾' : '▸'}</span></button><div className="analysis-slot-body" hidden={!sections.playlist}>
        <Profile id="saved"><Playlist
          mode={activePlaylist ? activePlaylist.type === 'SAVED_CUSTOM' ? 'SAVED_CUSTOM' : activePlaylist.type === 'REVIEW' ? 'REVIEW' : activePlaylist.type === 'TEMPORARY_BRANCH' ? 'BRANCH_PRACTICE' : 'FAMILY_PRACTICE' : 'SAVED_LINES'}
          title={activePlaylist?.name}
          count={activePlaylist ? playlistLines.length : sortedLines.length}
          progress={activePlaylist ? `${Math.max(0, playlistLines.findIndex(l => l.id === originalLineId(selectedId || '')) + 1)}/${playlistLines.length}` : undefined}
          tools={activePlaylist ? <>
            {playlistComplete && <p role="status">Line practiced</p>}
            <div className="session-actions">
              <button disabled={!previousPlaylistId} onClick={() => selectPlaylistLine(playlistLines.find(l=>l.id === previousPlaylistId)!)}>← Previous</button>
              <button disabled={!nextPlaylistId} onClick={() => selectPlaylistLine(playlistLines.find(l=>l.id === nextPlaylistId)!)}>Next →</button>
              {playlistComplete && selected && <button onClick={() => selectPlaylistLine(selected, activePlaylist, true)}>Retry</button>}
              <button onClick={exitPlaylist}>× Exit Playlist</button>
              <details className="session-more"><summary aria-label="Playlist options">⋯</summary><div>
                {activePlaylist.type !== 'SAVED_CUSTOM' && <button onClick={event => { setPlaylistName(activePlaylist.name); event.currentTarget.closest('details')?.removeAttribute('open') }}>Save Playlist</button>}
                {familyRecord && <><button onClick={stopSession}>Stop session</button><button onClick={() => suspendRecall()}>End practice</button><button onClick={() => restartSession(true)} disabled={!familyProgress || familyProgress.attempted === familyProgress.passed}>Review suggested lines</button></>}
                <details><summary>Practice details</summary>{selected && <p>Line completions: {selected.stats.completions} · Mistakes: {selected.stats.errors} · Hints: {selected.stats.reveals}</p>}{familyProgress && <p>{familyProgress.attempted}/{familyProgress.total} recall lines practiced · {familyProgress.mastered}/{familyProgress.total} mastered</p>}{playlistRecord && <p>Mistakes: {playlistRecord.session.attempts.reduce((sum,a)=>sum+a.wrong,0)} · Hints: {playlistRecord.session.attempts.reduce((sum,a)=>sum+a.hints,0)}</p>}{practice && <p>Current attempt: {practice.errors} mistakes · {practice.reveals} hints</p>}</details>
              </div></details>
            </div>{playlistName !== null && <form className="session-actions" onSubmit={event => { event.preventDefault(); savePlaylist() }}><input autoFocus aria-label="Playlist name" value={playlistName} onChange={event => setPlaylistName(event.target.value)}/><button type="submit" disabled={!playlistName.trim()}>Save</button><button type="button" onClick={() => setPlaylistName(null)}>Cancel</button></form>}</> : <div className="saved-tools"><div className="saved-search"><Search size={16}/><input aria-label="Search variations" placeholder="Search variations" value={search} onChange={e => setSearch(e.target.value)}/></div><details className="saved-more"><summary>More</summary><div><button onClick={startDueMemory}>Memorize due</button><button onClick={() => practiceOpening(true)}>Practice random</button><button onClick={() => practiceOpening()}>Practice opening</button><select aria-label="Opening filter" value={openingFilter} onChange={e => setOpeningFilter(e.target.value)}><option value="all">All openings</option>{[...new Set(lines.map(line => line.opening))].map(name => <option key={name}>{name}</option>)}</select><select aria-label="Practice filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}><option value="all">All</option><option value="unpracticed">Unpracticed</option><option value="practiced">Practiced</option></select><select aria-label="Sort variations" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="newest">Newest</option><option value="name">Name</option><option value="practiced">Last practiced</option></select></div></details></div>}
          render={activePlaylist ? row => {
            const line = playlistLines[row]
            return <div className={`saved-line ${originalLineId(selectedId || '') === line.id ? 'active' : ''}`} key={line.id}><button className="saved-open" aria-current={originalLineId(selectedId || '') === line.id ? 'true' : undefined} onClick={() => selectPlaylistLine(line)}><BookOpen size={16}/><span><strong>{queueLabels[row]}</strong></span></button></div>

          } : row => { const line = sortedLines[row]; return <div className={`saved-line ${originalLineId(selectedId || '') === line.id ? 'active' : ''}`} key={line.id}><button className="saved-open" onClick={() => selectPlaylistLine(line, null)}><BookOpen size={18}/>{savedLineDescription(line)}</button><div className="saved-line-actions"><button onClick={() => analyzeLine(line)} disabled={generating}>Analyze</button><button onClick={() => startWatch(line)} disabled={generating}>Watch</button><button onClick={() => startMemory(line)} disabled={line.sideUnconfirmed}>Memorize</button><button onClick={() => startPractice(line)} disabled={line.sideUnconfirmed}>Practice</button><details className="saved-line-more"><summary aria-label={`More options for ${line.customName || line.name}`}>⋯</summary><div><button onClick={() => rename(line)}>Rename</button><button onClick={() => exportPgn(line)}>Export PGN</button><button onClick={() => remove(line)}>Delete</button></div></details></div></div> }}
        /></Profile>
        <details className="playlist-library"><summary>Recent Playlists · {playlists.recent.length}</summary>{playlists.recent.map(p => <button key={p.id} onClick={() => openPlaylist(p)}>{p.name}</button>)}</details>
        {playlists.review && <div className="playlist-library"><button onClick={() => openPlaylist(playlists.review!)}>{playlists.review.name}</button></div>}
        {!!playlists.saved.length && <details className="playlist-library"><summary>Saved Playlists · {playlists.saved.length}</summary>{playlists.saved.map(p => <button key={p.id} onClick={() => openPlaylist(p)}>{p.name}</button>)}</details>}
        </div></div></div></section>
        <section className="analysis-slot slot-engine" aria-label="Stockfish"><button type="button" className="analysis-slot-toggle" aria-expanded={sections.engine} onClick={()=>toggleSection('engine')}><span>Stockfish</span>{!analysisHidden && <span className="engine-status" title={searchStatus(displayedEngine, engineDepth, loadingEngine).detail}>{board.isCheckmate() ? `${board.turn() === "w" ? "Black" : "White"} wins` : `${displayedEngine[0] ? score(displayedEngine[0], fen) + " · " : ""}${searchStatus(displayedEngine, engineDepth, loadingEngine).label}`}</span>}<span aria-hidden="true">{sections.engine ? '▾' : '▸'}</span></button><div className="analysis-slot-body" hidden={!sections.engine}>
        <section className="learn-panel learn-engine" aria-label="Stockfish analysis">{analysisHidden ? <p className="empty-note">Analysis hidden during recall. <button onClick={() => revealAnalysis('engine')}>Reveal analysis</button></p> : <>
          <div className="engine-head"><strong>STOCKFISH</strong><details className="engine-menu" ref={engineMenu}><summary aria-label="Stockfish options" title="Stockfish options">⋯</summary><div className="engine-menu-items"><button onClick={() => setShowEngineArrows(value => !value)} aria-pressed={showEngineArrows}>{showEngineArrows ? 'Hide arrows' : 'Show arrows'}</button><label><input type="checkbox" checked={useCloud} onChange={e => setUseCloud(e.target.checked)}/>Use Lichess cloud evaluations</label><label>Engine depth <input aria-label="Stockfish depth" type="number" min="8" max="30" value={engineDepth} onChange={e => setEngineDepth(Math.max(8, Math.min(30, Number(e.target.value) || 14)))}/></label><button onClick={() => { engineMenu.current!.open = false; restartAnalysis() }}>Analyze again</button><button onClick={() => { engineMenu.current!.open = false; runSharpness() }} disabled={sharpRunning}>Analyze sharpness deeper</button>{sharpRunning && <button onClick={() => { sharpAbort.current?.abort(); setSharpRunning(false); setSharpProgress('Analysis stopped.') }}>Stop deep analysis</button>}<details className="sharp-settings"><summary>Advanced sharpness settings</summary><label>Depth <input aria-label="Sharpness depth" type="number" min="10" max="22" value={sharpDepth} onChange={e => setSharpDepth(Math.max(10, Math.min(22, Number(e.target.value) || 16)))}/></label><label>Candidate moves <input aria-label="Sharpness candidate moves" type="number" min="4" max="20" value={sharpCandidates} onChange={e => setSharpCandidates(Math.max(4, Math.min(20, Number(e.target.value) || 4)))}/></label><label>Future branches <input aria-label="Sharpness future branches" type="number" min="1" max="4" value={sharpBranches} onChange={e => setSharpBranches(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}/></label><label>Budget (seconds) <input aria-label="Sharpness budget" type="number" min="10" max="180" value={sharpBudget} onChange={e => setSharpBudget(Math.max(10, Math.min(180, Number(e.target.value) || 45)))}/></label><label>Excellent loss (cp) <input type="number" min="0" max="200" value={sharpExcellent} onChange={e => setSharpExcellent(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}/></label><label>Acceptable loss (cp) <input type="number" min="0" max="300" value={sharpPlayable} onChange={e => setSharpPlayable(Math.max(0, Math.min(300, Number(e.target.value) || 0)))}/></label><label>Serious loss (cp) <input type="number" min="50" max="500" value={sharpSerious} onChange={e => setSharpSerious(Math.max(50, Math.min(500, Number(e.target.value) || 150)))}/></label></details></div></details></div>

          <div><div className="engine-results" aria-busy={loadingEngine}>{board.isCheckmate() ? <p role="status">Checkmate · {board.turn() === 'w' ? 'Black' : 'White'} wins</p> : board.isStalemate() ? <p role="status">Draw by stalemate</p> : displayedEngine.length ? <><div className="big-score">{score(displayedEngine[0], fen)}</div><StockfishPlans speed={speed} fen={fen} lines={displayedEngine} score={entry => score(entry, fen)} onPreview={setEnginePlanPreview} searching={loadingEngine} depth={engineDepth}/></> : <p className="empty-note">{personalSelected && !personalAnalysis ? 'Select Analyze position to start Stockfish.' : loadingEngine ? 'Analyzing position…' : 'Engine analysis unavailable.'}</p>}</div>
          <details className="sharpness-block"><summary>Position sharpness</summary>{shownSharpness ? <><div className="sharp-summary">{(['white', 'black'] as const).map(color => { const decision = shownSharpness[color]; return <span key={color}>{color === 'white' ? 'White' : 'Black'}: {decision ? `${decision.score}${decision.preliminary ? "" : ` — ${sharpnessLabel(decision.score)}`} · ${decision.evaluated}/${decision.legal} moves evaluated${decision.preliminary || shownSharpness[color + 'Projected' as 'whiteProjected' | 'blackProjected'] ? ' · Preliminary' : ''}${shownSharpness[color + 'Projected' as 'whiteProjected' | 'blackProjected'] ? ' projection' : ''}` : 'Unavailable'}</span> })}</div><p className="sharp-caption">{shownDeepSharpness ? 'Deep analysis' : 'Fast estimate · Preliminary'}</p>{shownDeepSharpness && <details className="sharp-details"><summary>Analysis details</summary>{(['white', 'black'] as const).map(color => { const decision = shownSharpness[color]; return decision && <p key={color}><strong>{color === 'white' ? 'White' : 'Black'}:</strong> {decision.acceptable} of {decision.evaluated} evaluated moves acceptable · {decision.legal} legal · {decision.serious} serious losses.</p> })}</details>}</> : <p className="sharp-caption" role="status">{fastRunning || sharpRunning ? 'Analyzing sharpness…' : 'Sharpness unavailable'}</p>}{sharpRunning && <p className="sharp-caption" role="status">{sharpProgress}</p>}</details>
          </div>
          <div className="stockfish-explore"><button type="button" aria-expanded={advancedPlannerOpen} onClick={() => { setAdvancedPlannerOpen(open => !open); setPlanPreview(null) }}>{advancedPlannerOpen ? "Close deeper planning" : "Explore deeper plans"}</button>{advancedPlannerOpen && (practice || memory) && <label><input type="checkbox" aria-label="Auto plans during practice" checked={practiceAutoPlans} onChange={togglePracticeAutoPlans}/> Auto plans during practice</label>}</div>
          {plannerEnabled && <div className="analysis-plans"><Suspense fallback={<p>Loading plans…</p>}><Profile id="planner"><Planner fen={fen} depth={engineDepth} delayMs={practice || memory ? 700 : 350} history={followingLine ? { startFen: followingLine.startFen, moves: followingLine.moves.slice(0, positionIndex).map(move => move.uci) } : { startFen: manual[0], moves: manualMoves.slice(0, manualIndex) }} rootAnalysis={localEngine} onPreview={setPlanPreview}/></Profile></Suspense></div>}
          {advancedPlannerOpen && !plannerEnabled && <p className="empty-note">{generating ? "Deeper planning is available when analysis is idle." : "Turn on Auto plans for this practice position."}</p>}
        </>}</section>
        </div></section>
        <PersonalGames onOpen={openPersonalGame} active={personalGame} revision={personalRevision}/><section className="analysis-slot slot-explorer" aria-label="Lichess Explorer"><button type="button" className="analysis-slot-toggle" aria-expanded={sections.explorer} onClick={()=>toggleSection('explorer')}><span>Lichess Explorer</span><span aria-hidden="true">{sections.explorer ? '▾' : '▸'}</span></button><div className="analysis-slot-body" hidden={!sections.explorer}>
        <section className="learn-panel learn-explorer" aria-label="Opening Explorer">
          {explorerHidden ? <p className="empty-note">Opening Explorer hidden during recall. <button onClick={() => revealAnalysis('explorer')}>Reveal Explorer</button></p> : <>
            <div className="explorer-filters">
              <select aria-label="Database" value={database} onChange={e => setDatabase(e.target.value as 'lichess' | 'masters')}><option value="lichess">Lichess games</option><option value="masters">Masters games</option></select>
              {database === 'lichess' && <>
                {ratingFilter}
                <select aria-label="Time controls" value={filters.speeds.join(',')} onChange={e => setFilters(old => ({ ...old, speeds: e.target.value.split(',') }))}><option value="bullet,blitz">Bullet + Blitz</option><option value="blitz,rapid,classical">Blitz + Rapid + Classical</option><option value="rapid,classical">Rapid + Classical</option></select>
              </>}
            </div>
            <div className="explorer-controls">
              <button className="explorer-connect" onClick={() => { if (lichessConnected && !data?.unavailableReason?.includes('HTTP 401')) { disconnectLichess(); setLichessConnected(false); setAuthRevision(value => value + 1) } else connectLichess().catch(error => setError(error.message)) }}>{lichessConnected && !data?.unavailableReason?.includes('HTTP 401') ? 'Disconnect Lichess' : lichessConnected ? 'Reconnect Lichess' : 'Connect Lichess'}</button>
              <div className="perspective-toggle" role="group" aria-label="Explorer perspective">
                {(['white', 'black', 'both'] as const).map(value => <button key={value} aria-pressed={explorerPerspective === value} onClick={() => setExplorerPerspective(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
              </div>
              <select aria-label="Sort explorer moves" value={explorerSort} onChange={e => setExplorerSort(e.target.value as ExplorerSort)}>
                <option value="played">Most played</option><option value="white">White win rate</option><option value="black">Black win rate</option><option value="draws">Draw rate</option>
              </select>
            </div>
            <div className="explorer-side-to-move">{fen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move <span>· historical results after each move</span></div>
            {data?.cache && <p className="explorer-cache-label">{data.source === 'masters' ? 'Masters' : 'Lichess'} {data.cache.state === 'live' || data.cache.state === 'refreshed' ? 'refreshed' : data.cache.state === 'cached' ? 'cached' : 'stale'} · retrieved {new Date(data.cache.retrievedAt).toLocaleDateString()}</p>}
            {data?.source === 'book' && <p className="fallback-note">{data.unavailableReason || 'Live Explorer data unavailable.'} Published lines have no game counts or frequencies.</p>}
            <div className="explorer-total">{data && data.source !== 'book' && total(data) ? <>{format(total(data))} games · <OutcomeSummary move={data} perspective={explorerPerspective}/></> : 'No game statistics'}</div>
            <div className="explorer-columns"><span>Move</span><span>Freq.</span><span>Games</span><span>Results</span></div>
            <div className="human-moves" aria-busy={loadingData}>
              {loadingData && <p className="empty-note" role="status">Loading moves…</p>}
              {explorerMoves.map(move => <div className="explorer-move-row" key={move.uci}><button className="explorer-move-button" onClick={() => playMove(move.uci)}>
                <strong>{move.san}</strong>
                <span className="move-share">{data?.source === 'book' || !data || !total(data) || results(move) === null ? '—' : Math.round(frequency(move, data) * 100) + '%'}</span>
                <span className="move-games">{data?.source === 'book' || results(move) === null ? '—' : format(results(move)!)}</span>
                {data?.source === 'book' ? <span className="no-results">Published line · no statistics</span> : <span className="explorer-results"><ResultBar move={move}/><OutcomeSummary move={move} perspective={explorerPerspective}/></span>}
              </button><div className="explorer-row-action"><button aria-label={`Options for ${move.san}`} aria-expanded={explorerAction === move.uci} aria-haspopup="menu" title={`Options for ${move.san}`} onClick={() => setExplorerAction(explorerAction === move.uci ? null : move.uci)}>⋯</button>{explorerAction === move.uci && <div className="explorer-action-menu" role="menu"><button role="menuitem" disabled={generating || !!memory || fen.split(' ')[1] !== (side === 'white' ? 'w' : 'b')} title={fen.split(' ')[1] !== (side === 'white' ? 'w' : 'b') ? 'Select your side to move before excluding' : undefined} onClick={() => toggleExplorerExclusion(move.uci)}>{currentExclusions.includes(move.uci) ? 'Allow in generation' : 'Exclude from generation'}</button></div>}</div></div>)}
              {!loadingData && !explorerMoves.length && <p className="empty-note">{data && data.source !== 'book' && total(data) === 0 ? `No ${database === 'masters' ? 'Masters' : 'Lichess'} games match this position and filters. Try an earlier move or broader filters.` : 'No continuation is available for this position.'}</p>}
            </div>
            <p className="explorer-sample-note">Win rates describe past games, not move quality. Compare game counts; Stockfish assesses soundness separately.</p>
          </>}
        </section>
        </div></section>
        </aside>
      </div>
    </main>}
  </div>
}
