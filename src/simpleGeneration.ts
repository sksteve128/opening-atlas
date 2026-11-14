import { createExploration } from './exploreVariations'
import { aggressiveCandidate } from './aggressiveGeneration'
import { selectCastlingMove, castlingSummary } from './castlingPreference'
import { legalGenerationMoves, exclusionKey } from './moveExclusions'
import { materialPoint, quietConversion, conversionReady, tacticalEvidence, middlegameEvidence, instructionalEndpoint, type ConversionEvidence } from './conversion'
import { humanPrediction, humanModelUnavailable, type HumanPrediction } from './humanModel'
import { estimateFastSharpness } from './sharpness'
import { styledCandidate, styleNeedsVerification } from './generationStyle'
import { measuredPoint, type AnalysisPoint } from './gameAnalysis'
import { humanPopulation, type PopulationAttempt } from './humanPopulation'
import { Chess } from 'chess.js'
import { identity, isMyTurn, type ExplorerData } from './core'
import { reusableAnalysis, type Evaluation } from './engine'
import { batchOpponentChoice, sampleHuman, seededRandom } from './humanGeneration'
import { continuationsAt, lineFen, tablebaseOutcome, tablebaseSupported, type Generation, type LineMove, type Sources, type Variation } from './learning'

// Explicit opponent settings apply to new runs; absent settings preserve legacy hybrid jobs.
export async function generateSimpleRepertoire(options: Generation, lines: Variation[], sources: Sources, signal?: AbortSignal, progress?: (message: string, draft?: Variation) => void): Promise<Variation> {
  const databaseThenEngine = options.opponentModel === 'lichess-stockfish'
  let opponentTransition = databaseThenEngine ? options.resume?.opponentTransition : undefined
  const { resume: _resume, prefix: _prefix, ...settings } = options
  const generationSettings = structuredClone(options.resume?.generationSettings || { ...settings, startPly: options.prefix.length, style: options.style ?? 'best', minPositionGames: options.minPositionGames ?? 20, minMoveGames: options.minMoveGames ?? 5, engineDepth: Math.max(16, Math.min(18, options.engineDepth)), engineTimeoutMs: options.engineTimeoutMs ?? 30000, humanPolicy: options.humanPolicy ?? 'expansion', mastersFallback: options.mastersFallback ?? true, limitedHumanData: databaseThenEngine ? 'engine' : options.limitedHumanData, engineFallback: databaseThenEngine || options.engineFallback, ...(options.opponentModel === 'maia' || options.opponentModel === 'hybrid' ? { targetRating: options.targetRating ?? Math.round(options.filters.ratings.reduce((n,r)=>n+r,0)/Math.max(1,options.filters.ratings.length)), modelBudgetMs: options.modelBudgetMs ?? 1500 } : {}) })
  const exclusions = options.exclusions ?? options.resume?.exclusions ?? {}
  const started = Date.now(), budgetMs = options.maxMs === undefined ? undefined : Math.max(1, options.maxMs)
  const deadline = budgetMs === undefined ? Infinity : started + budgetMs
  const budget = budgetMs === undefined ? undefined : AbortSignal.timeout(budgetMs)
  const active = signal && budget ? AbortSignal.any([signal, budget]) : signal || budget || new AbortController().signal
  const root = lineFen({ startFen: options.startFen, moves: options.prefix })
  if (options.rootFen && options.rootFen !== root) throw new Error('Displayed board and move history disagree.')
  const game = new Chess(options.startFen)
  for (const m of options.prefix) game.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] })
  const freshOpening = options.freshOpening === true && options.prefix.length === 0 && !options.resume && root === new Chess().fen()
  let openingChosen = false, batchPlace = 1
  const moves = [...options.prefix], depth = Math.max(16, Math.min(18, options.engineDepth))
  const initialPlies = Math.min(options.maxPlies, Math.max(1, options.initialPlies ?? options.maxPlies))
  const seed = options.seed ?? options.resume?.human?.seed ?? crypto.getRandomValues(new Uint32Array(1))[0], rng = seededRandom(seed)
  generationSettings.seed = seed
  generationSettings.rootFen ??= root
  const explore = createExploration(options, lines, seed)
  let randomDraws = options.resume?.recommendation?.randomDraws ?? 0
  for (let i = 0; i < randomDraws; i++) rng()
  const random = () => { randomDraws++; return rng() }
  const styleAnalyses = new Map<string, Evaluation[]>()
  const policy = options.humanPolicy ?? 'expansion', cache = new Map<string, Evaluation[]>()
  const humanCache = new Map<string, Promise<ExplorerData>>()
  const modelCache = new Map<string, HumanPrediction>()
  const evidence: ConversionEvidence = { ...options.resume?.recommendation?.conversion, state: 'none', material: [materialPoint(options.startFen, options.startFen, options.side, 0)], points: (options.resume?.recommendation?.conversion?.points || []).filter(p => p.ply < options.prefix.length), settings: { minPlies: options.conversionMinPlies ?? 4, maxDifficulty: options.conversionMaxDifficulty ?? 35, advantageCp: options.advantageCp ?? 150 } }
  const history = new Chess(options.startFen)
  options.prefix.forEach((m, i) => { history.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] }); evidence.material.push(materialPoint(history.fen(), options.startFen, options.side, i + 1, evidence.material.at(-1))) })
  const inheritedAnalysis = (options.resume || lines.find(line => line.id === options.parentId))?.analysis
  const analysisPoints: (AnalysisPoint | null)[] = options.prefix.map((_, i) => inheritedAnalysis?.points[i] || null)
  const populationAttempts: (PopulationAttempt & { ply: number })[] = []
  const performance = { phases: { engine: 0, human: 0 }, searches: 0, engineCacheHits: 0, sharpnessCacheHits: 0, searchDetails: [] as (NonNullable<Evaluation['search']> & { phase: string })[] }
  let generationState: Variation['generationState'] = 'running'
  let reason = 'Generating...', stopKind: NonNullable<Variation['recommendation']>['stopKind'] = 'length'
  let tablebase: Variation['tablebase']
  let objectiveCp: number | undefined, achievedDepth: number | undefined, evaluationPly: number | undefined, fallback = !!opponentTransition
  const id = options.resume?.id ?? crypto.randomUUID()
  const check = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); if (Date.now() >= deadline || budget?.aborted) throw new Error('Computational budget expired.') }
  const snapshot = (): Variation => {
    const replay = new Chess(options.startFen)
    for (const move of moves) replay.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] })
    return { ...options.resume, generationSettings, opponentTransition, opponentModel: options.opponentModel, generationState, ...explore.metadata, ...castlingSummary(options, moves), aggressive: options.aggressive, style: options.style ?? 'best', styleToleranceCp: options.styleToleranceCp ?? 30, exclusions: structuredClone(exclusions), freshOpening: options.resume?.freshOpening ?? freshOpening, tablebase, id, name: options.resume?.name ?? options.opening + (options.opponentModel === 'stockfish' ? ' — Stockfish continuation' : ' — human continuation'), opening: options.opening, parentId: options.parentId ?? continuationsAt(lines, root, undefined, options.side).parentId, startFen: options.startFen, moves: [...moves], pgn: replay.pgn(), side: options.side, database: options.database, filters: options.filters, created: options.resume?.created ?? started, stats: options.resume?.stats ?? { firstTry: 0, errors: 0, reveals: 0, completions: 0, totalMs: 0 }, endPosition: identity(game.fen()), fallback, generationMode: options.playMode, engineConfig: { depth, timeoutMs: options.engineTimeoutMs ?? 30000 }, status: evidence.outcome === 'Checkmate' ? 'complete' : evidence.state === 'resolved' ? 'instructional' : 'incomplete', analysis: { version: 1, points: Array.from({ length: moves.length + 1 }, (_, i) => analysisPoints[i] || null) }, termination: reason === 'Generating...' && evidence.detectedPly !== undefined ? 'Converting advantage...' : reason, human: { seed, policy, minPositionGames: options.minPositionGames ?? 20, minMoveGames: options.minMoveGames ?? 5, decisions: [], status: reason, stopReason: reason }, recommendation: { randomDraws, conversion: { ...evidence, material: [...evidence.material], points: evidence.points.map(p => ({ ...p })) }, policy: 'simple', runtimeMs: Date.now() - started, populationAttempts: [...populationAttempts], evaluationPly, verification: 'pending', preliminary: true, objectiveCp, depth: achievedDepth, stopKind, reason, adaptiveLength: options.initialPlies === undefined ? undefined : { initialPlies, maximumPlies: options.maxPlies, extendedPlies: Math.max(0, moves.length - options.prefix.length - initialPlies) }, performance: { ...performance, phases: { ...performance.phases }, searchDetails: [...performance.searchDetails] } } }
  }
  const rawEngine = async (fen: string, searchMoves?: string[]) => {
    const cacheKey = searchMoves ? fen + '|' + searchMoves.join(',') : fen
    const at = Date.now()
    const valid = (entries?: Evaluation[]) => entries?.length === 1 && entries[0].depth > 0 && (!searchMoves || searchMoves.includes(entries[0].line[0])) && Number.isFinite(entries[0].cp) && new Chess(fen).moves({ verbose: true }).some(m => m.from + m.to + (m.promotion || '') === entries[0].line[0]) && (!entries[0].search?.bestMove || entries[0].search.bestMove === entries[0].line[0])
    try {
      const saved = searchMoves ? undefined : reusableAnalysis(cache, fen, 1, depth) || sources.cached?.(fen, 1, depth)
      if (valid(saved)) { performance.engineCacheHits++; return saved![0] }
      // Repeated positions reuse even preliminary single-PV analysis within this run.
      const prior = cache.get(cacheKey)
      if (valid(prior)) { performance.engineCacheHits++; return prior![0] }
      const turns = Math.max(1, Math.ceil((initialPlies - moves.length + options.prefix.length) / 2))
      performance.searches++
      const entries = await sources.analyze(fen, 1, depth, active, Math.max(1, Math.min(options.engineTimeoutMs ?? 30000, (deadline - Date.now()) / turns)), !!saved, searchMoves)
      if (!valid(entries)) throw new Error('Invalid Stockfish best-move analysis.')
      if (entries[0].search) performance.searchDetails.push({ ...entries[0].search, phase: 'engine' })
      cache.set(cacheKey, entries)
      return entries[0]
    } finally { performance.phases.engine += Date.now() - at }
  }
  const styledEngine = async (fen: string): Promise<Evaluation & { restriction?: LineMove['restriction']; style?: LineMove['style']; aggressive?: LineMove['aggressive'] }> => {
    const allowed = legalGenerationMoves(fen, options.side, exclusions).map(m => m.uci)
    if (!allowed.length) throw new Error('Move exclusions leave no legal moves.')
    const overall = await rawEngine(fen)
    const permitted = allowed.includes(overall.line[0]) ? overall : await rawEngine(fen, allowed)
    const restriction = permitted !== overall ? { excluded: exclusions[exclusionKey(fen, options.side)] || [], bestOverall: overall.line[0], overallCp: overall.cp, overallDepth: overall.depth, ...(overall.depth === permitted.depth && overall.mate === undefined && permitted.mate === undefined ? { lossCp: Math.max(0, overall.cp - permitted.cp) } : {}) } : undefined
    if (!options.style || options.style === 'best') return { ...permitted, restriction }
    if (options.style === 'aggressive' && options.aggressive) {
      const at = Date.now()
      const result = await aggressiveCandidate(fen, permitted, options, sources, allowed, deadline, active)
      performance.searches += result.decision.searches; performance.phases.engine += Date.now() - at
      return { ...result.entry, restriction, aggressive: result.decision }
    }
    try {
      const at = Date.now(), discoveryDepth = Math.min(12, depth)
      let entries = sources.cached?.(fen, 3, discoveryDepth)
      if (entries) performance.engineCacheHits++
      else { performance.searches++; entries = await sources.analyze(fen, 3, discoveryDepth, active, Math.max(1, Math.min(options.engineTimeoutMs ?? 30000, deadline - Date.now()))) }
      if (entries[0]?.search) performance.searchDetails.push({ ...entries[0].search, phase: 'style-discovery' })
      performance.phases.engine += Date.now() - at
      styleAnalyses.set(fen, entries)
      const choice = styledCandidate(fen, entries, options.style, options.styleToleranceCp ?? 30, allowed)
      if (!choice || choice.entry.line[0] === permitted.line[0]) return { ...permitted, restriction }
      const alternative = await rawEngine(fen, [choice.entry.line[0]])
      if (overall.depth < depth || alternative.depth < depth || overall.mate !== undefined || alternative.mate !== undefined) return { ...permitted, restriction }
      const played = new Chess(fen).moves({ verbose: true }).find(move => move.from + move.to + (move.promotion || '') === choice.entry.line[0])!
      let baseline = overall, checked = alternative
      if (played.captured || played.promotion || /[+#]/.test(played.san) || styleNeedsVerification(fen, overall.line) || styleNeedsVerification(fen, alternative.line)) {
        const deeper = Math.max(depth + 2, 18), at = Date.now()
        performance.searches += 2
        const timeout = Math.max(1, Math.min(options.engineTimeoutMs ?? 30000, deadline - Date.now()))
        baseline = (await sources.analyze(fen, 1, deeper, active, timeout))[0]
        checked = (await sources.analyze(fen, 1, deeper, active, timeout, false, [choice.entry.line[0]]))[0]
        performance.phases.engine += Date.now() - at
      }
      const lossCp = baseline.cp - checked.cp
      if (baseline.depth < depth || checked.depth < depth || baseline.mate !== undefined || checked.mate !== undefined || !Number.isFinite(lossCp) || lossCp > (options.styleToleranceCp ?? 30)) return { ...permitted, restriction }
      return { ...checked, restriction, style: { score: choice.score, lossCp: Math.max(0, lossCp), verifiedDepth: Math.min(baseline.depth, checked.depth) } }
    } catch (error) { check(); return { ...permitted, restriction } }
  }
  const engine = async (fen: string) => {
    const selected = await styledEngine(fen)
    const castle = await selectCastlingMove(fen, selected, options, async (...args) => {
      check(); const at = Date.now(); performance.searches++
      try { const result = await sources.analyze(...args); if (result[0]?.search) performance.searchDetails.push({ ...result[0].search, phase: 'castling' }); return result }
      finally { performance.phases.engine += Date.now() - at }
    }, active, styleAnalyses.get(fen), cache.get(fen)?.[0], moves)
    if (selected.aggressive && selected.aggressive.selected !== castle.entry.line[0]) { selected.aggressive.selected = castle.entry.line[0]; selected.aggressive.rejected = true; selected.aggressive.reason = 'Castling preference selected another verified move' }
    const explored = castle.decision?.accepted ? { entry: castle.entry, exploration: undefined } : await explore.select(fen, castle.entry, moves, { ...sources, analyze: async (...args) => {
      check(); const at = Date.now(); performance.searches++
      args[4] = Math.max(1, Math.min(args[4] ?? 30000, deadline - Date.now()))
      try { const result = await sources.analyze(...args); if (result[0]?.search) performance.searchDetails.push({ ...result[0].search, phase: 'exploration' }); return result }
      finally { performance.phases.engine += Date.now() - at }
    } }, active, styleAnalyses.get(fen))
    if (selected.aggressive && selected.aggressive.selected !== explored.entry.line[0]) { selected.aggressive.selected = explored.entry.line[0]; selected.aggressive.rejected = true; selected.aggressive.reason = 'Exploration selected another verified move' }
    return { ...explored.entry, exploration: explored.exploration, aggressive: selected.aggressive, restriction: selected.restriction, style: explored.entry === selected ? selected.style : undefined, castling: castle.decision }
  }
  const ended = () => {
    if (!game.isGameOver()) return false
    stopKind = 'terminal'; evidence.state = 'resolved'
    evidence.outcome = game.isCheckmate() ? 'Checkmate' : 'Sound continuation'
    reason = game.isCheckmate() ? 'Checkmate' : 'Sound continuation — drawn game.'
    evidence.detail = game.isCheckmate() ? 'The generated board is checkmate.' : 'The generated board satisfies a game-ending draw condition.'
    return true
  }
  let lastCheckpoint = -4
  progress?.('Generating...')
  try {
    for (let ply = 0; ply < options.maxPlies; ply++) {
      check()
      if (ended()) break
      const fen = game.fen(), mine = isMyTurn(fen, options.side)
      if (sources.tablebase && tablebaseSupported(fen)) {
        try {
          const tbSignal = AbortSignal.any([active, AbortSignal.timeout(1500)])
          const tb = await sources.tablebase(fen, tbSignal)
          check()
          tablebase = tablebaseOutcome(fen, tb, options.side)
          if (tablebase) {
            evidence.state = 'resolved'; evidence.outcome = 'Theoretical endgame'; evidence.tablebase = { ply: moves.length, category: tb.category }
            reason = `${tablebase.label}${tablebase.winner ? ` — ${tablebase.winner === 'white' ? 'White' : 'Black'} wins` : ' — theoretical draw'}.`; stopKind = 'terminal'; break
          }
        } catch { check() } // Unavailable tablebase is not evidence of an outcome.
      }
      const eligible = legalGenerationMoves(fen, options.side, exclusions).map(m => m.uci)
      if (!eligible.length) throw new Error('Move exclusions leave no legal moves.')
      const openingDecision = !options.opponentModel || options.opponentModel === 'hybrid' ? mine && freshOpening && !openingChosen && options.exploration?.mode !== 'explore' : false
      let move: LineMove
      if (mine && !openingDecision) {
        const entry = await engine(fen)
        objectiveCp = entry.cp // UCI scores already use the side-to-move perspective (our side here).
        achievedDepth = entry.depth; evaluationPly = moves.length
        analysisPoints[moves.length] = measuredPoint(fen, moves.length, [entry], 'fast')
        const point = { ply: moves.length, cp: entry.cp, depth: entry.depth, mate: entry.mate } as ConversionEvidence['points'][number]
        evidence.points.push(point)
        if (evidence.state === 'predicted-mate' && !(entry.mate !== undefined && entry.mate > 0)) { evidence.state = 'converting'; evidence.detail = 'Earlier mate prediction is no longer present in the latest analysis.' }
        if (entry.mate !== undefined && entry.mate > 0) { evidence.state = 'predicted-mate'; evidence.detail = `Predicted forced mate in ${entry.mate}; not completed checkmate.` }
        if ((entry.cp >= (options.advantageCp ?? 150) || entry.mate !== undefined && entry.mate > 0) && evidence.detectedPly === undefined) {
          evidence.detectedPly = moves.length; evidence.state = entry.mate ? 'predicted-mate' : 'detected'; progress?.('Advantage detected...')
        }
        if (evidence.detectedPly !== undefined && moves.length > evidence.detectedPly && evidence.state !== 'predicted-mate') evidence.state = 'converting'
        const quiet = quietConversion(fen, entry.line, moves.map(m => m.san)); point.quiet = quiet
        const probe = conversionReady(evidence, moves.length, entry, undefined, quiet, options.advantageCp ?? 150, options.conversionMaxDifficulty, options.conversionMinPlies)
        point.stable = probe.stable
        point.middlegame = middlegameEvidence(fen)
        // A checkpoint follows a completed user/opponent move pair. An initial
        // opponent move is a lead-in, so Black need not stop on a fixed ply parity.
        const candidateAdvantage = evidence.detectedPly !== undefined && moves.length - evidence.detectedPly >= Math.max(4, options.conversionMinPlies ?? 4) && entry.cp >= (options.advantageCp ?? 150)
        const candidateMiddlegame = point.middlegame.suitable && entry.cp >= -50 && moves.length - options.prefix.length >= 4 && (evidence.detectedPly === undefined || moves.length - evidence.detectedPly >= Math.max(4, options.conversionMinPlies ?? 4))
        // Only plausible endpoints get bounded fast checkpoints.
        // Best-move selection always remains the original single-PV search.
        if (quiet && probe.stable && entry.mate === undefined && (candidateAdvantage || candidateMiddlegame) && moves.length - lastCheckpoint >= 4) {
          lastCheckpoint = moves.length
          const cachedSharp = sources.fastSharpness?.(fen)
          let decision = cachedSharp?.fen === fen && !(options.side === 'white' ? cachedSharp.whiteProjected : cachedSharp.blackProjected) ? cachedSharp[options.side] : undefined
          if (decision) performance.sharpnessCacheHits++
          if (!decision) {
            const at = Date.now()
            try {
              let entries = sources.cached?.(fen, 4, 8)
              if (entries) performance.engineCacheHits++
              else { performance.searches++; entries = await sources.analyze(fen, 4, 8, active, Math.max(1, Math.min(1500, deadline - Date.now()))); if (entries[0]?.search) performance.searchDetails.push({ ...entries[0].search, phase: 'conversion' }) }
              if (entries.every(e => e.depth >= 8 && Number.isFinite(e.cp) && e.search?.multiPVComplete !== false)) decision = estimateFastSharpness(fen, entries)
            } catch { check() } finally { performance.phases.engine += Date.now() - at }
          }
          if (decision) {
            point.difficulty = decision.score; point.acceptable = decision.acceptable
            const losses = decision.moves.flatMap(m => m.lossCp === null ? [] : [m.lossCp]); point.sensitivityCp = losses.length ? Math.max(...losses) : undefined
            analysisPoints[moves.length] = { ...analysisPoints[moves.length]!, [options.side]: decision.score, [options.side + 'Kind']: 'direct' }
          }
          const hasChoices = decision && decision.depth >= 8 && decision.acceptable >= 2
          if (hasChoices) {
            point.danger = await tacticalEvidence(fen, entry, async (position, count, targetDepth, _signal, _timeout, _refresh, searchMoves) => {
              check()
              const saved = !searchMoves && sources.cached?.(position, count, targetDepth)
              if (saved) { performance.engineCacheHits++; return saved }
              const at = Date.now()
              try {
                performance.searches++
                const entries = await sources.analyze(position, count, targetDepth, active, Math.max(1, Math.min(1500, deadline - Date.now())), false, searchMoves)
                if (entries[0]?.search) performance.searchDetails.push({ ...entries[0].search, phase: 'endpoint' })
                return entries
              } finally { performance.phases.engine += Date.now() - at }
            })
            check()
          } else point.danger = { level: decision ? 'critical' : 'unknown', reason: decision ? 'Fewer than two acceptable user choices.' : 'User response choices unavailable.' }
          point.quiet = point.danger.level === 'low'
          const advantage = conversionReady(evidence, moves.length, entry, decision, point.quiet, options.advantageCp ?? 150, options.conversionMaxDifficulty, options.conversionMinPlies).ready
          if (point.quiet && (advantage || candidateMiddlegame && hasChoices)) {
            evidence.state = 'resolved'; evidence.outcome = advantage ? 'Advantage secured' : 'Sound middlegame reached'
            evidence.detail = `Preliminary instructional endpoint: evaluation ${entry.cp / 100} at depth ${entry.depth}; material balance ${evidence.material.at(-1)!.balance}; user difficulty ${decision!.score}/100. ${point.danger.reason} Recent evaluations are consistent. ${advantage ? 'Minimum continuation after advantage detection satisfied.' : 'Development, king safety and central pawn structure support independent middlegame play.'} Not deep verification or proof of a win.`
            stopKind = advantage ? 'advantage' : 'terminal'; reason = evidence.outcome; break
          }
        }
        move = { uci: entry.line[0], san: '', source: 'engine', cp: entry.cp, depth: entry.depth, restriction: entry.restriction, style: entry.style, aggressive: entry.aggressive, castling: entry.castling, exploration: entry.exploration }
      } else if (options.opponentModel === 'stockfish' || databaseThenEngine && opponentTransition) {
        const entry = await rawEngine(fen)
        analysisPoints[moves.length] = measuredPoint(fen, moves.length, [entry], 'fast')
        move = { uci: entry.line[0], san: '', source: 'engine', ...(opponentTransition ? { engineFallback: true } : {}), cp: entry.cp, depth: entry.depth }
      } else {
        const at = Date.now()
        let found
        try { found = options.opponentModel === 'maia' ? { attempts: [] } as Awaited<ReturnType<typeof humanPopulation>> : await humanPopulation(fen, databaseThenEngine ? { ...options, limitedHumanData: 'engine' } : options, sources, active, humanCache); check() }
        catch (error) { if (active.aborted) throw error; stopKind = 'human-data'; reason = 'Generation stopped. ' + (error as Error).message; break }
        finally { performance.phases.human += Date.now() - at }
        populationAttempts.push(...found.attempts.map(attempt => ({ ...attempt, ply: moves.length })))
        const { population } = found
        const dist = found.dist?.moves.some(m => eligible.includes(m.uci)) ? found.dist : undefined
        let predicted: LineMove | undefined
        if (!dist || population?.sparse) {
          evidence.modelStatus = options.opponentModel === 'lichess' || databaseThenEngine ? 'Maia not selected; database mode uses only the configured database or explicit Stockfish fallback.' : humanModelUnavailable
          if (sources.humanModel && options.opponentModel !== 'lichess' && !databaseThenEngine) {
            try {
              const rating = options.targetRating ?? Math.round(options.filters.ratings.reduce((n, r) => n + r, 0) / Math.max(1, options.filters.ratings.length))
              const prediction = await humanPrediction(sources.humanModel, fen, rating, active, Math.min(options.modelBudgetMs ?? 1500, deadline - Date.now()), modelCache)
              const candidates = prediction.moves.filter(m => eligible.includes(m.uci))
              const covered = continuationsAt(lines, fen, undefined, options.side).covered
              const uncovered = candidates.filter(m => !covered.includes(m.uci))
              const pool = policy === 'expansion' && options.playMode !== 'mainline' && uncovered.length ? uncovered : candidates
              const mass = pool.reduce((sum, m) => sum + m.probability, 0)
              if (!mass) throw new Error('No eligible predicted moves after exclusions.')
              const normalized = pool.map(m => ({ ...m, probability: m.probability / mass }))
              const draw = random(); let cumulative = 0
              const chosen = batchOpponentChoice(normalized, options, batchPlace) || normalized.find(m => { cumulative += m.probability; return draw < cumulative }) || normalized.at(-1)!
              if (options.batchIndex !== undefined && normalized.length > 1) batchPlace *= Math.min(6, normalized.length)
              const { moves: _probabilities, ...provenance } = prediction
              predicted = { uci: chosen.uci, san: '', source: 'model', prediction: { ...provenance, probability: chosen.probability } }
              evidence.modelStatus = `${prediction.model} ${prediction.version}; target rating ${prediction.rating}; ${prediction.calibrated ? 'provider reports calibrated' : 'not independently calibrated'}`
            } catch (error) { check(); evidence.modelStatus = 'Human model unavailable: ' + (error as Error).message }
          }
        }
        if (predicted) move = predicted
        else
        if (!dist) {
          stopKind = 'human-data'; reason = found.dist ? 'No eligible human moves remain after exclusions.' : found.error ? 'Human data unavailable. ' + found.error : 'Limited human data. All human populations are below the configured requirements.'
          if (!(databaseThenEngine || options.limitedHumanData === 'engine' || options.limitedHumanData === undefined && options.engineFallback)) break
          const entry = mine ? await engine(fen) : await rawEngine(fen); fallback = true
          if (databaseThenEngine) {
            const issue = found.attempts.find(a => a.error)?.issue || (found.attempts.some(a=>a.issue === 'insufficient') ? 'insufficient' : found.attempts.at(-1)?.issue)
            opponentTransition = { ply: moves.length, issue, reason: found.error ? `Database unavailable; Stockfish fallback enabled (${issue}): ${found.error}` : found.dist ? 'No eligible matching moves after exclusions.' : issue === 'zero-games' || issue === 'no-legal-moves' ? 'No matching moves.' : 'Insufficient database samples.' }
          }
          move = { uci: entry.line[0], san: '', source: 'engine', engineFallback: true, cp: entry.cp, depth: entry.depth }
          stopKind = 'length'; reason = 'Generating...'
        } else {
          const covered = continuationsAt(lines, fen, undefined, options.side).covered
          let candidates = dist.moves.filter(m => eligible.includes(m.uci))
          const evaluated = databaseThenEngine ? sources.cached?.(fen, 4, depth) || [] : []
          if (databaseThenEngine && (options.style ?? 'best') === 'best' && evaluated.length) {
            const bestCp = Math.max(...evaluated.map(e=>e.cp))
            const sound = candidates.filter(m=>evaluated.some(e=>e.depth >= depth && e.line[0] === m.uci && e.cp >= bestCp - options.tolerance))
            if (sound.length) candidates = sound
          }
          if (!candidates.length) { stopKind = 'human-data'; reason = 'No eligible human moves after exclusions.'; break }
          const uncovered = candidates.filter(m => !covered.includes(m.uci))
          const pool = options.playMode !== 'mainline' && policy === 'expansion' && uncovered.length ? uncovered : candidates
          const mass = pool.reduce((sum, m) => sum + m.probability, 0)
          const normalized = pool.map(m => ({ ...m, probability: m.probability / mass }))
          const selected = batchOpponentChoice(normalized, options, batchPlace) || (options.playMode === 'mainline' && !openingDecision ? [...normalized].sort((a, b) => b.probability - a.probability)[0] : sampleHuman(normalized, random))
          if (options.batchIndex !== undefined && normalized.length > 1) batchPlace *= Math.min(6, normalized.length)
          const evaluation = evaluated.find(e=>e.line[0]===selected.uci)
          move = { uci: selected.uci, san: selected.san, ...(evaluation ? {cp:evaluation.cp,depth:evaluation.depth} : {}), source: population!.database, explorerCache: found.data?.cache, population, games: selected.white + selected.draws + selected.black, frequency: selected.mass, sampling: { probability: selected.probability, omittedMass: 1 - (1 - dist.omittedMass) * mass, eligibleGames: pool.reduce((sum, m) => sum + m.white + m.draws + m.black, 0), policy } }
        }
      }
      if (openingDecision) { openingChosen = true; move.openingChoice = true }
      if (!eligible.includes(move.uci)) throw new Error('Generator returned an excluded or illegal move.')
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      move.san = game.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] }).san
      if (move.source === 'engine' && move.depth !== undefined) move.selectionAnalysis = { requestedDepth: depth, achievedDepth: move.depth, preliminary: move.depth < depth }
      moves.push(move)
      evidence.material.push(materialPoint(game.fen(), options.startFen, options.side, moves.length, evidence.material.at(-1)))
      progress?.(evidence.detectedPly === undefined ? 'Generating...' : 'Converting advantage...', snapshot())
      if (ended()) break

      // A single inexpensive checkpoint at the initial target; the hard cap and clock stay unchanged.
      if (options.initialPlies !== undefined && ply + 1 >= initialPlies && (ply + 1 - initialPlies) % 2 === 0 && instructionalEndpoint(game.fen(), moves.map(m => m.san), evidence)) {
        evidence.state = 'resolved'; evidence.outcome = 'Sound middlegame reached'
        evidence.detail = 'Stable evaluation, safe developed kings, and no unresolved forcing sequence at the configured initial target. Preliminary instructional endpoint.'
        stopKind = 'terminal'; reason = evidence.outcome; break
      }

    }
  } catch (error) {
    stopKind = signal?.aborted ? 'cancelled' : budget?.aborted || Date.now() >= deadline ? 'budget' : 'engine-timeout'
    reason = /exclusions|excluded/.test((error as Error).message) ? (error as Error).message : signal?.aborted ? 'Generation stopped.' : stopKind === 'budget' ? 'Unresolved — time budget' : 'Unresolved — engine analysis unavailable.'
    evidence.detail = stopKind === 'budget' ? 'Total generation time exhausted.' : (error as Error).message
    if (signal?.aborted && moves.length === options.prefix.length) throw error
  }
  if (reason === 'Generating...' && !game.isGameOver() && sources.tablebase && tablebaseSupported(game.fen())) {
    try {
      const tb = await sources.tablebase(game.fen(), AbortSignal.any([active, AbortSignal.timeout(1500)]))
      tablebase = tablebaseOutcome(game.fen(), tb, options.side)
      if (tablebase) {
        evidence.state = 'resolved'; evidence.outcome = 'Theoretical endgame'; evidence.tablebase = { ply: moves.length, category: tb.category }
        reason = `${tablebase.label}${tablebase.winner ? ` — ${tablebase.winner === 'white' ? 'White' : 'Black'} wins` : ' — theoretical draw'}.`; stopKind = 'terminal'
      }
    } catch { /* Existing length policy remains when tablebase is unavailable. */ }
  }
  if (reason === 'Generating...' && (budget?.aborted || Date.now() >= deadline)) {
    stopKind = 'budget'; reason = 'Unresolved — time budget'; evidence.detail = 'Total generation time exhausted.'
  }
  if (reason === 'Generating...') reason = options.initialPlies === undefined ? 'Unresolved — length limit' : 'Unresolved — maximum move limit'
  if (evidence.state !== 'resolved') {
    evidence.outcome = 'Unresolved'
    if (evidence.state !== 'predicted-mate') evidence.state = 'unresolved'
    if (stopKind === 'human-data') { evidence.detail = reason; reason = 'Unresolved — human continuation unavailable.' }
  }
  generationState = ['cancelled','budget','human-data','engine-timeout'].includes(stopKind) ? 'stopped' : 'complete'
  progress?.(evidence.state === 'resolved' ? 'Variation complete.' : 'Unresolved.', snapshot())
  const result = snapshot()
  // Return the existing saved line rather than create a duplicate or alter its practice history.
  const duplicate = lines.find(line => line.opponentModel === result.opponentModel && line.side === result.side && identity(line.startFen) === identity(result.startFen) && line.moves.length === result.moves.length && line.moves.every((m, i) => m.uci === result.moves[i].uci))
  return result.moves.length > options.prefix.length ? duplicate ?? result : result
}
