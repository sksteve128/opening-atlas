import { createExploration } from './exploreVariations'
import { aggressiveCandidate } from './aggressiveGeneration'
import { selectCastlingMove, castlingSummary } from './castlingPreference'
import { positions } from './gameAnalysis'
import { Chess } from 'chess.js'
import { frequency, identity, isMyTurn, nextFen, total, type ExplorerData, type Side } from './core'
import type { Evaluation } from './engine'
import type { Filters } from './data'
import { assessDecision, type SharpnessResult } from './sharpness'
import type { SavedGameAnalysis } from './gameAnalysis'
import { styledCandidate, styleNeedsVerification } from './generationStyle'

export type OpponentModel = 'lichess-stockfish' | 'stockfish' | 'maia' | 'lichess' | 'hybrid'
export type LineMove = { selectionAnalysis?: { requestedDepth: number; achievedDepth: number; preliminary: boolean }; explorerCache?: ExplorerData['cache']; exploration?: import('./exploreVariations').ExplorationDecision; aggressive?: import('./aggressiveGeneration').AggressiveDecision; castling?: import('./castlingPreference').CastlingDecision; openingChoice?: boolean; style?: { score: number; lossCp: number; verifiedDepth: number }; restriction?: { excluded: string[]; bestOverall: string; overallCp: number; overallDepth: number; lossCp?: number };  prediction?: Omit<import('./humanModel').HumanPrediction, 'moves'> & { probability: number }; population?: import('./humanPopulation').Population; engineFallback?: boolean; sampling?: { probability: number; omittedMass: number; eligibleGames: number; policy: 'simulation' | 'expansion' }; uci: string; san: string; source: 'preset' | 'engine' | 'lichess' | 'masters' | 'book' | 'import' | 'tablebase' | 'model'; games?: number; frequency?: number; cp?: number; depth?: number; alternatives?: string[] }
export type GenerationMode = 'advantage' | 'mainline' | 'advanced' | 'complete' | 'strong' | 'human'
export type Recommendation = { adaptiveLength?: { initialPlies: number; maximumPlies: number; extendedPlies: number }; randomDraws?: number; conversion?: import('./conversion').ConversionEvidence; populationAttempts?: (import('./humanPopulation').PopulationAttempt & { ply: number })[]; runtimeMs?: number; policy?: 'simple'; evaluationPly?: number; evaluationSensitivityCp?: number; verifiedMoves?: number; verificationScope?: 'adaptive' | 'deep'; preliminary?: boolean; performance?: { searchDetails?: (import('./engine').SearchInfo & { phase: string })[]; phases: Record<string, number>; searches: number; engineCacheHits: number; sharpnessCacheHits: number }; stopKind?: 'cancelled' | 'length' | 'budget' | 'human-data' | 'advantage' | 'terminal' | 'engine-timeout' | 'verification'; sampledPlies?: number; scoring?: 'complete' | 'partial' | 'budget-exhausted'; ranking?: string; verification: 'pending' | 'passed' | 'failed'; depth?: number; objectiveCp?: number; humanExpectedCp?: number; humanCoverage?: number; userDifficulty?: number; opponentDifficulty?: number; asymmetry?: number; objectiveStabilityCp?: number; practicalChoices?: number; tacticalFragility?: number; criticalPoints?: number; sacrificeCp?: number; alternatives?: { firstMove: string; score?: number; scoring?: Recommendation['scoring']; sampledPlies?: number; objectiveCp?: number; verified: boolean }[]; score?: number; reason?: string; configuration?: { candidateDepth: number; discoveryDepth?: number; verificationDepth: number; timeoutMs: number } }
export type HumanEvidence = { seed: number; policy: 'simulation' | 'expansion'; minPositionGames: number; minMoveGames: number; status: string; stopReason: string; decisions: { fen: string; move: string; coverage: number; lower: number; upper: number; utility?: number }[]; repair?: string }
export type Variation = { generationSettings?: Omit<Generation, 'resume' | 'prefix'> & { startPly: number }; opponentTransition?: { ply: number; reason: string; issue?: import('./humanPopulation').PopulationAttempt['issue'] };  opponentModel?: OpponentModel; generationState?: 'running' | 'complete' | 'stopped'; sourceGame?: import('./personalGames').GameOrigin; exploration?: import('./exploreVariations').ExplorationSettings & { seed: number }; aggressive?: import('./aggressiveGeneration').AggressiveOptions; castlingPreference?: import('./castlingPreference').CastlingPreference; castlingToleranceCp?: number; castlingOutcome?: 'satisfied' | 'not reached' | 'unavailable — castling rights lost'; style?: import('./generationStyle').GenerationStyle; styleToleranceCp?: number; exclusions?: import('./moveExclusions').MoveExclusions; freshOpening?: boolean; tablebase?: TablebaseOutcome; openingId?: string; branch?: import('./openingTree').Branch; human?: HumanEvidence; id: string; opening: string; name: string; customName?: string; parentId?: string; startFen: string; moves: LineMove[]; pgn: string; side: Side; sideUnconfirmed?: boolean; database: 'lichess' | 'masters'; filters: Filters; created: number; lastPracticed?: number; stats: { firstTry: number; errors: number; reveals: number; completions: number; totalMs: number }; endPosition: string; fallback: boolean; imported?: boolean; status?: 'complete' | 'incomplete' | 'favorable' | 'instructional'; result?: '1-0' | '0-1' | '1/2-1/2'; termination?: string; generationMode?: GenerationMode; advantageCp?: number; engineFallback?: boolean; engineConfig?: { depth: number; timeoutMs: number }; recommendation?: Recommendation; analysis?: SavedGameAnalysis }
export type Generation = { opponentModel?: OpponentModel; sourceGame?: import('./personalGames').GameOrigin; exploration?: import('./exploreVariations').ExplorationSettings; explorationBatchSeed?: number; aggressive?: import('./aggressiveGeneration').AggressiveOptions; batchIndex?: number; batchAttempt?: number; castlingPreference?: import('./castlingPreference').CastlingPreference; castlingToleranceCp?: number; style?: import('./generationStyle').GenerationStyle; styleToleranceCp?: number; initialPlies?: number; exclusions?: import('./moveExclusions').MoveExclusions; freshOpening?: boolean;  conversionMinPlies?: number; conversionMaxDifficulty?: number; mastersFallback?: boolean; targetRating?: number; modelBudgetMs?: number; limitedHumanData?: 'stop' | 'sparse' | 'engine'; humanPolicy?: 'simulation' | 'expansion'; seed?: number; minPositionGames?: number; minMoveGames?: number; opening: string; startFen: string; prefix: LineMove[]; side: Side; database: 'lichess' | 'masters'; filters: Filters; maxPlies: number; maxMs?: number; engineDepth: number; discoveryDepth?: number; verificationDepth?: number; engineTimeoutMs?: number; tolerance: number; mode: 'main' | 'next' | 'here'; playMode?: GenerationMode; advantageCp?: number; engineFallback?: boolean; resume?: Variation; rootFen?: string; excludeRootMoves?: string[]; parentId?: string; sharpnessPreference?: 'balanced' | 'critical'; stabilityPreference?: 'strict' | 'balanced' }
export type Tablebase = { category: string; dtz?: number | null; moves: { uci: string; san: string; category: string; dtm?: number | null; dtz?: number | null }[] }
export type TablebaseOutcome = { label: 'Tablebase win' | 'Tablebase loss' | 'Tablebase draw'; winner: Side | null; category: string }
export type Sources = { patricia?: import('./aggressiveGeneration').PatriciaProvider; humanModel?: import('./humanModel').HumanModelProvider; onTiming?: (phase: string, ms: number) => void; cached?: (fen: string, count: number, depth: number) => Evaluation[] | undefined; fastSharpness?: (fen: string) => SharpnessResult | undefined; onCacheHit?: (source: 'engine' | 'explorer') => void; explorer: (fen: string, filters: Filters, signal: AbortSignal | undefined, database: 'lichess' | 'masters') => Promise<ExplorerData>; analyze: (fen: string, count: number, depth: number, signal?: AbortSignal, timeoutMs?: number, refresh?: boolean, searchMoves?: string[]) => Promise<Evaluation[]>; tablebase?: (fen: string, signal?: AbortSignal) => Promise<Tablebase> }

