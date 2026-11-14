import 'fake-indexeddb/auto'
import { Chess } from 'chess.js'
import { expect, it, vi } from 'vitest'
import { aggressiveCandidate } from './aggressiveGeneration'
import { generateVariation, type Generation, type Sources } from './learning'
import { generateSimpleRepertoire } from './simpleGeneration'

const game = new Chess(); for (const san of ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6']) game.move(san)
const fen = game.fen(), best = { cp: 30, depth: 16, line: ['g1f3'] }
const allowed = game.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''))
const options: Generation = { opening: 'London', startFen: fen, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2000], speeds: ['rapid'] }, maxPlies: 1, maxMs: 60000, engineDepth: 16, tolerance: 35, mode: 'here', playMode: 'complete', style: 'aggressive', aggressive: { engine: 'patricia', maxLossCp: 30, relaxed: false } }
function sources(loss = 10): Sources {
  return { explorer: async () => ({ source: 'book', white: 0, draws: 0, black: 0, moves: [] }),
    patricia: vi.fn(async () => ({ move: 'c2c4', version: 'test', queueMs: 0, durationMs: 1 })),
    analyze: vi.fn(async (_fen, _count, depth, _signal, _timeout, _refresh, restrict) => [{ cp: restrict ? 30 - loss : 30, depth, line: [restrict?.[0] || 'g1f3'] }]) }
}
const run = (s = sources(), o = options, b = best) => aggressiveCandidate(fen, b, o, s, allowed, Date.now() + 60000)
it.each([10, 15, 20, 30])('accepts a meaningful style gain with %i cp verified loss', async loss => {
  const result = await run(sources(loss)); expect(result.entry.line[0]).toBe('c2c4'); expect(result.decision).toMatchObject({ lossCp: loss, verifiedDepth: 16, rejected: false })
})
it.each([31, 51])('rejects %i cp outside default tolerance', async loss => { expect((await run(sources(loss))).entry).toBe(best) })
it('requires opt-in and deeper stable verification for relaxed loss', async () => {
  const s = sources(40), o = { ...options, aggressive: { ...options.aggressive!, maxLossCp: 50, relaxed: true } }
  const result = await run(s, o); expect(result.decision).toMatchObject({ rejected: false, verifiedDepth: 18 }); expect(s.analyze).toHaveBeenCalledTimes(3)
})
it('keeps Stockfish when Patricia is absent, crashes, or returns illegal output', async () => {
  for (const provider of [undefined, vi.fn(async () => { throw new Error('process crashed') }), vi.fn(async () => ({ move: 'a1a8', version: 'bad', durationMs: 0, queueMs: 0 }))]) {
    const s = sources(); s.patricia = provider; const result = await run(s); expect(result.entry).toBe(best); expect(result.decision.rejected).toBe(true)
  }
})
it('does no verification when both engines propose the same move', async () => {
  const s = sources(); s.patricia = async () => ({ move: 'g1f3', version: 'test', durationMs: 0, queueMs: 0 })
  expect((await run(s)).decision.reason).toMatch(/Same move/); expect(s.analyze).not.toHaveBeenCalled()
})
it('rejects mates, incomplete analysis, and cloud evaluations as verification', async () => {
  for (const extra of [{ mate: 3 }, { depth: 12 }, { source: 'cloud' as const }, { cp: NaN }]) {
    const s = sources(); s.analyze = async () => [{ cp: 20, depth: 16, line: ['c2c4'], ...extra }]; expect((await run(s)).entry).toBe(best)
  }
  const s = sources(); await run(s, options, { ...best, mate: 5 } as typeof best); expect(s.patricia).not.toHaveBeenCalled()
})
it('rejects unstable deeper evaluations', async () => {
  const s = sources(40); s.analyze = async (_fen, _count, depth, _signal, _timeout, _refresh, restrict) => [{ cp: restrict ? depth > 16 ? -90 : -10 : 30, depth, line: [restrict?.[0] || 'g1f3'] }]
  expect((await run(s, { ...options, aggressive: { ...options.aggressive!, relaxed: true, maxLossCp: 50 } })).decision.reason).toMatch(/Unstable/)
})
it('does not treat missing or sparse zero sharpness as evidence that a tactical position is quiet', async () => {
  const s = sources(); expect((await run(s)).decision.consulted).toBe(true)
  const tactical = new Chess('r3k2r/ppp2ppp/2n1bn2/3qp3/3PP3/2N1BN2/PPP2PPP/R2QK2R w KQkq - 0 1')
  s.fastSharpness = () => ({ white: { score: 0, preliminary: true, coverage: 0.1 } } as never)
  const result = await aggressiveCandidate(tactical.fen(), { ...best, line: ['a2a3'] }, options, s, tactical.moves({verbose:true}).map(m=>m.from+m.to), Date.now()+60000)
  expect(result.decision.consulted).toBe(false)
})
it('keeps side-to-move scores consistent for Black and never proposes on the opponent turn', async () => {
  const blackFen = fen.replace(' w ', ' b '), s = sources(); s.patricia = async () => ({ move: 'c7c5', version: 'test', durationMs: 0, queueMs: 0 })
  s.analyze = async (_f,_n,depth,_s,_t,_r,moves) => [{cp:20,depth,line:[moves?.[0] || 'b8c6']}]
  const legal = new Chess(blackFen).moves({verbose:true}).map(m=>m.from+m.to)
  const result = await aggressiveCandidate(blackFen, { ...best, line: ['b8c6'] }, { ...options, side:'black' }, s, legal, Date.now()+60000)
  expect(result.decision).toMatchObject({ rejected: false, lossCp: 10 })
  expect((await aggressiveCandidate(blackFen, best, options, s, legal, Date.now()+60000)).decision.consulted).toBe(false)
})
it('does not reward castling rights alone and preserves explicit castling preference', async () => {
  const a = await run(sources(), { ...options, castlingPreference: 'queenside' }); const b = await run()
  expect(a.entry).toEqual(b.entry)
  const s = sources(); s.patricia = async () => ({ move: 'b1d2', version:'test',durationMs:0,queueMs:0 })
  expect((await run(s, { ...options, castlingPreference:'queenside' })).decision.reason).toMatch(/No meaningful/)
})
it('preserves cancellation and uses Stockfish for verification failures', async () => {
  const s = sources(); s.analyze = async () => { throw new Error('timeout') }; expect((await run(s)).entry).toBe(best)
  const abort = new AbortController(); abort.abort(); await expect(aggressiveCandidate(fen,best,options,s,allowed,Date.now()+60000,abort.signal)).rejects.toBeDefined()
})
it('persists diagnostics in a generated variation and leaves Best move untouched', async () => {
  const s = sources(); const line = await generateSimpleRepertoire({ ...options, playMode:'advantage' }, [], s)
  expect(JSON.parse(JSON.stringify(line)).moves[0].aggressive).toMatchObject({ proposed:'c2c4', selected:'c2c4', rejected:false })
  const normal = sources(); await generateSimpleRepertoire({ ...options, playMode:'advantage', style:'best' }, [], normal); expect(normal.patricia).not.toHaveBeenCalled()
})
it('preserves legacy aggressive saved configurations without the new engine option', async () => {
  const s = sources(); s.analyze = async (_f,n,depth,_s,_t,_r,moves) => n===4 ? ['g1f3','c2c4','b1d2','f1d3'].map((uci,i)=>({cp:30-i*5,depth,line:[uci]})) : [{ cp:25,depth,line:[moves?.[0] || 'g1f3'] }]
  const line = await generateVariation({ ...options, aggressive:undefined }, [], s); expect(line.style).toBe('aggressive'); expect(s.patricia).not.toHaveBeenCalled()
})
it('does not change seeded opponent sampling or its probabilities', async () => {
  const s = sources(); s.explorer = async position => {
    const legal = new Chess(position).moves({verbose:true}).slice(0,3)
    return {source:'lichess',white:90,draws:0,black:0,moves:legal.map((m,i)=>({uci:m.from+m.to+(m.promotion||''),san:m.san,white:[50,30,10][i],draws:0,black:0}))}
  }
  const o = { ...options, side:'black' as const, playMode:'advantage' as const, seed:42, humanPolicy:'simulation' as const }
  const baseline = await generateSimpleRepertoire({...o,style:'best'},[],s)
  const hybrid = await generateSimpleRepertoire(o,[],s)
  expect(hybrid.moves).toEqual(baseline.moves); expect(hybrid.recommendation?.randomDraws).toBe(baseline.recommendation?.randomDraws); expect(s.patricia).not.toHaveBeenCalled()
})
it('round-trips Patricia metadata through the existing saved-record store', async () => {
  const {writeVariations,readVariations}=await import('./data')
  const line=await generateSimpleRepertoire({...options,playMode:'advantage'},[],sources())
  await writeVariations([line]); const saved=await readVariations()
  expect(saved![0].aggressive).toEqual(options.aggressive); expect(saved![0].moves[0].aggressive).toEqual(line.moves[0].aggressive)
})
