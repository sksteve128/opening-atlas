import { Chess } from 'chess.js'
import { expect, it, vi } from 'vitest'
import { material, materialPoint, quietConversion, conversionReady, tacticalEvidence, middlegameEvidence, type ConversionEvidence } from './conversion'
import { generateSimpleRepertoire } from './simpleGeneration'
import { humanPrediction, type HumanModelProvider } from './humanModel'
import { estimateFastSharpness } from './sharpness'
import { lineFen, type Generation, type Sources } from './learning'

const root = new Chess().fen()
const options: Generation = { opening: 'Test', startFen: root, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [1600, 1800, 2000, 2200], speeds: ['rapid'] }, maxPlies: 8, engineDepth: 16, mode: 'here', tolerance: 35, seed: 42 }
const plan = ['a3', 'a6', 'h3', 'h6', 'b3', 'b6', 'g3', 'g6', 'c3', 'c6', 'e3', 'e6']
function fixture(cp = 200): Sources {
  const board = new Chess(), sequence: { fen: string; uci: string }[] = []
  for (const san of plan) { const fen = board.fen(), m = board.move(san); sequence.push({ fen, uci: m.from + m.to }) }
  return {
    analyze: vi.fn(async (fen, count, depth) => {
      const i = sequence.findIndex(p => p.fen === fen)
      return count === 1 ? [{ cp, depth, line: sequence.slice(i).map(p => p.uci) }] : new Chess(fen).moves({ verbose: true }).slice(0, count).map(m => ({ cp, depth, line: [m.from + m.to] }))
    }),
    explorer: vi.fn<Sources['explorer']>(async fen => ({ source: 'lichess', white: 100, draws: 0, black: 0, moves: [{ uci: sequence.find(p => p.fen === fen)!.uci, san: '', white: 100, draws: 0, black: 0 }] })),
  }
}
it('tracks conventional material and equal exchanges without inventing a net gain', () => {
  expect(material(root)).toMatchObject({ white: 39, black: 39 })
  const g = new Chess(); g.move('e4'); g.move('d5'); g.move('exd5')
  const gain = materialPoint(g.fen(), root, 'white', 3)
  expect(gain).toMatchObject({ gain: 1, event: 'Pawn gain' })
  g.move('Qxd5'); expect(materialPoint(g.fen(), root, 'white', 4, gain)).toMatchObject({ gain: 0, event: 'Equal exchange / gain returned' })
})
it('records temporary deficits and material recovery without guessing sacrifice intent', () => {
  const g = new Chess(); g.move('e4'); g.move('d5'); g.move('exd5')
  const deficit = materialPoint(g.fen(), root, 'black', 3); expect(deficit.gain).toBe(-1)
  g.move('Qxd5'); expect(materialPoint(g.fen(), root, 'black', 4, deficit).event).toBe('Material recovered')
})
it('handles promotions, including underpromotion, with actual board totals', () => {
  const fen = '7k/P7/8/8/8/8/8/K7 w - - 0 1', g = new Chess(fen)
  g.move('a8=Q+'); expect(materialPoint(g.fen(), fen, 'white', 1)).toMatchObject({ white: 9, black: 0, gain: 8, event: 'Promotion / material recovery' })
  const knight = new Chess(fen); knight.move('a8=N'); expect(material(knight.fen()).white).toBe(3)
})
it.each([['4k3/8/8/8/8/8/r7/R3K3 w Q - 0 1', 'Rxa2', 5], ['4k3/8/8/8/8/8/q7/R3K3 w Q - 0 1', 'Rxa2', 9], ['4k3/8/8/8/8/8/n7/R3K3 w Q - 0 1', 'Rxa2', 3]])('measures captured material %s', (fen, san, gain) => {
  const g = new Chess(fen as string); g.move(san as string); expect(materialPoint(g.fen(), fen as string, 'white', 1).gain).toBe(gain)
})
it.each(['white', 'black'] as const)('continues after advantage detection and resolves only at a quiet manageable %s decision', async side => {
  const line = await generateSimpleRepertoire({ ...options, side }, [], fixture())
  expect(line.moves.length).toBe(side === 'white' ? 4 : 5)
  expect(line.recommendation?.conversion).toMatchObject({ state: 'resolved', outcome: 'Advantage secured' })
  expect(line.recommendation?.evaluationPly).toBe(line.moves.length)
  expect(line.recommendation?.verification).toBe('pending')
  expect(line.analysis?.points[line.moves.length]?.[side]).toBe(0)
  expect(line.recommendation?.performance?.searches).toBe(5)
})
it('requires configured minimum conversion length, not merely low sharpness', async () => {
  const line = await generateSimpleRepertoire({ ...options, conversionMinPlies: 6 }, [], fixture())
  expect(line.moves).toHaveLength(6)
})
it('allows high sharpness with several sound choices and checked responses', async () => {
  const src = fixture(), decision = estimateFastSharpness(root, ['a2a3', 'h2h3', 'b2b3', 'g2g3'].map(uci => ({ cp: 200, depth: 8, line: [uci] })))!
  src.fastSharpness = fen => ({ fen, white: { ...decision, score: 85 }, whiteProjected: false, blackProjected: false, continuations: [], complete: true, depth: 8 })
  const line = await generateSimpleRepertoire(options, [], src)
  expect(line.moves).toHaveLength(4); expect(line.recommendation?.conversion?.outcome).toBe('Advantage secured')
  expect(line.recommendation?.conversion?.points.at(-1)?.danger?.level).toBe('low')
  expect(line.recommendation?.conversion?.points.some(p => p.difficulty === 85)).toBe(true)
})
it('does not turn fluctuating or shallow evaluations into stable conversion', () => {
  const evidence: ConversionEvidence = { state: 'converting', material: [], detectedPly: 0, points: [200, 400, 160].map((cp, i) => ({ cp, depth: 16, ply: i * 2 })) }
  const entry = { cp: 160, depth: 16, line: [] }
  expect(conversionReady(evidence, 6, entry, undefined, true, 150).stable).toBe(false)
  evidence.points = [0, 2, 4].map(ply => ({ ply, cp: 200, depth: 10 }))
  expect(conversionReady(evidence, 6, entry, undefined, true, 150).stable).toBe(false)
})
it.each([
  ['d4', 'd5', 'Bf4', 'c5', 'e3', 'Nc6', 'b3', 'f6', 'c4', 'cxd4'],
  ['d4', 'd5', 'Bf4', 'c5', 'dxc5', 'e6', 'Nc3', 'Nc6', 'Nb5', 'Qa5+'],
].map(sans => [sans]))('never declares the supplied London tactical endpoint resolved: %j', async sans => {
  const g = new Chess(), prefix = sans.map(san => { const m = g.move(san); return { san: m.san, uci: m.from + m.to, source: 'preset' as const } })
  expect(quietConversion(g.fen(), ['a2a3'], sans)).toBe(false)
  const src = fixture(); src.analyze = async fen => [{ cp: 350, depth: 18, line: new Chess(fen).moves({ verbose: true }).slice(0, 1).map(m => m.from + m.to) }]
  const line = await generateSimpleRepertoire({ ...options, prefix, maxPlies: 1 }, [], src)
  expect(line.moves.slice(0, 10)).toEqual(prefix); expect(line.moves).toHaveLength(11)
  expect(line.recommendation?.conversion?.outcome).toBe('Unresolved'); expect(line.status).toBe('incomplete')
})
it('distinguishes predicted mate from actual checkmate', async () => {
  const src = fixture(); src.analyze = async () => [{ cp: 10000, mate: 3, depth: 16, line: ['a2a3'] }]
  const predicted = await generateSimpleRepertoire({ ...options, maxPlies: 1 }, [], src)
  expect(predicted.recommendation?.conversion).toMatchObject({ state: 'predicted-mate', outcome: 'Unresolved' })
  src.analyze = async () => [{ cp: 10000, mate: 1, depth: 16, line: ['f7g7'] }]
  const mated = await generateSimpleRepertoire({ ...options, startFen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', maxPlies: 1 }, [], src)
  expect(new Chess(lineFen(mated)).isCheckmate()).toBe(true)
  expect(mated.termination).toBe('Checkmate'); expect(mated.status).toBe('complete')
})
it('accepts actual compatible tablebase results and rejects unknown categories', async () => {
  const src = fixture(); src.tablebase = async () => ({ category: 'win', moves: [{ uci: 'f7g7', san: 'Qg7#', category: 'loss' }] })
  const line = await generateSimpleRepertoire({ ...options, startFen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1' }, [], src)
  expect(line.recommendation?.conversion?.outcome).toBe('Theoretical endgame'); expect(src.analyze).not.toHaveBeenCalled()
})
const provider = (): HumanModelProvider => ({ id: 'test-fixture', version: '1', minRating: 1000, maxRating: 2500, predict: vi.fn(async (_fen, rating) => ({ model: 'test-fixture', version: '1', rating, calibrated: false, moves: [{ uci: 'a2a3', probability: 2 }, { uci: 'h2h3', probability: 1 }, { uci: 'a7a6', probability: 3 }] })) })
it('normalizes legal model probabilities, passes rating, and caches transpositions', async () => {
  const model = provider(), cache = new Map(), signal = new AbortController().signal
  const p = await humanPrediction(model, root, 1800, signal, 100, cache)
  expect(p.moves.map(m => m.probability)).toEqual([2 / 3, 1 / 3])
  await humanPrediction(model, root.replace('0 1', '4 3'), 1800, signal, 100, cache)
  expect(model.predict).toHaveBeenCalledTimes(1)
  await expect(humanPrediction(model, root, 3000, signal, 100, cache)).rejects.toThrow('unsupported')
})
it('rejects invalid model probabilities and bounds unresponsive inference', async () => {
  const model = provider(); model.predict = async () => ({ model: model.id, version: model.version, rating: 1800, calibrated: false, moves: [{ uci: 'a2a3', probability: NaN }] })
  await expect(humanPrediction(model, root, 1800, new AbortController().signal, 100, new Map())).rejects.toThrow('Invalid')
  model.predict = () => new Promise(() => {})
  await expect(humanPrediction(model, root, 1800, new AbortController().signal, 10, new Map())).rejects.toThrow()
  const controller = new AbortController(); controller.abort()
  await expect(humanPrediction(model, root, 1800, controller.signal, 100, new Map())).rejects.toThrow()
})
it('samples model fallback reproducibly with provenance and no invented Lichess frequency', async () => {
  const src = fixture(); src.explorer = async () => ({ source: 'lichess', white: 0, draws: 0, black: 0, moves: [] }); src.humanModel = provider()
  const opts = { ...options, side: 'black' as const, maxPlies: 1, targetRating: 1800 }
  const a = await generateSimpleRepertoire(opts, [], src), b = await generateSimpleRepertoire(opts, [], src)
  expect(a.moves).toEqual(b.moves); expect(a.moves[0]).toMatchObject({ source: 'model', prediction: { model: 'test-fixture', version: '1', rating: 1800, calibrated: false } })
  expect(a.moves[0].sampling).toBeUndefined(); expect(a.moves[0].games).toBeUndefined()
  expect(JSON.parse(JSON.stringify(a)).recommendation.conversion.material).toHaveLength(2)
})
it('does not invoke a model when observed human evidence is sufficient', async () => {
  const src = fixture(); src.humanModel = provider()
  await generateSimpleRepertoire({ ...options, side: 'black', maxPlies: 1 }, [], src)
  expect(src.humanModel.predict).not.toHaveBeenCalled()
})
it('respects disabled Masters fallback and marks missing human models unresolved', async () => {
  const src = fixture(); src.explorer = vi.fn(async () => ({ source: 'lichess' as const, white: 0, draws: 0, black: 0, moves: [] }))
  const line = await generateSimpleRepertoire({ ...options, side: 'black', mastersFallback: false }, [], src)
  expect(src.explorer).toHaveBeenCalledTimes(3)
  expect(line.recommendation?.conversion?.modelStatus).toContain('unavailable')
  expect(line.status).toBe('incomplete')
})
it('recognizes an exchange gain from piece composition rather than two pawns', () => {
  const start = '4k3/8/8/8/8/8/r7/N3K3 w - - 0 1'
  const end = '4k3/8/8/8/8/8/8/4K3 w - - 0 2'
  expect(materialPoint(end, start, 'white', 2)).toMatchObject({ gain: 2, event: 'Exchange gain' })
})
it('retains generated moves and reports an explicit generation-budget outcome', async () => {
  const src = fixture(), clock = vi.spyOn(Date, 'now').mockReturnValue(0), original = src.analyze
  src.analyze = async (...args) => { const result = await original(...args); clock.mockReturnValue(1000); return result }
  try {
    const line = await generateSimpleRepertoire({ ...options, maxMs: 500 }, [], src)
    expect(line.moves).toHaveLength(1); expect(line.termination).toBe('Unresolved — time budget')
    expect(line.recommendation?.conversion?.outcome).toBe('Unresolved')
  } finally { clock.mockRestore() }
})
it('has no total time limit when generation does not request one', async () => {
  const src = fixture(0), clock = vi.spyOn(Date, 'now').mockReturnValue(0), original = src.analyze
  src.analyze = async (...args) => { const result = await original(...args); clock.mockReturnValue(200000); return result }
  try {
    const line = await generateSimpleRepertoire({ ...options, maxPlies: 2 }, [], src)
    expect(line.moves).toHaveLength(2)
    expect(line.termination).toBe('Unresolved — length limit')
  } finally { clock.mockRestore() }
})
it('does not mislabel a knight-for-pawn gain as two pawn gains', () => {
  const g = new Chess()
  for (const san of ['d4', 'd5', 'Bf4', 'c5', 'dxc5', 'e6', 'Nc3', 'Nc6', 'Nb5', 'Qa5+', 'Nc3', 'd4', 'Bd2', 'dxc3']) g.move(san)
  expect(materialPoint(g.fen(), root, 'black', 14)).toMatchObject({ gain: 2, event: 'Minor-piece gain' })
})

it('does not confuse a move number with a developed, king-safe middlegame', () => {
  expect(middlegameEvidence(root.replace('0 1', '0 20')).suitable).toBe(false)
  const g = new Chess(); for (const san of ['e4','e5','Nf3','Nc6','Bc4','Bc5','O-O','Nf6','d3','O-O','Nc3','d6','h3','a6']) g.move(san)
  expect(middlegameEvidence(g.fen()).suitable).toBe(true)
})
it.each(['white','black'] as const)('reaches an equal middlegame for %s without claiming an advantage', async side => {
  const g = new Chess(); for (const san of ['e4','e5','Nf3','Nc6','Bc4','Bc5','O-O','Nf6','d3','O-O','Nc3','d6','h3','a6']) g.move(san)
  const startFen = g.fen(), sequence = ['a3','h6','Re1','Re8','Ba2','Ba7','Be3','Be6','Qd2','Qd7']
  const positions = sequence.map(san => { const fen = g.fen(), m = g.move(san); return {fen,uci:m.from+m.to} })
  const src: Sources = {
    explorer: async fen => ({source:'lichess',white:100,black:0,draws:0,moves:[{uci:positions.find(p=>p.fen===fen)!.uci,san:'',white:100,black:0,draws:0}]}),
    analyze: async (fen,count,depth,_s,_t,_r,restricted) => {
      const i=positions.findIndex(p=>p.fen===fen)
      if(count===1 && !restricted && i>=0) return [{cp:0,depth,line:positions.slice(i).map(p=>p.uci)}]
      const board=new Chess(fen), legal=board.moves({verbose:true}).filter(m=>!restricted||restricted.includes(m.from+m.to))
      return legal.sort((a,b)=>Number(!!a.captured||/[+#]/.test(a.san))-Number(!!b.captured||/[+#]/.test(b.san))).slice(0,count).map(m=>({cp:0,depth,line:[m.from+m.to]}))
    }
  }
  const line = await generateSimpleRepertoire({...options,side,startFen,maxPlies:8},[],src)
  expect(line.termination).toBe('Sound middlegame reached'); expect(line.status).toBe('instructional')
  expect(line.recommendation?.conversion?.detectedPly).toBeUndefined()
  expect(line.recommendation?.verification).toBe('pending')
})
// White is up a rook; ...Bb4+ is legal but has several quiet king responses.
const checkFen = '4k3/8/8/2b5/8/8/P7/R3K2R w KQ - 0 15'
const checkEntry = {cp:700,depth:16,line:['a2a3','c5b4','e1f2','b4c5']}
const replies = (cp: number, onlyOne = false): Sources['analyze'] => async (fen,count,depth) => count===1
  ? [{cp:-700,depth,line:['c5b4']}]
  : new Chess(fen).moves({verbose:true}).filter(m=>!m.captured).slice(0,4).map((m,i)=>({cp:cp-(onlyOne&&i?300:0),depth,line:[m.from+m.to]}))
it('permits a harmless checking reply when multiple quiet responses preserve the advantage', async () => {
  expect((await tacticalEvidence(checkFen,checkEntry,replies(700))).level).toBe('low')
})
it('rejects a material advantage when a forcing reply needs a critical response', async () => {
  expect((await tacticalEvidence(checkFen,checkEntry,replies(700,true))).level).toBe('critical')
})
it('rejects a hidden evaluation threat even if the response difficulty would be low', async () => {
  expect((await tacticalEvidence(checkFen,checkEntry,replies(100))).level).toBe('critical')
})
it('keeps incomplete, shallow and failed threat checks uncertain', async () => {
  expect((await tacticalEvidence(checkFen,checkEntry,async()=>[])).level).toBe('unknown')
  expect((await tacticalEvidence(checkFen,checkEntry,async()=>{throw Error('timeout')})).level).toBe('unknown')
  expect((await tacticalEvidence(checkFen,checkEntry,async()=>[{cp:-700,depth:4,line:['c5b4']}])).level).toBe('unknown')
})
it('continues past a check, sacrifice, or unresolved capture even with a low difficulty estimate', () => {
  expect(quietConversion(checkFen,checkEntry.line,['Bxc3'])).toBe(false)
  expect(quietConversion(checkFen,['h1h8','e8d7','h8h7','d7c6'],['a6'])).toBe(false)
  const g=new Chess(checkFen);g.move('a3');g.move('Bb4+')
  expect(quietConversion(g.fen(),['e1f2','b4c5','f2g3','c5d6'],['Bb4+'])).toBe(false)
})
it('preserves partial lines, practice stats and legacy saved outcomes on resume', async () => {
  const first=await generateSimpleRepertoire({...options,maxPlies:2},[],fixture(0))
  first.stats.errors=3;first.stats.completions=2
  first.recommendation!.conversion!.outcome='Positional advantage stabilized'
  const saved=JSON.parse(JSON.stringify(first))
  const next=await generateSimpleRepertoire({...options,prefix:saved.moves,resume:saved,maxPlies:2},[],fixture(0))
  expect(next.id).toBe(first.id);expect(next.moves).toHaveLength(4);expect(next.stats).toEqual(first.stats)
  expect(next.termination).toBe('Unresolved — length limit');expect(next.status).toBe('incomplete')
})
it.each([['b1b2','low'],['d1b3','critical']])('distinguishes ordinary recapture %s from a critical non-recapture', async (response, level) => {
  const fen='4k3/8/8/8/8/2b5/1P4PP/1R1Q2K1 w - - 0 15'
  const entry={cp:900,depth:18,line:['h2h3','c3b2','b1b2','e8d7']}
  const src: Sources['analyze']=async (position,count,depth)=>count===1
    ? [{cp:-900,depth,line:['c3b2']}]
    : [{cp:900,depth,line:[response]},...new Chess(position).moves({verbose:true}).filter(m=>m.from+m.to!==response).slice(0,3).map(m=>({cp:400,depth,line:[m.from+m.to]}))]
  expect((await tacticalEvidence(fen,entry,src)).level).toBe(level)
})
it('does not require winning bonus material after an inferior check', async () => {
  const source: Sources['analyze']=async (fen,count,depth)=> count===1 ? [{cp:-700,depth,line:['c5b4']}]
    : new Chess(fen).moves({verbose:true}).filter(m=>!m.captured).slice(0,4).map((m,i)=>({cp:i?700:1000,depth,line:[m.from+m.to]}))
  const result=await tacticalEvidence(checkFen,checkEntry,source)
  expect(result.level).toBe('low');expect(result.responseChoices).toBeGreaterThanOrEqual(2)
})