export function lineFen(line: Pick<Variation, 'startFen' | 'moves'>, count = line.moves.length) {
  // Match Array.slice's existing handling of negative and oversized counts.
  const end = count < 0 ? Math.max(0, line.moves.length + count) : Math.min(count, line.moves.length)
  return positions(line)[end]
}

export function nextLineIndex(line: Pick<Variation, 'moves'>, index: number, uci: string) {
  return line.moves[index]?.uci === uci ? index + 1 : null
}

export const reviewPosition = (requested: number, reached: number) => Math.max(0, Math.min(reached, requested))
// Replay already-practiced moves without scoring them again or revealing new moves.
export function reviewMoveIndex(line: Pick<Variation, 'startFen' | 'moves' | 'side'>, at: number, reached: number, uci: string) {
  const next = nextLineIndex(line, at, uci)
  if (next === null || next > reached) return null
  const opponent = lineFen(line, next).split(' ')[1] !== (line.side === 'white' ? 'w' : 'b')
  return Math.min(reached, next + Number(opponent && next < line.moves.length))
}

export const waitingForGeneratedMove = (index: number, available: number, generating: boolean, following: boolean) => following && generating && index >= available

export function phaseStarts(line: Pick<Variation, 'startFen' | 'moves'>) {
  const game = new Chess(line.startFen)
  let middle: number | undefined, end: number | undefined
  for (let index = 0; index <= line.moves.length; index++) {
    const pieces = game.board().flat().filter(piece => piece !== null)
    const homeMinor = ['b1', 'c1', 'f1', 'g1', 'b8', 'c8', 'f8', 'g8'].filter(square => {
      const piece = game.get(square as import('chess.js').Square)
      return piece?.type === 'n' || piece?.type === 'b'
    }).length
    if (middle === undefined && homeMinor <= 4) middle = index
    if (end === undefined && (pieces.filter(piece => piece.type === 'q').length === 0 || pieces.filter(piece => piece.type !== 'p' && piece.type !== 'k').length <= 8)) end = index
    if (index < line.moves.length) { const move = line.moves[index]; game.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] }) }
  }
  return { opening: 0, middle, end }
}

export function moveNumber(fen: string, san: string) {
  const [, turn, , , , fullmove] = fen.split(' ')
  return `${fullmove}${turn === 'w' ? '.' : '...'}${san}`
}

export function modelFallbackReason(line: Variation, ply: number) {
  const attempts = line.recommendation?.populationAttempts?.filter(attempt => attempt.ply === ply)
  if (!attempts?.length) return 'reason unavailable in saved record'
  const failure = attempts.find(attempt => attempt.error)
  if (failure) return failure.issue === 'rate-limit' ? 'Explorer rate limited' : failure.issue === 'authentication' ? 'Explorer access denied' : failure.issue === 'timeout' ? 'Explorer timed out' : failure.issue === 'malformed' ? 'Explorer response malformed' : `Explorer unavailable: ${failure.error}`
  return attempts.every(attempt => attempt.issue === 'zero-games') ? 'no recorded games in checked populations' : 'human game coverage below configured threshold'
}

