import { Chess } from 'chess.js'
import { expect, it, vi } from 'vitest'
import { generateSimpleRepertoire } from './simpleGeneration'
import { generateHumanRepertoire } from './humanGeneration'
import { lineFen, saveVariation, type Generation, type Sources, type Variation } from './learning'
import { emptyMemoryStats, beginMemory, finishMemory } from './memorize'
const root = new Chess().fen()
const legal = (fen: string) => new Chess(fen).moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''))
const options: Generation = { opening: 'Test', startFen: root, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2200, 2500], speeds: ['rapid'] }, maxPlies: 6, maxMs: 20000, engineDepth: 16, tolerance: 35, mode: 'here', seed: 42, humanPolicy: 'expansion' }
function sources(): Sources {
  return { analyze: vi.fn<Sources['analyze']>(async (fen, n, depth) => legal(fen).slice(0, n).map(uci => ({ cp: 10, depth, line: [uci] }))), explorer: vi.fn<Sources['explorer']>(async fen => ({ white: 100, draws: 0, black: 0, source: 'lichess', moves: legal(fen).slice(0, 2).map((uci, i) => ({ uci, san: uci, white: i ? 20 : 80, draws: 0, black: 0 })) })), fastSharpness: vi.fn(() => { throw new Error('Must not run sharpness') }) }
}
it.each(['white', 'black'] as const)('uses one single-PV best-move search per %s decision only', async side => {
  const src = sources(), line = await generateSimpleRepertoire({ ...options, side }, [], src)
  expect(line.moves).toHaveLength(6)
  expect(src.analyze).toHaveBeenCalledTimes(3)
  for (const [fen, n, depth] of vi.mocked(src.analyze).mock.calls) { expect(fen.split(' ')[1]).toBe(side[0]); expect(n).toBe(1); expect(depth).toBe(16) }
  expect(line.moves.filter(m => m.source === 'engine')).toHaveLength(3)
  expect(line.moves.filter(m => m.sampling)).toHaveLength(3)
  expect(src.fastSharpness).not.toHaveBeenCalled()
  expect(line.recommendation).toMatchObject({ policy: 'simple', verification: 'pending', preliminary: true })
  expect(src.explorer).toHaveBeenCalledWith(expect.any(String), options.filters, expect.any(AbortSignal), 'lichess')
})
it('chooses most common responses for mainlines, seeded weighted responses for simulation', async () => {
  const a = await generateSimpleRepertoire({ ...options, side: 'black', playMode: 'mainline', maxPlies: 1 }, [], sources())
  expect(a.moves[0].uci).toBe(legal(root)[0]); expect(a.moves[0].sampling?.probability).toBe(.8)
  const runs = await Promise.all([1, 1, 99].map(seed => generateSimpleRepertoire({ ...options, side: 'black', maxPlies: 1, humanPolicy: 'simulation', seed }, [], sources())))
  expect(runs[0].moves).toEqual(runs[1].moves)
  expect(runs[0].moves[0].sampling?.probability).toBeGreaterThan(0)
  // Across deterministic seeds, the 80% response is sampled more often.
  let common = 0
  for (let seed = 0; seed < 100; seed++) { const r = await generateSimpleRepertoire({ ...options, side: 'black', maxPlies: 1, seed, humanPolicy: 'simulation' }, [], sources()); common += Number(r.moves[0].uci === legal(root)[0]) }
  expect(common).toBeGreaterThan(65); expect(common).toBeLessThan(95)
})
it('expands uncovered opponent branches, normalizes probabilities, and preserves user best moves', async () => {
  const src = sources(), first = await generateSimpleRepertoire({ ...options, playMode: 'mainline', maxPlies: 2 }, [], src)
  const second = await generateSimpleRepertoire({ ...options, maxPlies: 2 }, [first], src)
  expect(second.moves[0].uci).toBe(first.moves[0].uci)
  expect(second.moves[1].uci).not.toBe(first.moves[1].uci)
  expect(second.moves[1].sampling?.probability).toBe(1)
  expect(second.parentId).toBe(first.id)
  const duplicate = await generateSimpleRepertoire({ ...options, playMode: 'mainline', maxPlies: 2 }, [first], sources())
  expect(duplicate).toBe(first); expect(saveVariation([first], duplicate)).toHaveLength(1)
})
it.each(['white', 'black'] as const)('detects advantage using side-to-move engine scores for %s', async side => {
  const src = sources(), original = src.analyze
  src.analyze = async (...args) => (await original(...args)).map(e => ({ ...e, cp: 160 }))
  const result = await generateSimpleRepertoire({ ...options, side }, [], src)
  expect(result.moves).toHaveLength(6)
  expect(result.recommendation?.conversion?.detectedPly).toBe(side === 'white' ? 0 : 1)
  expect(result.recommendation?.conversion?.outcome).toBe('Unresolved')
  expect(result.recommendation).toMatchObject({ stopKind: 'length', objectiveCp: 160, verification: 'pending' })
  expect(result.termination).toContain('Unresolved')
})
it('keeps graceful shallow analysis, reuses compatible cache, and never substitutes a second-best move', async () => {
  const src = sources()
  src.cached = () => [{ cp: 10, depth: 18, line: ['e2e4'] }]
  const line = await generateSimpleRepertoire({ ...options, maxPlies: 1 }, [], src)
  expect(line.moves[0].uci).toBe('e2e4'); expect(src.analyze).not.toHaveBeenCalled()
  src.cached = undefined
  src.analyze = async () => [{ cp: 10, depth: 10, line: ['e2e4'], search: { bestMove: 'e2e4', requestedDepth: 16, achievedDepth: 10, durationMs: 1000, queueMs: 0, multiPVComplete: true, endedNaturally: false, stoppedByBudget: true } }]
  const shallow = await generateSimpleRepertoire({ ...options, maxPlies: 1 }, [], src)
  expect(shallow.moves[0].depth).toBe(10); expect(shallow.recommendation?.preliminary).toBe(true)
  src.analyze = async () => [{ cp: 10, depth: 10, line: ['d2d4'], search: { bestMove: 'e2e4', requestedDepth: 16, achievedDepth: 10, durationMs: 1000, queueMs: 0, multiPVComplete: true, endedNaturally: false, stoppedByBudget: true } }]
  expect((await generateSimpleRepertoire({ ...options, maxPlies: 1 }, [], src)).moves).toHaveLength(0)
})
it('stops on unavailable human data without silently using book or engine moves', async () => {
  const src = sources(); src.explorer = async () => ({ white: 0, draws: 0, black: 0, moves: [], source: 'book', unavailableReason: 'HTTP 401' })
  const line = await generateSimpleRepertoire(options, [], src)
  expect(line.moves).toHaveLength(1); expect(line.recommendation?.conversion?.detail).toContain('HTTP 401'); expect(line.fallback).toBe(false)
  const fallback = await generateSimpleRepertoire({ ...options, engineFallback: true, maxPlies: 2 }, [], src)
  expect(fallback.moves).toHaveLength(2); expect(fallback.fallback).toBe(true); expect(fallback.moves[1].sampling).toBeUndefined()
})
it('uses exact history and position, preserves saved stats and memorization, and rejects mismatched FEN', async () => {
  const first = await generateSimpleRepertoire({ ...options, maxPlies: 2 }, [], sources())
  const saved: Variation = JSON.parse(JSON.stringify(first)); saved.stats.completions = 7
  const resumed = await generateSimpleRepertoire({ ...options, prefix: saved.moves, rootFen: lineFen(saved), resume: saved, maxPlies: 2 }, [], sources())
  expect(resumed.moves.slice(0, 2)).toEqual(saved.moves); expect(resumed.id).toBe(saved.id); expect(resumed.stats.completions).toBe(7)
  const memory = beginMemory(emptyMemoryStats(), saved.id, 0, 2, 1000)
  expect(finishMemory(memory.stats, { ...memory.session, index: 2 }, 2000).completed).toBe(1)
  await expect(generateSimpleRepertoire({ ...options, prefix: saved.moves, rootFen: root }, [], sources())).rejects.toThrow('disagree')
})
it('preserves a partial continuation on cancellation and keeps advanced generation callable', async () => {
  const src = sources(), controller = new AbortController()
  src.explorer = async () => { controller.abort(); throw new DOMException('Cancelled', 'AbortError') }
  const line = await generateSimpleRepertoire(options, [], src, controller.signal)
  expect(line.moves).toHaveLength(1); expect(line.termination).toBe('Generation stopped.')
  const advanced = await generateHumanRepertoire({ ...options, maxPlies: 2 }, [], sources())
  expect(advanced.recommendation?.verificationScope).toBe('adaptive')
  expect(advanced.recommendation?.policy).toBeUndefined()
})