export function describeLineMove(fen: string, move: LineMove, side: Side) {
  const played = new Chess(fen).move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] })
  const name = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[played.piece]
  const promotionNames: Record<string, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }
  const actor = isMyTurn(fen, side) ? 'Play' : `${fen.split(' ')[1] === 'w' ? 'White' : 'Black'} plays`
  const detail = played.flags.includes('k') ? 'Castle kingside.' : played.flags.includes('q') ? 'Castle queenside.' : played.promotion ? `Move the pawn from ${played.from} to ${played.to} and promote to a ${promotionNames[played.promotion]}.` : played.captured ? `Capture on ${played.to} with the ${name} from ${played.from}.` : `Move the ${name} from ${played.from} to ${played.to}.`
  return { title: `${actor} ${moveNumber(fen, played.san)}`, detail }
}

export function saveVariation(lines: Variation[], candidate: Variation) {
  const signature = (line: Variation) => `${line.opponentModel || 'legacy'}|${line.sideUnconfirmed ? '?' : line.side}|${identity(line.startFen)}|${line.moves.map(move => move.uci).join(',')}`
  return lines.some(line => signature(line) === signature(candidate)) ? lines : [...lines, candidate]
}

export function restoreTrainingSide(line: Variation): Variation {
  return line.side === 'white' || line.side === 'black' ? line : { ...line, side: 'white', sideUnconfirmed: true }
}

export function continuationsAt(lines: Variation[], fen: string, preferredId?: string | null, side?: Side) {
  const key = identity(fen), covered = new Set<string>()
  let parentId: string | undefined
  for (const line of lines) {
    if (line.sideUnconfirmed || side && line.side !== side) continue
    let fens: string[]
    try { fens = positions(line) } catch { continue }
    for (let ply = 0; ply < fens.length; ply++) {
      // These FENs came from chess.js, which already normalizes legal en passant.
      if (fens[ply].split(' ').slice(0, 4).join(' ') !== key) continue
      parentId ??= line.id
      if (line.moves[ply]) covered.add(line.moves[ply].uci)
    }
  }
  if (preferredId && lines.some(line => line.id === preferredId && !line.sideUnconfirmed && (!side || line.side === side))) parentId = preferredId
  return { covered: [...covered], parentId }
}

export function restoreActiveLine(lines: Variation[], snapshot: Variation | null, id: string | null) {
  if (!snapshot || snapshot.id !== id) return lines
  const index = lines.findIndex(line => line.id === id)
  if (index < 0) return [...lines, snapshot]
  const saved = lines[index]
  // Reload snapshots can lag behind the final server result at the same ply.
  const progressing = (line: Variation) => /^(Generating|Converting advantage)\.\.\.$/.test(line.termination || '')
  if (saved.moves.length > snapshot.moves.length ||
    (saved.moves.length === snapshot.moves.length && (
      (progressing(snapshot) && !progressing(saved)) ||
      (saved.recommendation?.runtimeMs ?? 0) > (snapshot.recommendation?.runtimeMs ?? 0)
    ))) return lines
  return lines.map((line, position) => position === index ? snapshot : line)
}

async function nextBranch(options: Generation, lines: Variation[], sources: Sources, signal?: AbortSignal) {
  let best: { prefix: LineMove[]; parentId: string; fen: string; move: LineMove; score: number } | undefined
  const relevant = lines.filter(line => line.opening === options.opening && line.side === options.side && line.database === options.database)
  const coverage = new Map<string, Set<string>>()
  for (const line of relevant) {
    let position = line.startFen
    for (const move of line.moves) {
      const key = identity(position)
      if (!coverage.has(key)) coverage.set(key, new Set())
      coverage.get(key)!.add(move.uci)
      position = nextFen(position, move.uci)
    }
  }
  for (const line of relevant) {
    let fen = line.startFen
    for (let index = 0; index < Math.min(line.moves.length, 30); index++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      if (index >= options.prefix.length && !isMyTurn(fen, options.side)) {
        let data: ExplorerData
        try { data = await sources.explorer(fen, options.filters, signal, options.database) }
        catch (error) { if (signal?.aborted) throw error; data = { white: 0, draws: 0, black: 0, moves: [], source: 'book' } }
        const covered = coverage.get(identity(fen)) || new Set<string>()
        const legalMoves = new Chess(fen).moves({ verbose: true })
        const candidates = (options.playMode === 'advantage' || options.playMode === 'mainline') && (data.source === 'book' || total(data) < 20) ? [] : [...data.moves]
        for (const uci of line.moves[index].alternatives || []) {
          if (!candidates.some(move => move.uci === uci)) {
            const legal = legalMoves.find(move => move.from + move.to + (move.promotion || '') === uci)
            if (legal) candidates.push({ uci, san: legal.san, white: 0, draws: 0, black: 0 })
          }
        }
        for (const move of candidates) {
          if (covered.has(move.uci)) continue
          const games = move.white + move.draws + move.black
          if ((options.playMode === 'advantage' || options.playMode === 'mainline') && games < 5) continue
          if ((options.playMode === 'complete' || options.playMode === 'strong' || !options.playMode) && line.moves[index].alternatives?.length && !line.moves[index].alternatives?.includes(move.uci)) continue
          const share = data.source === 'book' || !games ? 0 : frequency(move, data)
          const tactical = legalMoves.some(legal => legal.from + legal.to + (legal.promotion || '') === move.uci && (legal.captured || legal.san.includes('+') || legal.san.includes('#'))) ? 0.03 : 0
          const score = (share + (line.moves[index].alternatives?.includes(move.uci) ? 0.15 : 0.01) + tactical) / (index + 1)
          if (!best || score > best.score) best = { prefix: line.moves.slice(0, index), parentId: line.id, fen, move: { uci: move.uci, san: move.san, source: games && data.source !== 'book' ? data.source || options.database : 'engine', games: games || undefined, frequency: share || undefined }, score }
        }
      }
      fen = nextFen(fen, line.moves[index].uci)
    }
  }
  return best
}

export function terminal(game: Chess, repetitions: number) {
  if (game.isCheckmate()) return { result: game.turn() === 'w' ? '0-1' : '1-0', reason: 'Checkmate' } as const
  if (game.isStalemate()) return { result: '1/2-1/2', reason: 'Stalemate' } as const
  if (game.isInsufficientMaterial()) return { result: '1/2-1/2', reason: 'Insufficient material' } as const
  if (repetitions >= 5) return { result: '1/2-1/2', reason: 'Fivefold repetition' } as const
  const halfmoves = Number(game.fen().split(' ')[4])
  if (halfmoves >= 150) return { result: '1/2-1/2', reason: 'Seventy-five-move rule' } as const
  if (repetitions >= 3) return { result: '1/2-1/2', reason: 'Threefold repetition claimed' } as const
  if (halfmoves >= 100) return { result: '1/2-1/2', reason: 'Fifty-move draw claimed' } as const
  return null
}

export const tablebaseSupported = (fen: string) => {
  const [board, , castling] = fen.split(' ')
  // Complete seven-piece Syzygy only; castling rights are outside its domain.
  return castling === '-' && (board.match(/[prnbqk]/gi) || []).length <= 7
}
export function tablebaseOutcome(fen: string, data: Tablebase, side: Side): TablebaseOutcome | undefined {
  const category = data.category
  if (!['win', 'loss', 'draw', 'cursed-win', 'blessed-loss'].includes(category)) return undefined
  const toMove = fen.split(' ')[1] === 'w' ? 'white' : 'black'
  const winner = category === 'win' ? toMove : category === 'loss' ? toMove === 'white' ? 'black' : 'white' : null
  return { category, winner, label: winner === null ? 'Tablebase draw' : winner === side ? 'Tablebase win' : 'Tablebase loss' }
}
const tablebaseCache = new Map<string, Tablebase>()
let tablebaseRetryAt = 0
export async function lookupTablebase(fen: string, signal?: AbortSignal): Promise<Tablebase> {
  if (!tablebaseSupported(fen)) throw new Error('Unsupported tablebase position')
  const key = fen.split(' ').slice(0, 5).join(' '), cached = tablebaseCache.get(key)
  if (cached) return cached
  if (Date.now() < tablebaseRetryAt) throw new Error('Tablebase rate limited')
  const response = await fetch(`https://tablebase.lichess.org/standard?fen=${encodeURIComponent(fen)}`, { signal })
  if (response.status === 429) {
    const retrySeconds = Number(response.headers.get('Retry-After'))
    tablebaseRetryAt = Date.now() + (Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : 60000)
  }
  if (!response.ok) throw new Error(`Tablebase unavailable (${response.status})`)
  const result: unknown = await response.json()
  if (!result || typeof result !== 'object' || !('category' in result) || typeof result.category !== 'string' || !('moves' in result) || !Array.isArray(result.moves)) throw new Error('Invalid tablebase response')
  tablebaseCache.set(key, result as Tablebase)
  if (tablebaseCache.size > 100) tablebaseCache.delete(tablebaseCache.keys().next().value!)
  return result as Tablebase
}