it('stops at the computation budget without launching another search', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0), src = sources(), original = src.analyze
  src.analyze = vi.fn<Sources['analyze']>(async (...args) => { const values = await original(...args); clock.mockReturnValue(21000); return values })
  try {
    const line = await generateSimpleRepertoire(options, [], src)
    expect(src.analyze).toHaveBeenCalledTimes(1)
    expect(line.moves).toHaveLength(1)
    expect(line.recommendation?.stopKind).toBe('budget')
    expect(line.status).toBe('incomplete')
  } finally { clock.mockRestore() }
})
it('refreshes cached analysis when its completed PV disagrees with final bestmove', async () => {
  const src = sources()
  src.cached = () => [{ cp: 10, depth: 18, line: ['d2d4'], search: { bestMove: 'e2e4', requestedDepth: 18, achievedDepth: 18, durationMs: 10, queueMs: 0, multiPVComplete: true, endedNaturally: false, stoppedByBudget: true } }]
  src.analyze = vi.fn(async () => [{ cp: 10, depth: 18, line: ['e2e4'] }])
  const line = await generateSimpleRepertoire({ ...options, maxPlies: 1 }, [], src)
  expect(vi.mocked(src.analyze).mock.calls[0][5]).toBe(true)
  expect(line.moves[0].uci).toBe('e2e4')
})
it('resumes the sampling stream as well as the saved history', async () => {
  const whole = await generateSimpleRepertoire({ ...options, humanPolicy: 'simulation' }, [], sources())
  const first = await generateSimpleRepertoire({ ...options, humanPolicy: 'simulation', maxPlies: 2 }, [], sources())
  const resumed = await generateSimpleRepertoire({ ...options, humanPolicy: 'simulation', prefix: first.moves, resume: first, maxPlies: 4 }, [], sources())
  expect(resumed.moves).toEqual(whole.moves)
  expect(resumed.recommendation?.randomDraws).toBe(whole.recommendation?.randomDraws)
})