export async function generateVariation(options: Generation, lines: Variation[], sources: Sources, signal?: AbortSignal, onProgress?: (line: Variation) => void): Promise<Variation> {
  const explore = createExploration(options, lines, options.seed ?? options.resume?.exploration?.seed ?? (options.exploration?.mode === 'explore' ? crypto.getRandomValues(new Uint32Array(1))[0] : 0))
  if (options.rootFen) {
    const root = new Chess(options.startFen)
    for (const move of options.prefix) root.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] })
    if (identity(root.fen()) !== identity(options.rootFen)) throw new Error('Displayed board and move history disagree; generation stopped.')
  }
  if (options.playMode === 'advantage' || options.playMode === 'mainline') return generateHumanVariation(options, lines, sources, signal, onProgress)
  const branch = !options.resume && options.mode === 'next' ? await nextBranch(options, lines, sources, signal) : undefined
  if (options.mode === 'next' && !options.resume && lines.some(line => line.opening === options.opening) && !branch) throw new Error('No uncovered opponent continuation is available in the loaded opening data.')
  const parent = branch && lines.find(line => line.id === branch.parentId)
  const startFen = options.resume?.startFen || parent?.startFen || options.startFen
  const moves = [...(options.resume?.moves || (branch ? [...branch.prefix, branch.move] : options.prefix))]
  const game = new Chess(startFen)
  const positions = new Map<string, number>()
  const record = () => { const key = identity(game.fen()); positions.set(key, (positions.get(key) || 0) + 1) }
  record()
  for (const move of moves) { game.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] }); record() }
  const id = options.resume?.id || crypto.randomUUID()
  const created = options.resume?.created || Date.now()
  const stats = options.resume?.stats || { firstTry: 0, errors: 0, reveals: 0, completions: 0, totalMs: 0 }
  let openingName = options.resume?.name || options.opening
  let fallback = options.resume?.fallback || moves.some(move => move.source === 'book')
  let reason = 'Move budget reached'
  const deadline = Date.now() + (options.maxMs ?? 180000)
  const cache = new Map<string, Evaluation[]>()
  let tablebase: TablebaseOutcome | undefined
  const snapshot = (status: 'complete' | 'incomplete' | 'instructional', result?: '1-0' | '0-1' | '1/2-1/2', termination?: string): Variation => {
    game.setHeader('Result', result || '*')
    const first = moves[options.prefix.length]
    const name = options.resume?.name || (branch ? `${options.opening} — ${moveNumber(branch.fen, branch.move.san)} sideline` : openingName !== options.opening ? openingName : `${options.opening} — ${first ? moveNumber(options.rootFen || options.startFen, first.san) : 'continuation'}`)
    return { ...explore.metadata, ...castlingSummary(options, moves), id, opening: options.opening, name, customName: options.resume?.customName, parentId: options.resume?.parentId || branch?.parentId || options.parentId, startFen, moves: [...moves], pgn: game.pgn(), side: options.side, database: options.database, filters: options.filters, created, lastPracticed: options.resume?.lastPracticed, stats, endPosition: identity(game.fen()), fallback, status, result, termination, tablebase, aggressive: options.aggressive, style: options.style ?? 'best', styleToleranceCp: options.styleToleranceCp ?? 30, generationMode: options.playMode || 'complete', engineConfig: { depth: options.engineDepth, timeoutMs: options.engineTimeoutMs || 25000 } }
  }
  onProgress?.(snapshot('incomplete', undefined, 'Generating'))
  for (let step = 0; step < options.maxPlies; step++) {
    const ended = terminal(game, positions.get(identity(game.fen())) || 1)
    if (ended) return snapshot('complete', ended.result, ended.reason)
    if (signal?.aborted) { reason = 'Cancelled'; break }
    if (Date.now() >= deadline) { reason = 'Time budget reached'; break }
    const fen = game.fen()
    let selected: LineMove | undefined
    if (sources.tablebase && tablebaseSupported(fen)) {
      try {
        tablebase = tablebaseOutcome(fen, await sources.tablebase(fen, signal), options.side)
        if (tablebase) return snapshot('instructional', undefined, `${tablebase.label}${tablebase.winner ? ` — ${tablebase.winner === 'white' ? 'White' : 'Black'} wins` : ' — theoretical draw'}.`)
      } catch (error) { if (signal?.aborted) { reason = 'Cancelled'; break } }
    }
    let data: ExplorerData | undefined
    if (!selected && moves.length < 30) {
      try { data = await sources.explorer(fen, options.filters, signal, options.database); fallback ||= data.source === 'book'; if (data.opening?.name) openingName = data.opening.name }
      catch (error) { if (signal?.aborted) { reason = 'Cancelled'; break } }
    }
    if (!selected && options.playMode === 'human' && !isMyTurn(fen, options.side) && data && data.source !== 'book' && total(data) >= 20) {
      const human = [...data.moves].filter(move => move.white + move.draws + move.black >= 5 && game.moves({ verbose: true }).some(legal => legal.from + legal.to + (legal.promotion || '') === move.uci)).sort((a, b) => (b.white + b.draws + b.black) - (a.white + a.draws + a.black) || a.uci.localeCompare(b.uci))[0]
      if (human) selected = { uci: human.uci, san: human.san, source: data.source || options.database, games: human.white + human.draws + human.black, frequency: frequency(human, data) }
    }
    if (!selected) {
      try {
        let analysis = cache.get(fen)
        if (!analysis) { analysis = await sources.analyze(fen, 4, options.engineDepth, signal, Math.min(options.engineTimeoutMs || 25000, Math.max(1, deadline - Date.now()))); cache.set(fen, analysis) }
        const legal = new Set(game.moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || '')))
        const sound = analysis.filter(entry => entry.line[0] && legal.has(entry.line[0]) && entry.depth >= options.engineDepth && !entry.search?.stoppedByBudget && !(step === 0 && options.excludeRootMoves?.includes(entry.line[0])))
        const best = sound[0]
        if (!best) { reason = options.excludeRootMoves?.length && step === 0 ? 'No uncovered continuation was verified from this position.' : 'Stockfish produced no verified legal move'; break }
        const ranked = options.playMode === 'human' && isMyTurn(fen, options.side) && data?.source !== 'book' ? sound.filter(entry => best.cp - entry.cp <= options.tolerance).sort((a, b) => {
          const aHuman = data?.moves.find(move => move.uci === a.line[0]), bHuman = data?.moves.find(move => move.uci === b.line[0])
          return (bHuman && data ? frequency(bHuman, data) : 0) - (aHuman && data ? frequency(aHuman, data) : 0) || b.cp - a.cp || a.line[0].localeCompare(b.line[0])
        }) : sound
        let chosen = ranked[0] || best
        let style: LineMove['style'], aggressive: LineMove['aggressive']
        if (options.style === 'aggressive' && options.aggressive && isMyTurn(fen, options.side)) {
          const result = await aggressiveCandidate(fen, chosen, options, sources, [...legal].filter(move => !(step === 0 && options.excludeRootMoves?.includes(move))), deadline, signal)
          chosen = result.entry; aggressive = result.decision
        } else if (options.style && options.style !== 'best' && isMyTurn(fen, options.side)) {
          const choice = styledCandidate(fen, sound, options.style, options.styleToleranceCp ?? 30, [...legal])
          if (choice && choice.entry.line[0] !== chosen.line[0]) {
            try {
              const timeout = Math.min(options.engineTimeoutMs || 25000, Math.max(1, deadline - Date.now()))
              const alternative = (await sources.analyze(fen, 1, options.engineDepth, signal, timeout, false, [choice.entry.line[0]]))[0]
              const move = game.moves({ verbose: true }).find(item => item.from + item.to + (item.promotion || '') === choice.entry.line[0])!
              let baseline = best, verified = alternative
              if (move.captured || move.promotion || /[+#]/.test(move.san) || styleNeedsVerification(fen, best.line) || styleNeedsVerification(fen, alternative.line)) {
                const deeper = options.engineDepth + 2
                baseline = (await sources.analyze(fen, 1, deeper, signal, timeout))[0]
                verified = (await sources.analyze(fen, 1, deeper, signal, timeout, false, [choice.entry.line[0]]))[0]
              }
              const lossCp = baseline.cp - verified.cp
              if (baseline.depth >= options.engineDepth && verified.depth >= options.engineDepth && baseline.mate === undefined && verified.mate === undefined && Number.isFinite(lossCp) && lossCp <= (options.styleToleranceCp ?? 30)) {
                chosen = verified; style = { score: choice.score, lossCp: Math.max(0, lossCp), verifiedDepth: Math.min(baseline.depth, verified.depth) }
              }
            } catch (error) { if (signal?.aborted) throw error }
          }
        }
        const castle = await selectCastlingMove(fen, chosen, options, (position, count, depth, active, timeout, refresh, restrict) => { if (Date.now() >= deadline) throw new Error('Time budget reached'); return sources.analyze(position, count, depth, active, Math.min(timeout || 25000, Math.max(1, deadline - Date.now())), refresh, restrict) }, signal, analysis, analysis[0], moves)
        if (castle.entry !== chosen) style = undefined
        const explored = castle.decision?.accepted ? { entry: castle.entry, exploration: undefined } : await explore.select(fen, castle.entry, moves, { ...sources, analyze: (position, count, depth, active, timeout, refresh, restrict) => { if (Date.now() >= deadline) throw new Error('Time budget reached'); return sources.analyze(position,count,depth,active,Math.min(timeout || 25000,Math.max(1,deadline-Date.now())),refresh,restrict) } }, signal, analysis)
        if (explored.entry !== castle.entry) style = undefined
        chosen = explored.entry
        if (aggressive && aggressive.selected !== chosen.line[0]) { aggressive.selected = chosen.line[0]; aggressive.rejected = true; aggressive.reason = 'Move selection chose another verified move' }
        const played = game.moves({ verbose: true }).find(move => move.from + move.to + (move.promotion || '') === chosen.line[0])!
        const human = data?.source !== 'book' && data?.moves.find(move => move.uci === chosen.line[0])
        selected = { uci: chosen.line[0], san: played.san, source: 'engine', cp: chosen.cp, depth: chosen.depth, style, aggressive, exploration: explored.exploration, castling: castle.decision, alternatives: sound.filter(entry => entry.line[0] !== chosen.line[0]).map(entry => entry.line[0]), games: human ? human.white + human.draws + human.black : undefined, frequency: human && data ? frequency(human, data) : undefined }
      } catch (error) { reason = signal?.aborted ? 'Cancelled' : `Stockfish unavailable: ${(error as Error).message}`; break }
    }
    game.move({ from: selected.uci.slice(0, 2), to: selected.uci.slice(2, 4), promotion: selected.uci[4] })
    moves.push(selected)
    record()
    onProgress?.(snapshot('incomplete', undefined, 'Generating'))
  }
  const ended = terminal(game, positions.get(identity(game.fen())) || 1)
  if (!ended && sources.tablebase && tablebaseSupported(game.fen())) {
    try {
      tablebase = tablebaseOutcome(game.fen(), await sources.tablebase(game.fen(), signal), options.side)
      if (tablebase) return snapshot('instructional', undefined, `${tablebase.label}${tablebase.winner ? ` — ${tablebase.winner === 'white' ? 'White' : 'Black'} wins` : ' — theoretical draw'}.`)
    } catch { /* Offline or unsupported positions retain the existing stopping policy. */ }
  }
  return ended ? snapshot('complete', ended.result, ended.reason) : snapshot('incomplete', undefined, reason)
}

async function generateHumanVariation(options: Generation, lines: Variation[], sources: Sources, signal?: AbortSignal, onProgress?: (line: Variation) => void): Promise<Variation> {
  const branch = !options.resume && options.mode === 'next' ? await nextBranch(options, lines, sources, signal) : undefined
  if (options.mode === 'next' && !options.resume && lines.some(line => line.opening === options.opening) && !branch) throw new Error('No uncovered human opponent move is available in the loaded game data.')
  const parent = branch && lines.find(line => line.id === branch.parentId)
  const startFen = options.resume?.startFen || parent?.startFen || options.startFen
  const moves = [...(options.resume?.moves || (branch ? [...branch.prefix, branch.move] : options.prefix))]
  const game = new Chess(startFen)
  const positions = new Map<string, number>()
  const record = () => { const key = identity(game.fen()); positions.set(key, (positions.get(key) || 0) + 1) }
  record()
  for (const move of moves) { game.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] }); record() }
  const id = options.resume?.id || crypto.randomUUID()
  const created = options.resume?.created || Date.now()
  const stats = options.resume?.stats || { firstTry: 0, errors: 0, reveals: 0, completions: 0, totalMs: 0 }
  const target = options.advantageCp ?? 150
  const moveLimit = options.maxPlies + (options.rootFen || options.resume ? moves.length : 0)
  const deadline = Date.now() + (options.maxMs ?? 180000)
  const cache = new Map<string, Evaluation[]>()
  let fallback = options.resume?.fallback || moves.some(move => move.source === 'book')
  let missingHumanData = false, engineOnlyMove = false
  let openingName = options.resume?.name || options.opening
  let lastAssessment = ''
  const snapshot = (status: Variation['status'], termination: string, result?: Variation['result']): Variation => {
    game.setHeader('Result', result || '*')
    const first = moves[options.prefix.length]
    const name = options.resume?.name || (branch ? `${options.opening} — ${moveNumber(branch.fen, branch.move.san)} sideline` : openingName !== options.opening ? openingName : `${options.opening} — ${first ? moveNumber(options.rootFen || options.startFen, first.san) : 'continuation'}`)
    return { ...castlingSummary(options, moves), id, opening: options.opening, name, customName: options.resume?.customName, parentId: options.resume?.parentId || branch?.parentId || options.parentId, startFen, moves: [...moves], pgn: game.pgn(), side: options.side, database: options.database, filters: options.filters, created, lastPracticed: options.resume?.lastPracticed, stats, endPosition: identity(game.fen()), fallback, status, result, termination, generationMode: options.playMode, advantageCp: target, engineFallback: options.engineFallback !== false, engineConfig: { depth: options.engineDepth, timeoutMs: options.engineTimeoutMs || 25000 } }
  }
  const evaluate = async (fen: string, count: number, depth = options.engineDepth, searchMoves?: string[]) => {
    const key = `${fen}|${count}|${depth}|${searchMoves?.join(',') || ''}`
    if (!cache.has(key)) cache.set(key, await sources.analyze(fen, count, depth, signal, Math.min(options.engineTimeoutMs || 25000, Math.max(1, deadline - Date.now())), false, searchMoves))
    return cache.get(key)!
  }
  const valid = (fen: string, entries: Evaluation[], depth: number) => {
    const legal = new Set(new Chess(fen).moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || '')))
    return entries.filter(entry => entry.line[0] && legal.has(entry.line[0]) && entry.depth >= depth && !entry.search?.stoppedByBudget)
  }
  const gameMoves = (data: ExplorerData | undefined, fen: string) => {
    if (!data || data.source === 'book' || total(data) < 20) return []
    const legal = new Set(new Chess(fen).moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || '')))
    return data.moves.filter(move => move.white + move.draws + move.black >= 5 && legal.has(move.uci)).sort((a, b) => (b.white + b.draws + b.black) - (a.white + a.draws + a.black))
  }
  onProgress?.(snapshot('incomplete', 'Generating'))
  while (moves.length < moveLimit) {
    const ended = terminal(game, positions.get(identity(game.fen())) || 1)
    if (ended) return snapshot('complete', ended.reason, ended.result)
    if (signal?.aborted) return snapshot('incomplete', 'Cancelled')
    if (Date.now() >= deadline) break
    const fen = game.fen()
    const legal = game.moves({ verbose: true })
    let data: ExplorerData | undefined
    try { data = await sources.explorer(fen, options.filters, signal, options.database); if (data.opening?.name) openingName = data.opening.name }
    catch (error) { if (signal?.aborted) return snapshot('incomplete', 'Cancelled') }
    const atRoot = moves.length === options.prefix.length
    const human = gameMoves(data, fen)
    const uncoveredHuman = atRoot ? human.filter(move => !options.excludeRootMoves?.includes(move.uci)) : human
    if (atRoot && !isMyTurn(fen, options.side) && human.length && !uncoveredHuman.length) throw new Error('No uncovered human opponent move is available from this position.')
    if (!human.length) {
      fallback = true
      missingHumanData = true
      if (options.engineFallback === false) return snapshot('incomplete', 'Human game data unavailable at this position; engine fallback is off.')
    }
    let analysis: Evaluation[]
    try { analysis = valid(fen, await evaluate(fen, Math.min(6, legal.length)), options.engineDepth).sort((a, b) => b.cp - a.cp) }
    catch (error) { return snapshot('incomplete', signal?.aborted ? 'Cancelled' : `Stockfish unavailable: ${(error as Error).message}`) }
    const best = analysis[0]
    if (!best) return snapshot('incomplete', 'Stockfish produced no verified legal move.')

    if (options.playMode === 'advantage' && moves.length >= 4 && !isMyTurn(fen, options.side) && -best.cp >= target) {
      const criticalDepth = Math.max(16, options.engineDepth)
      const replyMoves = [best.line[0], human[0]?.uci].filter((uci): uci is string => !!uci)
      const forcingMoves = legal.filter(move => move.captured || move.san.includes('+') || move.san.includes('#')).map(move => move.from + move.to + (move.promotion || ''))
      let forcing = analysis.find(entry => {
        const move = legal.find(item => item.from + item.to + (item.promotion || '') === entry.line[0])
        return move && (move.captured || move.san.includes('+') || move.san.includes('#'))
      })
      let forcingUnverified = false
      if (!forcing && forcingMoves.length) {
        try { forcing = valid(fen, await evaluate(fen, Math.min(6, forcingMoves.length), criticalDepth, forcingMoves), criticalDepth).sort((a, b) => b.cp - a.cp)[0] }
        catch { forcingUnverified = true }
      }
      if (forcing && !replyMoves.includes(forcing.line[0])) replyMoves.push(forcing.line[0])
      if (replyMoves.length < 2 && analysis[1]) replyMoves.push(analysis[1].line[0])
      const replies = [...new Set(replyMoves)].slice(0, 3)
      let stable = !forcingUnverified && replies.length >= Math.min(2, legal.length)
      let minimumAcceptable = Infinity, minimumEvaluated = Infinity, maximumLegal = 0, maximumLoss = 0
      try {
        for (const reply of replies) {
          const after = nextFen(fen, reply)
          const legalAfter = new Chess(after).moves({ verbose: true }).length
          const entries = valid(after, await evaluate(after, Math.min(12, legalAfter), criticalDepth), criticalDepth).sort((a, b) => b.cp - a.cp)
          const acceptable = entries.filter(entry => entry.cp >= target)
          minimumAcceptable = Math.min(minimumAcceptable, acceptable.length)
          minimumEvaluated = Math.min(minimumEvaluated, entries.length)
          maximumLegal = Math.max(maximumLegal, legalAfter)
          maximumLoss = Math.max(maximumLoss, ...acceptable.map(entry => (entries[0]?.cp || 0) - entry.cp), 0)
          if (!entries.length || acceptable.length < (options.stabilityPreference === 'balanced' ? 1 : 2) || acceptable.length / legalAfter < (options.stabilityPreference === 'balanced' ? 0.05 : 0.1) || entries.length < Math.min(4, legalAfter)) stable = false
        }
      } catch (error) { stable = false }
      const note = `Advantage +${(-best.cp / 100).toFixed(2)}. ${Number.isFinite(minimumAcceptable) ? minimumAcceptable : 0} of ${Number.isFinite(minimumEvaluated) ? minimumEvaluated : 0} evaluated user moves (at least ${maximumLegal ? Math.round(minimumAcceptable / maximumLegal * 100) : 0}% of up to ${maximumLegal} legal) kept ≥+${(target / 100).toFixed(2)}; acceptable moves lost at most ${(maximumLoss / 100).toFixed(2)}. Tested ${replies.length} plausible replies${forcing ? ', including a forcing move' : ''}. ${human.length ? 'Common human reply tested.' : 'Human reply unavailable; engine-only check.'}`
      lastAssessment = note
      if (stable) return snapshot(human.length ? 'favorable' : 'incomplete', `${note} ${human.length ? options.stabilityPreference === 'balanced' ? 'Favorable under balanced stability settings; this is not a forced win.' : 'Favorable, relatively flexible position; this is not a forced win.' : 'Stability is provisional without human data.'}`)
    }

    const missing = uncoveredHuman.slice(0, 4).map(move => move.uci).filter(uci => !analysis.some(entry => entry.line[0] === uci))
    if (missing.length && Date.now() < deadline) {
      try { analysis.push(...valid(fen, await evaluate(fen, missing.length, options.engineDepth, missing), options.engineDepth)) }
      catch (error) { if (signal?.aborted) return snapshot('incomplete', 'Cancelled') }
    }
    analysis.sort((a, b) => b.cp - a.cp)
    const candidate = new Map(analysis.map(entry => [entry.line[0], entry]))
    const bestScore = Math.max(...analysis.map(entry => entry.cp))
    const mine = isMyTurn(fen, options.side)
    const sound = mine ? uncoveredHuman.filter(move => candidate.has(move.uci) && bestScore - candidate.get(move.uci)!.cp <= options.tolerance) : uncoveredHuman.filter(move => candidate.has(move.uci) && bestScore - candidate.get(move.uci)!.cp <= 200)
    let chosenHuman = mine ? sound[0] : [...sound].sort((a, b) => {
      const weight = (move: typeof a) => frequency(move, data!) + Math.min(150, bestScore - candidate.get(move.uci)!.cp) / 1000
      return weight(b) - weight(a)
    })[0]
    if (mine && options.sharpnessPreference === 'critical' && sound.length > 1 && Date.now() < deadline) {
      const scored = await Promise.all(sound.slice(0, 2).map(async move => {
        const after = nextFen(fen, move.uci), count = Math.min(8, new Chess(after).moves().length)
        try {
          const replies = await evaluate(after, count, Math.min(options.engineDepth, 12))
          const estimate = assessDecision(after, replies, undefined, { depth: Math.min(options.engineDepth, 12), budgetMs: 0, excellentCp: 30, playableCp: 70, seriousCp: 150 })
          return { move, score: estimate?.score }
        } catch { return { move, score: undefined } }
      }))
      const measured = scored.filter(entry => entry.score !== undefined).sort((a, b) => b.score! - a.score!)
      if (measured.length) chosenHuman = measured[0].move
    }
    const availableEngine = atRoot ? analysis.filter(entry => !options.excludeRootMoves?.includes(entry.line[0])) : analysis
    const chosen = chosenHuman ? candidate.get(chosenHuman.uci)! : availableEngine.find(entry => bestScore - entry.cp <= (mine ? options.tolerance : 200))
    if (!chosen) throw new Error('No new sound continuation was verified from this position.')
    if (!chosenHuman) { fallback = true; if (human.length) engineOnlyMove = true }
    const played = legal.find(move => move.from + move.to + (move.promotion || '') === chosen.line[0])!
    const selected: LineMove = { uci: chosen.line[0], san: played.san, source: mine || !chosenHuman ? 'engine' : data!.source === 'masters' ? 'masters' : 'lichess', cp: chosen.cp, depth: chosen.depth, alternatives: analysis.filter(entry => entry.line[0] !== chosen.line[0] && bestScore - entry.cp <= (mine ? options.tolerance : 200)).map(entry => entry.line[0]), games: chosenHuman ? chosenHuman.white + chosenHuman.draws + chosenHuman.black : undefined, frequency: chosenHuman ? frequency(chosenHuman, data!) : undefined }
    game.move({ from: selected.uci.slice(0, 2), to: selected.uci.slice(2, 4), promotion: selected.uci[4] })
    moves.push(selected)
    record()
    onProgress?.(snapshot('incomplete', 'Generating'))
  }
  const ended = terminal(game, positions.get(identity(game.fen())) || 1)
  if (ended) return snapshot('complete', ended.reason, ended.result)
  if (options.playMode === 'mainline' && moves.length >= moveLimit) return snapshot('instructional', `Instructional stopping point reached after ${moves.length} half moves.${missingHumanData ? ' Human data was unavailable at some positions; engine fallback was used.' : ''}${engineOnlyMove ? ' At some positions no common human move met the soundness limit, so Stockfish chose the move.' : ''}`)
  return snapshot('incomplete', `Advantage target not reached or not stable within the ${Date.now() >= deadline ? 'time' : 'move'} budget.${lastAssessment ? ` Last check: ${lastAssessment}` : ''}${missingHumanData ? ' Human data was unavailable for part of this line; engine fallback was used.' : ''}${engineOnlyMove ? ' Some common human moves failed the soundness limit; Stockfish chose instead.' : ''}`)
}