it('verifies a styled move at full depth and rejects an attractive but unsound alternative', async () => {
  const game = new Chess()
  for (const san of ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6']) game.move(san)
  const fen = game.fen(), opts = { ...options, startFen: fen, maxPlies: 1, style: 'aggressive' as const, styleToleranceCp: 30 }
  const src = sources()
  src.analyze = vi.fn(async (_fen, count, depth, _signal, _timeout, _refresh, searchMoves) => count === 3
    ? [{ cp: 30, depth, line: ['g1f3'] }, { cp: 25, depth, line: ['c2c4'] }, { cp: 10, depth, line: ['b1d2'] }]
    : [{ cp: searchMoves?.[0] === 'c2c4' ? 25 : 30, depth, line: [searchMoves?.[0] || 'g1f3'] }])
  const styled = await generateSimpleRepertoire(opts, [], src)
  expect(styled.moves[0]).toMatchObject({ uci: 'c2c4', style: { lossCp: 5, verifiedDepth: 16 } })
  expect(JSON.parse(JSON.stringify(styled))).toMatchObject({ style: 'aggressive', styleToleranceCp: 30, moves: [{ style: { lossCp: 5 } }] })
  src.analyze = vi.fn(async (_fen, count, depth, _signal, _timeout, _refresh, searchMoves) => count === 3
    ? [{ cp: 30, depth, line: ['g1f3'] }, { cp: 25, depth, line: ['c2c4'] }, { cp: 10, depth, line: ['b1d2'] }]
    : [{ cp: searchMoves?.[0] === 'c2c4' ? -150 : 30, depth, line: [searchMoves?.[0] || 'g1f3'] }])
  const rejected = await generateSimpleRepertoire(opts, [], src)
  expect(rejected.moves[0].uci).toBe('g1f3')
  expect(rejected.moves[0].style).toBeUndefined()
})

it('cancels style discovery without saving an unverified move', async () => {
  const controller = new AbortController(), src = sources()
  src.analyze = async (_fen, count, depth) => {
    if (count === 3) { controller.abort(); throw new DOMException('Cancelled', 'AbortError') }
    return [{ cp: 30, depth, line: ['e2e4'] }]
  }
  await expect(generateSimpleRepertoire({ ...options, freshOpening: false, style: 'aggressive', maxPlies: 1 }, [], src, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it.each(['lichess', 'maia'] as const)('castling preference leaves %s opponent sampling unchanged', async provider => {
  const results = []
  for (const castlingPreference of ['none','kingside','queenside'] as const) {
    const src = sources()
    if (provider === 'maia') {
      src.explorer = async () => ({white:0,draws:0,black:0,source:'lichess',moves:[]})
      src.humanModel = {id:'maia-fixture',version:'1',minRating:1000,maxRating:3000,predict:async (_fen,rating)=>({model:'maia-fixture',version:'1',rating,calibrated:false,moves:[{uci:'e2e4',probability:.6},{uci:'d2d4',probability:.4}]})}
    }
    const line = await generateSimpleRepertoire({...options,side:'black',maxPlies:1,humanPolicy:'simulation',targetRating:1900,mastersFallback:false,castlingPreference},[],src)
    expect(src.analyze).not.toHaveBeenCalled()
    expect(line.castlingPreference).toBe(castlingPreference)
    results.push(line.moves)
  }
  expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0])
})

it('explicit Stockfish uses strongest replies and never calls human sources, even for a fresh opening',async()=>{
 const src=sources();src.humanModel={id:'maia',version:'1',minRating:400,maxRating:3000,predict:vi.fn()}
 const line=await generateSimpleRepertoire({...options,opponentModel:'stockfish',freshOpening:true},[],src)
 expect(line.moves).toHaveLength(6);expect(line.moves.every(m=>m.source==='engine')).toBe(true)
 expect(src.explorer).not.toHaveBeenCalled();expect(src.humanModel.predict).not.toHaveBeenCalled()
 expect(src.analyze).toHaveBeenCalledTimes(6)
 expect(line.generationState).toBe('complete');expect(line.recommendation?.verification).toBe('pending')
 expect(line.moves[1].selectionAnalysis).toEqual({requestedDepth:16,achievedDepth:16,preliminary:false})
})
it('Maia-only bypasses database and preserves target rating and move provenance',async()=>{
 const src=sources();src.humanModel={id:'maia',version:'1',minRating:400,maxRating:3000,predict:vi.fn(async(fen,rating)=>({model:'maia',version:'1',rating,calibrated:false,moves:[{uci:legal(fen)[0],probability:1}]}))}
 const line=await generateSimpleRepertoire({...options,opponentModel:'maia',targetRating:1700},[],src)
 expect(src.explorer).not.toHaveBeenCalled();expect(src.humanModel.predict).toHaveBeenCalledTimes(3)
 expect(line.moves.filter(m=>m.source==='model').every(m=>m.prediction?.rating===1700)).toBe(true)
})
it('database-only never invokes Maia and labels engine fallback',async()=>{
 const src=sources();src.explorer=vi.fn(async()=>({white:0,draws:0,black:0,moves:[]}));src.humanModel={id:'maia',version:'1',minRating:400,maxRating:3000,predict:vi.fn()}
 const line=await generateSimpleRepertoire({...options,opponentModel:'lichess',limitedHumanData:'engine',maxPlies:2},[],src)
 expect(src.humanModel.predict).not.toHaveBeenCalled();expect(line.moves[1]).toMatchObject({source:'engine',engineFallback:true})
})
it('a shallower completed result remains preliminary selection, never deep verification',async()=>{
 const src=sources();src.analyze=vi.fn(async fen=>[{cp:0,depth:9,line:[legal(fen)[0]]}])
 const line=await generateSimpleRepertoire({...options,opponentModel:'stockfish',maxPlies:2},[],src)
 expect(line.moves[1].selectionAnalysis?.preliminary).toBe(true);expect(line.recommendation?.verification).toBe('pending')
})
it('identical moves from different opponent policies retain separate provenance without changing saved lines',async()=>{
 const src=sources();const line=await generateSimpleRepertoire({...options,opponentModel:'stockfish',maxPlies:2},[],src)
 const historical={...line,id:'historical',opponentModel:undefined};const before=JSON.stringify(historical)
 const saved=saveVariation([historical],line)
 expect(saved).toHaveLength(2);expect(JSON.stringify(historical)).toBe(before)
 expect(saveVariation(saved,{...line,id:'duplicate'})).toBe(saved)
})

it('French Advance best style uses Stockfish for both sides despite configured Patricia', async () => {
  const src = sources()
  src.patricia = vi.fn(async () => { throw new Error('Patricia must remain inactive in best style') })
  const settings: Generation = { ...options, startFen: 'rnbqkbnr/ppp2ppp/4p3/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3', opponentModel: 'stockfish', style: 'best', aggressive: { engine: 'patricia', maxLossCp: 30, relaxed: false }, engineDepth: 18, engineTimeoutMs: 30000, maxPlies: 2 }
  const line = await generateSimpleRepertoire(settings, [], src)
  expect(line.moves).toHaveLength(2)
  expect(vi.mocked(src.analyze).mock.calls.map(([fen, count, depth]) => [fen.split(' ')[1], count, depth])).toEqual([['b', 1, 18], ['w', 1, 18]])
  expect(line.moves.every(move => move.source === 'engine' && !move.engineFallback && !move.aggressive)).toBe(true)
  expect(src.explorer).not.toHaveBeenCalled()
  expect(src.patricia).not.toHaveBeenCalled()
  settings.opponentModel = 'maia'; settings.style = 'aggressive'
  expect(JSON.parse(JSON.stringify(line))).toMatchObject({ opponentModel: 'stockfish', style: 'best', engineConfig: { depth: 18, timeoutMs: 30000 }, recommendation: { verification: 'pending', preliminary: true } })
})

it('Stockfish cached selections retain engine provenance on both sides without human requests', async () => {
  const src = sources()
  src.cached = (fen, _count, depth) => [{ cp: 10, depth, line: [legal(fen)[0]] }]
  const line = await generateSimpleRepertoire({ ...options, opponentModel: 'stockfish', maxPlies: 2 }, [], src)
  expect(line.moves).toHaveLength(2)
  expect(line.moves.every(move => move.source === 'engine' && !move.engineFallback && !move.sampling)).toBe(true)
  expect(src.analyze).not.toHaveBeenCalled()
  expect(src.explorer).not.toHaveBeenCalled()
})

it('database-only with available games preserves human selection provenance', async () => {
  const src = sources()
  const line = await generateSimpleRepertoire({ ...options, opponentModel: 'lichess', maxPlies: 2 }, [], src)
  expect(line.moves[0].source).toBe('engine')
  expect(line.moves[1]).toMatchObject({ source: 'lichess', sampling: { eligibleGames: 100 } })
  expect(line.moves[1].engineFallback).toBeUndefined()
  expect(src.analyze).toHaveBeenCalledTimes(1)
})

it.each(['white', 'black'] as const)('database-to-engine mode samples humans then permanently takes over for %s', async side => {
 const src=sources(), original=src.explorer
 let firstFen=''
 src.explorer=vi.fn<Sources['explorer']>(async(...args)=>{ firstFen ||= args[0]; return args[0]===firstFen ? original(...args) : {white:0,draws:0,black:0,moves:[],source:'lichess'} })
 src.humanModel={id:'maia',version:'1',minRating:400,maxRating:3000,predict:vi.fn()}
 const opts: Generation={...options,side,opponentModel:'lichess-stockfish',maxPlies:8,limitedHumanData:'stop',mastersFallback:false}
 const line=await generateSimpleRepertoire(opts,[],src)
 const opponents=line.moves.filter((_,i)=>i%2===(side==='white'?1:0))
 expect(opponents.map(m=>m.source)).toEqual(['lichess','engine','engine','engine'])
 expect(opponents.slice(1).every(m=>m.engineFallback)).toBe(true)
 expect(new Set(vi.mocked(src.explorer).mock.calls.map(c=>c[0])).size).toBe(2)
 expect(src.humanModel.predict).not.toHaveBeenCalled()
 expect(line.opponentTransition).toMatchObject({ply:side==='white'?3:2,issue:'zero-games',reason:'No matching moves.'})
 expect(line.generationSettings).toMatchObject({opponentModel:'lichess-stockfish',side,minPositionGames:20,minMoveGames:5,limitedHumanData:'engine',startPly:0})
 const saved=JSON.stringify(line)
 opts.filters={ratings:[1000],speeds:['bullet']}
 expect(JSON.stringify(line)).toBe(saved)
 const resumedSource=sources()
 const resumed=await generateSimpleRepertoire({...opts,prefix:line.moves,resume:line,maxPlies:2},[],resumedSource)
 expect(resumedSource.explorer).not.toHaveBeenCalled()
 expect(resumed.opponentTransition).toEqual(line.opponentTransition)
 expect(resumed.fallback).toBe(true)
})
it.each([
 ['sparse','insufficient'],['empty','zero-games'],['HTTP 401','authentication'],['HTTP 403','authentication'],['HTTP 429','rate-limit'],['Network offline','network'],['Request timeout','timeout']
])('database-to-engine takeover records %s distinctly', async (kind,issue)=>{
 const src=sources()
 src.explorer=vi.fn(async fen=>kind==='sparse'?{white:2,black:0,draws:0,moves:[{uci:legal(fen)[0],san:'',white:2,black:0,draws:0}]}:kind==='empty'?{white:0,black:0,draws:0,moves:[]}:{white:0,black:0,draws:0,moves:[],unavailableReason:kind})
 const line=await generateSimpleRepertoire({...options,side:'black',opponentModel:'lichess-stockfish',limitedHumanData:'sparse',maxPlies:4},[],src)
 expect(line.moves).toHaveLength(4)
 expect(line.moves.every(m=>m.source==='engine')).toBe(true)
 expect(line.opponentTransition).toMatchObject({ply:0,issue})
 if(kind.startsWith('HTTP'))expect(line.opponentTransition?.reason).toContain(kind)
 expect(new Set(vi.mocked(src.explorer).mock.calls.map(c=>c[0])).size).toBe(1)
})
it('database-to-engine preserves cached human provenance and favors available sound evidence',async()=>{
 const src=sources(),original=src.explorer
 src.explorer=vi.fn<Sources['explorer']>(async(...args)=>({...await original(...args),cache:{state:'cached' as const,retrievedAt:1}}))
 src.cached=(fen,count,depth)=>count===4?[{cp:20,depth,line:[legal(fen)[1]]},{cp:-400,depth,line:[legal(fen)[0]]}]:undefined
 const line=await generateSimpleRepertoire({...options,opponentModel:'lichess-stockfish',side:'black',maxPlies:1,style:'best'},[],src)
 expect(line.moves[0]).toMatchObject({uci:legal(root)[1],source:'lichess',cp:20,depth:16,explorerCache:{state:'cached'},games:20})
 expect(src.analyze).not.toHaveBeenCalled()
 expect(line.opponentTransition).toBeUndefined()
})
it('cancelling database lookup never turns cancellation into a Stockfish takeover',async()=>{
 const src=sources(),controller=new AbortController()
 src.explorer=async()=>{controller.abort();throw new DOMException('Cancelled','AbortError')}
 await expect(generateSimpleRepertoire({...options,side:'black',opponentModel:'lichess-stockfish'},[],src,controller.signal)).rejects.toMatchObject({name:'AbortError'})
 expect(src.analyze).not.toHaveBeenCalled()
})
