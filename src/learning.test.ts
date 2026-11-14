import { Chess } from 'chess.js'
import { expect, it } from 'vitest'
import { PRESETS, identity, type ExplorerData } from './core'
import { continuationsAt, describeLineMove, generateVariation, lineFen, modelFallbackReason, moveNumber, nextLineIndex, restoreActiveLine, restoreTrainingSide, reviewMoveIndex, reviewPosition, saveVariation, waitingForGeneratedMove, type Generation, type LineMove, type Sources, type Variation } from './learning'

it('advances a selected line when its next move is played', () => {
  const line = { moves: [{ uci: 'f8c5' }, { uci: 'e1g1' }] } as Variation
  expect(nextLineIndex(line, 0, 'f8c5')).toBe(1)
  expect(nextLineIndex(line, 1, 'e1g1')).toBe(2)
  expect(nextLineIndex(line, 0, 'g8f6')).toBeNull()
  expect(nextLineIndex(line, 2, 'f8c5')).toBeNull()
})

it('keeps generated Maia attribution distinct from an Explorer outage after reload', () => {
  const game = new Chess(); for (const san of ['e4', 'c5', 'Nf3']) game.move(san)
  const line = JSON.parse(JSON.stringify({ moves: [{ source: 'model', san: 'd6', prediction: { probability: .147 } }], recommendation: { populationAttempts: [{ ply: 0, issue: 'rate-limit', error: 'Lichess rate limit reached' }] } })) as Variation
  expect(moveNumber(game.fen(), line.moves[0].san)).toBe('2...d6')
  expect(modelFallbackReason(line, 0)).toBe('Explorer rate limited')
  expect(modelFallbackReason({ ...line, recommendation: undefined }, 0)).toBe('reason unavailable in saved record')
})

it('waits at the generated edge only while live practice is still building', () => {
  expect(waitingForGeneratedMove(2, 2, true, true)).toBe(true)
  expect(waitingForGeneratedMove(2, 3, true, true)).toBe(false)
  expect(waitingForGeneratedMove(2, 2, false, true)).toBe(false)
})

it('limits practice review to positions already reached', () => {
  expect([-1, 2, 99].map(position => reviewPosition(position, 4))).toEqual([0, 2, 4])
})

it('restores the active line from its snapshot when the saved database is missing or stale', () => {
  const old = { id: 'line-1', moves: [{ uci: 'e2e4' }] } as Variation
  const latest = { ...old, moves: [...old.moves, { uci: 'e7e5' }] } as Variation
  expect(restoreActiveLine([], latest, 'line-1')).toEqual([latest])
  expect(restoreActiveLine([old], latest, 'line-1')).toEqual([latest])
  expect(restoreActiveLine([old], latest, 'another-line')).toEqual([old])
})

it('uses the displayed root for imported, midpoint, endpoint, and arbitrary FEN generation', async () => {
  const game = new Chess(), moves: LineMove[] = []
  for (const san of ['e4', 'e5', 'Nf3']) { const move = game.move(san); moves.push({ uci: move.from + move.to, san: move.san, source: 'import' }) }
  const imported = { id: 'imported', startFen: new Chess().fen(), moves, opening: 'Imported PGN', side: 'white', database: 'lichess' } as Variation
  const filters = { ratings: [1800], speeds: ['rapid'] }
  const sources: Sources = { explorer: async () => ({ white: 0, draws: 0, black: 0, moves: [], source: 'book' }), analyze: async fen => [{ cp: 20, depth: 12, line: [fen.split(' ')[1] === 'b' ? 'b8c6' : 'd2d4'] }] }
  const base: Generation = { opening: 'Imported PGN', startFen: imported.startFen, prefix: [], side: 'white', database: 'lichess', filters, maxPlies: 1, engineDepth: 12, tolerance: 35, mode: 'main', playMode: 'mainline' }
  for (const count of [2, 3]) {
    const rootFen = lineFen(imported, count)
    const line = await generateVariation({ ...base, prefix: moves.slice(0, count), rootFen, parentId: imported.id }, [imported], sources)
    expect(lineFen(line, count)).toBe(rootFen)
    expect(line.moves).toHaveLength(count + 1)
    expect(line.parentId).toBe(imported.id)
  }
  const arbitrary = lineFen(imported, 1)
  const line = await generateVariation({ ...base, startFen: arbitrary, rootFen: arbitrary, prefix: [], side: 'black' }, [], { ...sources, analyze: async () => [{ cp: 10, depth: 12, line: ['e7e5'] }] })
  expect(line.startFen).toBe(arbitrary)
  expect(line.moves[0].uci).toBe('e7e5')
  await expect(generateVariation({ ...base, rootFen: arbitrary }, [], sources)).rejects.toThrow('Displayed board and move history disagree')
})

it('combines saved continuations by legal position, including transposed paths', () => {
  const build = (sans: string[], id: string) => { const game = new Chess(); return { id, startFen: game.fen(), moves: sans.map(san => { const move = game.move(san); return { uci: move.from + move.to, san: move.san, source: 'import' as const } }) } as Variation }
  const a = build(['Nf3', 'd5', 'g3', 'Nf6', 'Bg2', 'e6', 'O-O', 'Be7'], 'a')
  const b = build(['g3', 'd5', 'Nf3', 'Nf6', 'Bg2', 'e6', 'O-O', 'Be7'], 'b')
  const root = lineFen(a, 7)
  expect(identity(root)).toBe(identity(lineFen(b, 7)))
  expect(continuationsAt([a, b], root, 'b')).toMatchObject({ covered: ['f8e7'], parentId: 'b' })
})

it('describes the next move for the correct side, including castling', () => {
  const game = new Chess()
  const e4: LineMove = { uci: 'e2e4', san: 'e4', source: 'import' }
  expect(describeLineMove(game.fen(), e4, 'white')).toEqual({ title: 'Play 1.e4', detail: 'Move the pawn from e2 to e4.' })
  expect(describeLineMove(game.fen(), e4, 'black').title).toBe('White plays 1.e4')
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']) game.move(san)
  expect(describeLineMove(game.fen(), { uci: 'e1g1', san: 'O-O', source: 'import' }, 'white').detail).toBe('Castle kingside.')
})

it('generates a sound line and discovers the next opponent branch after the selected opening', async () => {
  const game = new Chess(), prefix: LineMove[] = []
  PRESETS[2].moves.forEach(san => { const move = game.move(san); prefix.push({ uci: move.from + move.to, san: move.san, source: 'preset' }) })
  const branchFen = game.fen()
  const sources: Sources = {
    explorer: async fen => ({ white: fen === branchFen ? 100 : 0, draws: 0, black: 0, moves: fen === branchFen ? [{ uci: 'f8c5', san: 'Bc5', white: 70, draws: 0, black: 0 }, { uci: 'g8f6', san: 'Nf6', white: 30, draws: 0, black: 0 }] : [], source: 'lichess' } satisfies ExplorerData),
    analyze: async fen => [{ cp: 20, depth: 10, line: [fen.includes('2b1p3') ? 'd2d3' : 'c2c3'] }],
  }
  const options: Generation = { opening: 'Italian', startFen: new Chess().fen(), prefix, side: 'white', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, maxPlies: 2, engineDepth: 10, tolerance: 35, mode: 'main', playMode: 'human' }
  const first = await generateVariation(options, [], sources)
  const second = await generateVariation({ ...options, mode: 'next' }, [first], sources)
  expect(first.moves[5].uci).toBe('f8c5')
  expect(first.moves[6].source).toBe('engine')
  expect(second.moves[5].uci).toBe('g8f6')
  expect(second.name).toContain('3...Nf6')
  expect(second.parentId).toBe(first.id)
  expect(second.fallback).toBe(false)
  expect(saveVariation([first], first)).toHaveLength(1)
})

it('uses the same root operation to choose an uncovered human opponent deviation', async () => {
  const game = new Chess(), prefix: LineMove[] = []
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']) { const move = game.move(san); prefix.push({ uci: move.from + move.to, san: move.san, source: 'preset' }) }
  const rootFen = game.fen()
  const existing = { id: 'first', startFen: new Chess().fen(), moves: [...prefix, { uci: 'f8c5', san: 'Bc5', source: 'lichess' }] } as Variation
  const options: Generation = { opening: 'Italian Game', startFen: existing.startFen, prefix, rootFen, excludeRootMoves: continuationsAt([existing], rootFen).covered, parentId: existing.id, side: 'white', database: 'lichess', filters: { ratings: [1800], speeds: ['rapid'] }, maxPlies: 1, engineDepth: 12, tolerance: 35, mode: 'main', playMode: 'mainline' }
  const sources: Sources = { explorer: async () => ({ white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'f8c5', san: 'Bc5', white: 70, draws: 0, black: 0 }, { uci: 'g8f6', san: 'Nf6', white: 30, draws: 0, black: 0 }] }), analyze: async () => [{ cp: 15, depth: 12, line: ['f8c5'] }, { cp: 5, depth: 12, line: ['g8f6'] }] }
  const line = await generateVariation(options, [existing], sources)
  expect(line.moves.at(-1)?.uci).toBe('g8f6')
  expect(line.name).toContain('3...Nf6')
  expect(line.parentId).toBe(existing.id)
  await expect(generateVariation({ ...options, excludeRootMoves: ['f8c5', 'g8f6'] }, [existing], sources)).rejects.toThrow('No uncovered human opponent move')
})

it('prefers a measured critical position when both human moves are sound', async () => {
  const start = new Chess().fen()
  const afterE4 = new Chess(); afterE4.move('e4')
  const sources: Sources = {
    explorer: async () => ({ white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'e2e4', san: 'e4', white: 60, draws: 0, black: 0 }, { uci: 'd2d4', san: 'd4', white: 40, draws: 0, black: 0 }] }),
    analyze: async fen => fen === start ? [{ cp: 20, depth: 12, line: ['e2e4'] }, { cp: 15, depth: 12, line: ['d2d4'] }] : new Chess(fen).moves({ verbose: true }).slice(0, 4).map((move, index) => ({ cp: fen === afterE4.fen() ? 20 - index * 5 : 20 - index * 100, depth: 12, line: [move.from + move.to] })),
  }
  const options: Generation = { opening: 'Test', startFen: start, prefix: [], rootFen: start, side: 'white', database: 'lichess', filters: { ratings: [1800], speeds: ['rapid'] }, maxPlies: 1, engineDepth: 12, tolerance: 35, mode: 'main', playMode: 'mainline' }
  expect((await generateVariation(options, [], sources)).moves[0].uci).toBe('e2e4')
  expect((await generateVariation({ ...options, sharpnessPreference: 'critical' }, [], sources)).moves[0].uci).toBe('d2d4')
})

it('uses human frequency for the opponent and prefers a practical engine-sound response', async () => {
  const game = new Chess(), prefix: LineMove[] = []
  PRESETS[2].moves.forEach(san => { const move = game.move(san); prefix.push({ uci: move.from + move.to, san: move.san, source: 'preset' }) })
  const branchFen = game.fen()
  const afterBc5 = new Chess(branchFen); afterBc5.move('Bc5')
  const sources: Sources = {
    explorer: async fen => fen === branchFen ? { white: 50, draws: 20, black: 30, source: 'lichess', moves: [{ uci: 'g8f6', san: 'Nf6', white: 15, draws: 5, black: 10 }, { uci: 'f8c5', san: 'Bc5', white: 35, draws: 15, black: 20 }] } : fen === afterBc5.fen() ? { white: 50, draws: 20, black: 30, source: 'lichess', moves: [{ uci: 'c2c3', san: 'c3', white: 30, draws: 15, black: 15 }, { uci: 'd2d3', san: 'd3', white: 20, draws: 5, black: 15 }] } : { white: 0, draws: 0, black: 0, source: 'lichess', moves: [] },
    analyze: async () => [{ cp: 20, depth: 12, line: ['d2d3'] }, { cp: 5, depth: 12, line: ['c2c3'] }],
  }
  const line = await generateVariation({ opening: 'Italian', startFen: new Chess().fen(), prefix, side: 'white', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, maxPlies: 2, engineDepth: 12, tolerance: 20, mode: 'main', playMode: 'human' }, [], sources)
  expect(line.moves.slice(5).map(move => move.uci)).toEqual(['f8c5', 'c2c3'])
  expect(line.moves[5].frequency).toBe(0.7)
  expect(line.moves[6]).toMatchObject({ source: 'engine', cp: 5, depth: 12, frequency: 0.6 })
  expect(line.fallback).toBe(false)
})

it('marks checkmate complete and does not mistake a zero evaluation for a draw', async () => {
  const mateFen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1'
  const sources: Sources = {
    explorer: async () => ({ white: 0, draws: 0, black: 0, moves: [], source: 'book' }),
    analyze: async () => [{ cp: 0, depth: 10, line: ['f7g7'] }],
  }
  const options: Generation = { opening: 'Mate test', startFen: mateFen, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, maxPlies: 1, engineDepth: 10, tolerance: 35, mode: 'main' }
  const line = await generateVariation(options, [], sources)
  expect(line).toMatchObject({ status: 'complete', result: '1-0', termination: 'Checkmate' })
  const replay = new Chess()
  replay.loadPgn(line.pgn)
  expect(replay.isCheckmate()).toBe(true)
  expect(replay.history()).toHaveLength(1)
  const incomplete = await generateVariation({ ...options, startFen: new Chess().fen() }, [], { ...sources, analyze: async () => [{ cp: 0, depth: 10, line: ['e2e4'] }] })
  expect(incomplete.status).toBe('incomplete')
  expect(incomplete.result).toBeUndefined()
  expect(incomplete.termination).toBe('Move budget reached')
})

it('distinguishes claimable draws from automatic draw rules', async () => {
  const { terminal } = await import('./learning')
  const game = new Chess()
  for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) game.move(san)
  expect(game.isThreefoldRepetition()).toBe(true)
  expect(terminal(game, 3)?.reason).toBe('Threefold repetition claimed')
  expect(terminal(game, 5)?.reason).toBe('Fivefold repetition')
  expect(terminal(new Chess('k7/8/2K5/4Q3/8/8/8/8 w - - 100 1'), 1)?.reason).toBe('Fifty-move draw claimed')
  expect(terminal(new Chess('k7/8/2K5/4Q3/8/8/8/8 w - - 150 1'), 1)?.reason).toBe('Seventy-five-move rule')
})

it('stops at an exact tablebase outcome without inventing a conversion sequence', async () => {
  const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1'
  let engineCalls = 0
  const line = await generateVariation({ opening: 'Endgame', startFen: fen, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, maxPlies: 8, engineDepth: 10, tolerance: 35, mode: 'main' }, [], {
    explorer: async () => ({ white: 0, draws: 0, black: 0, moves: [], source: 'book' }),
    analyze: async () => { engineCalls++; return [] },
    tablebase: async () => ({ category: 'win', moves: [{ uci: 'f7g7', san: 'Qg7#', category: 'loss', dtm: -1 }] }),
  })
  expect(line.moves).toHaveLength(0)
  expect(line.status).toBe('instructional')
  expect(line.termination).toBe('Tablebase win — White wins.')
  expect(engineCalls).toBe(0)
})

it('saves cancelled work and resumes from its last legal move', async () => {
  const controller = new AbortController()
  const options: Generation = { opening: 'Start', startFen: new Chess().fen(), prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, maxPlies: 2, engineDepth: 10, tolerance: 35, mode: 'main' }
  const sources: Sources = {
    explorer: async () => ({ white: 0, draws: 0, black: 0, moves: [], source: 'book' }),
    analyze: async fen => [{ cp: 10, depth: 10, line: [fen.split(' ')[1] === 'w' ? 'e2e4' : 'e7e5'] }],
  }
  const partial = await generateVariation(options, [], sources, controller.signal, line => { if (line.moves.length === 1) controller.abort() })
  expect(partial).toMatchObject({ status: 'incomplete', termination: 'Cancelled' })
  expect(partial.moves.map(move => move.uci)).toEqual(['e2e4'])
  const resumed = await generateVariation({ ...options, resume: partial, maxPlies: 1 }, [partial], sources)
  expect(resumed.id).toBe(partial.id)
  expect(resumed.moves.map(move => move.uci)).toEqual(['e2e4', 'e7e5'])
  const replay = new Chess()
  replay.loadPgn(resumed.pgn)
  expect(replay.history()).toEqual(['e4', 'e5'])
})

it('falls back to Stockfish when human-game data disappears', async () => {
  const firstFen = new Chess().fen()
  const options: Generation = { opening: 'Start', startFen: firstFen, prefix: [], side: 'black', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, maxPlies: 2, engineDepth: 10, tolerance: 35, mode: 'main', playMode: 'human' }
  const line = await generateVariation(options, [], {
    explorer: async fen => fen === firstFen ? { white: 70, draws: 20, black: 10, moves: [{ uci: 'e2e4', san: 'e4', white: 70, draws: 20, black: 10 }], source: 'lichess' } : { white: 0, draws: 0, black: 0, moves: [], source: 'book' },
    analyze: async () => [{ cp: 10, depth: 10, line: ['e7e5'] }],
  })
  expect(line.moves.map(move => move.source)).toEqual(['lichess', 'engine'])
  expect(line.fallback).toBe(true)
})

it('generates a completed alternative from an uncovered opponent decision', async () => {
  const fen = '7k/p4Q2/6K1/8/8/8/8/8 b - - 0 1'
  const sources: Sources = {
    explorer: async position => position === fen ? { white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'a7a6', san: 'a6', white: 70, draws: 0, black: 0 }, { uci: 'a7a5', san: 'a5', white: 30, draws: 0, black: 0 }] } : { white: 0, draws: 0, black: 0, source: 'book', moves: [] },
    analyze: async () => [{ cp: 10000, depth: 10, line: ['f7g7'] }],
  }
  const options: Generation = { opening: 'Endgame', startFen: fen, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, maxPlies: 2, engineDepth: 10, tolerance: 35, mode: 'main', playMode: 'human' }
  const main = await generateVariation(options, [], sources)
  const branch = await generateVariation({ ...options, mode: 'next' }, [main], sources)
  expect(main).toMatchObject({ status: 'complete', result: '1-0' })
  expect(branch).toMatchObject({ status: 'complete', result: '1-0', parentId: main.id })
  expect(main.moves.map(move => move.uci)).toEqual(['a7a6', 'f7g7'])
  expect(branch.moves.map(move => move.uci)).toEqual(['a7a5', 'f7g7'])
  expect(saveVariation([main], branch)).toHaveLength(2)
  for (const line of [main, branch]) {
    const replay = new Chess()
    replay.loadPgn(line.pgn)
    expect(replay.isCheckmate()).toBe(true)
  }
})

it('saves an incomplete position when the time budget expires before analysis', async () => {
  const line = await generateVariation({ opening: 'Start', startFen: new Chess().fen(), prefix: [], side: 'white', database: 'lichess', filters: { ratings: [2200], speeds: ['rapid'] }, maxPlies: 180, maxMs: 0, engineDepth: 10, tolerance: 35, mode: 'main' }, [], {
    explorer: async () => { throw new Error('Explorer should not be called') },
    analyze: async () => { throw new Error('Stockfish should not be called') },
  })
  expect(line).toMatchObject({ status: 'incomplete', termination: 'Time budget reached', moves: [] })
  expect(line.result).toBeUndefined()
})

it('prefers common verified human moves and stops a mainline at its instructional limit', async () => {
  const start = new Chess().fen()
  const afterE4 = new Chess(); afterE4.move('e4')
  const filters = { ratings: [1600, 1800], speeds: ['rapid'] }
  const requested: string[] = []
  const line = await generateVariation({ opening: 'Start', startFen: start, prefix: [], side: 'white', database: 'lichess', filters, maxPlies: 2, engineDepth: 14, tolerance: 35, mode: 'main', playMode: 'mainline' }, [], {
    explorer: async (fen, used) => { expect(used).toEqual(filters); return fen === start ? { white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'e2e4', san: 'e4', white: 70, draws: 0, black: 0 }, { uci: 'd2d4', san: 'd4', white: 30, draws: 0, black: 0 }] } : { white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'e7e5', san: 'e5', white: 60, draws: 0, black: 0 }, { uci: 'c7c5', san: 'c5', white: 40, draws: 0, black: 0 }] } },
    analyze: async (fen, _count, depth) => { requested.push(`${fen}|${depth}`); return fen === start ? [{ cp: 30, depth, line: ['d2d4'] }, { cp: 20, depth, line: ['e2e4'] }] : fen === afterE4.fen() ? [{ cp: 20, depth, line: ['c7c5'] }, { cp: 0, depth, line: ['e7e5'] }] : [] },
  })
  expect(line.moves.map(move => move.uci)).toEqual(['e2e4', 'e7e5'])
  expect(line.moves.map(move => move.frequency)).toEqual([0.7, 0.6])
  expect(line.moves.map(move => move.source)).toEqual(['engine', 'lichess'])
  expect(line).toMatchObject({ status: 'instructional', fallback: false })
  expect(requested).toHaveLength(2)
})

it('stops before a long drawn game only after the advantage survives human and engine replies', async () => {
  const game = new Chess(), prefix: LineMove[] = []
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']) { const move = game.move(san); prefix.push({ uci: move.from + move.to, san: move.san, source: 'preset' }) }
  const position = game.fen()
  const checked: string[] = []
  const sources: Sources = {
    explorer: async () => ({ white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'f8c5', san: 'Bc5', white: 70, draws: 0, black: 0 }, { uci: 'g8f6', san: 'Nf6', white: 30, draws: 0, black: 0 }] }),
    analyze: async (fen, _count, depth) => { checked.push(`${fen}|${depth}`); return fen === position ? [{ cp: -180, depth, line: ['g8f6'] }, { cp: -190, depth, line: ['f8c5'] }] : [{ cp: 220, depth, line: ['d2d3'] }, { cp: 190, depth, line: ['c2c3'] }, { cp: 180, depth, line: ['b1c3'] }, { cp: 170, depth, line: ['d2d4'] }] },
  }
  const options: Generation = { opening: 'Italian', startFen: new Chess().fen(), prefix, side: 'white', database: 'lichess', filters: { ratings: [1600], speeds: ['rapid'] }, maxPlies: 180, engineDepth: 14, tolerance: 35, mode: 'main', playMode: 'advantage', advantageCp: 150 }
  const line = await generateVariation(options, [], sources)
  expect(line).toMatchObject({ status: 'favorable', result: undefined })
  expect(line.moves).toHaveLength(5)
  expect(line.termination).toContain('Common human reply tested')
  expect(line.termination).toContain('4 of 4 evaluated user moves')
  expect(checked.filter(call => call.endsWith('|16'))).toHaveLength(2)
  const fragile = await generateVariation({ ...options, maxPlies: 6 }, [], { ...sources, analyze: async (fen, _count, depth) => fen === position ? [{ cp: -180, depth, line: ['g8f6'] }, { cp: -190, depth, line: ['f8c5'] }] : [{ cp: 220, depth, line: ['d2d3'] }, { cp: 20, depth, line: ['c2c3'] }, { cp: 10, depth, line: ['b1c3'] }, { cp: 0, depth, line: ['d2d4'] }] })
  expect(fragile.status).toBe('incomplete')
  expect(fragile.termination).toContain('not stable')
})

it('labels missing human data and uses engine fallback only when enabled', async () => {
  const options: Generation = { opening: 'Start', startFen: new Chess().fen(), prefix: [], side: 'white', database: 'lichess', filters: { ratings: [1600], speeds: ['rapid'] }, maxPlies: 1, engineDepth: 14, tolerance: 35, mode: 'main', playMode: 'mainline' }
  const sources: Sources = { explorer: async () => ({ white: 0, draws: 0, black: 0, source: 'book', moves: [] }), analyze: async (_fen, _count, depth) => [{ cp: 20, depth, line: ['e2e4'] }] }
  const fallback = await generateVariation(options, [], sources)
  expect(fallback).toMatchObject({ status: 'instructional', fallback: true, moves: [{ source: 'engine', frequency: undefined }] })
  expect(fallback.termination).toContain('Human data was unavailable')
  const disabled = await generateVariation({ ...options, engineFallback: false }, [], { ...sources, analyze: async () => { throw new Error('Engine fallback must stay off') } })
  expect(disabled).toMatchObject({ status: 'incomplete', moves: [], termination: 'Human game data unavailable at this position; engine fallback is off.' })
})

it('checks the advantage from Black’s perspective and tests a forcing reply', async () => {
  const game = new Chess(), prefix: LineMove[] = []
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) { const move = game.move(san); prefix.push({ uci: move.from + move.to, san: move.san, source: 'preset' }) }
  const position = game.fen()
  const checked: string[] = []
  let forcingSearch: string[] = []
  const line = await generateVariation({ opening: 'Open game', startFen: new Chess().fen(), prefix, side: 'black', database: 'lichess', filters: { ratings: [1800], speeds: ['blitz'] }, maxPlies: 180, engineDepth: 14, tolerance: 35, mode: 'main', playMode: 'advantage', advantageCp: 150 }, [], {
    explorer: async () => ({ white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'f1c4', san: 'Bc4', white: 70, draws: 0, black: 0 }, { uci: 'd2d4', san: 'd4', white: 30, draws: 0, black: 0 }] }),
    analyze: async (fen, _count, depth, _signal, _timeout, _refresh, searchMoves) => {
      checked.push(fen)
      if (fen === position && searchMoves?.length) { forcingSearch = searchMoves; return [{ cp: -200, depth, line: ['f3e5'] }] }
      if (fen === position) return [{ cp: -180, depth, line: ['d2d4'] }, { cp: -190, depth, line: ['f1c4'] }]
      return new Chess(fen).moves({ verbose: true }).slice(0, 4).map((move, index) => ({ cp: 220 - index * 10, depth, line: [move.from + move.to + (move.promotion || '')] }))
    },
  })
  expect(line.status).toBe('favorable')
  expect(line.moves).toHaveLength(4)
  expect(line.termination).toContain('including a forcing move')
  expect(forcingSearch).toContain('f3e5')
  expect(checked).toHaveLength(5)
})

it('reports an unmet advantage target instead of declaring a useful line', async () => {
  const line = await generateVariation({ opening: 'Start', startFen: new Chess().fen(), prefix: [], side: 'white', database: 'lichess', filters: { ratings: [1600], speeds: ['rapid'] }, maxPlies: 1, engineDepth: 14, tolerance: 35, mode: 'main', playMode: 'advantage', advantageCp: 150 }, [], {
    explorer: async () => ({ white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'e2e4', san: 'e4', white: 100, draws: 0, black: 0 }] }),
    analyze: async (_fen, _count, depth) => [{ cp: 20, depth, line: ['e2e4'] }],
  })
  expect(line.status).toBe('incomplete')
  expect(line.termination).toContain('Advantage target not reached')
})

it('branches a human mainline at an uncovered common opponent move', async () => {
  const fen = '7k/p4Q2/6K1/8/8/8/8/8 b - - 0 1'
  const options: Generation = { opening: 'Endgame', startFen: fen, prefix: [], side: 'white', database: 'lichess', filters: { ratings: [1800], speeds: ['rapid'] }, maxPlies: 2, engineDepth: 14, tolerance: 35, mode: 'main', playMode: 'mainline' }
  const sources: Sources = {
    explorer: async position => position === fen ? { white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'a7a6', san: 'a6', white: 70, draws: 0, black: 0 }, { uci: 'a7a5', san: 'a5', white: 30, draws: 0, black: 0 }] } : { white: 0, draws: 0, black: 0, source: 'book', moves: [] },
    analyze: async (position, _count, depth) => position === fen ? [{ cp: 0, depth, line: ['a7a6'] }, { cp: -10, depth, line: ['a7a5'] }] : [{ cp: 10000, depth, line: ['f7g7'] }],
  }
  const main = await generateVariation(options, [], sources)
  main.moves[0].alternatives = ['a7a6']
  const branch = await generateVariation({ ...options, mode: 'next' }, [main], sources)
  expect(main.moves[0].uci).toBe('a7a6')
  expect(branch.moves[0].uci).toBe('a7a5')
  expect(branch.name).toContain('a5 sideline')
  expect(branch.parentId).toBe(main.id)
  expect(saveVariation([main], branch)).toHaveLength(2)
})

it('keeps White and Black repertoires separate and requires an unknown older side to be chosen', () => {
  const game = new Chess()
  const move = game.move('d4')
  const white = { id: 'white-line', startFen: new Chess().fen(), moves: [{ uci: move.from + move.to, san: move.san, source: 'import' }], side: 'white' } as Variation
  const black = { ...white, id: 'black-line', side: 'black' } as Variation
  expect(saveVariation([white], black)).toHaveLength(2)
  expect(continuationsAt([white], white.startFen, white.id, 'black')).toEqual({ covered: [], parentId: undefined })
  expect(continuationsAt([white, black], white.startFen, black.id, 'black')).toEqual({ covered: ['d2d4'], parentId: black.id })
  const unknown = restoreTrainingSide({ ...white, side: undefined } as unknown as Variation)
  expect(unknown.sideUnconfirmed).toBe(true)
  expect(continuationsAt([unknown], white.startFen, unknown.id, 'white').covered).toEqual([])
  expect(restoreTrainingSide(black)).toEqual(black)
})

it('generates Accelerated London preparation for Black from the exact displayed position', async () => {
  const game = new Chess(), prefix: LineMove[] = []
  for (const san of ['d4', 'd5', 'Bf4']) { const move = game.move(san); prefix.push({ uci: move.from + move.to, san: move.san, source: 'preset' }) }
  const rootFen = game.fen()
  const afterC5 = new Chess(rootFen); afterC5.move('c5')
  const calls: string[] = []
  const sources: Sources = {
    explorer: async fen => fen === rootFen ? { white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'c7c5', san: 'c5', white: 70, draws: 0, black: 0 }, { uci: 'g8f6', san: 'Nf6', white: 30, draws: 0, black: 0 }] } : { white: 100, draws: 0, black: 0, source: 'lichess', moves: [{ uci: 'e2e3', san: 'e3', white: 60, draws: 0, black: 0 }, { uci: 'g1f3', san: 'Nf3', white: 40, draws: 0, black: 0 }] },
    analyze: async (fen, _count, depth) => { calls.push(fen); return fen === rootFen ? [{ cp: 40, depth, line: ['c7c5'] }, { cp: 30, depth, line: ['g8f6'] }] : [{ cp: 20, depth, line: ['e2e3'] }, { cp: 10, depth, line: ['g1f3'] }] },
  }
  const line = await generateVariation({ opening: "Queen's Pawn Game: Accelerated London System", startFen: new Chess().fen(), prefix, rootFen, side: 'black', database: 'lichess', filters: { ratings: [1800], speeds: ['rapid'] }, maxPlies: 2, engineDepth: 12, tolerance: 35, mode: 'main', playMode: 'mainline' }, [], sources)
  expect(rootFen.split(' ')[1]).toBe('b')
  expect(lineFen(line, 3)).toBe(rootFen)
  expect(line.side).toBe('black')
  expect(line.moves.slice(3).map(move => [move.uci, move.source])).toEqual([['c7c5', 'engine'], ['e2e3', 'lichess']])
  expect(line.moves[4].frequency).toBe(0.6)
  expect(calls).toEqual([rootFen, afterC5.fen()])
})

it('replays French Bd7 from practice review and catches up without revealing unplayed moves', () => {
  const game = new Chess(), moves: LineMove[] = []
  for (const san of ['e4','e6','d4','d5','e5','Bd7','Nf3','c5']) {
    const move=game.move(san); moves.push({uci:move.from+move.to,san:move.san,source:'preset'})
  }
  const line={startFen:new Chess().fen(),moves,side:'black' as const}
  expect(reviewMoveIndex(line,5,7,'c8d7')).toBe(7)
  expect(reviewMoveIndex(line,5,6,'c8d7')).toBe(6)
  expect(reviewMoveIndex(line,5,5,'c8d7')).toBeNull()
  expect(reviewMoveIndex(line,5,7,'c7c5')).toBeNull()
  expect(line.moves).toHaveLength(8)
})

it('does not restore an older progress snapshot over a completed or longer saved line', () => {
  const draft = { id: 'line-1', moves: [{ uci: 'e2e4' }], termination: 'Converting advantage...', recommendation: { runtimeMs: 10 } } as Variation
  const final = { ...draft, termination: 'Advantage secured', recommendation: { runtimeMs: 20 } } as Variation
  expect(restoreActiveLine([final], draft, draft.id)).toEqual([final])
  expect(restoreActiveLine([draft], final, draft.id)).toEqual([final])
  const longer = { ...draft, moves: [...draft.moves, { uci: 'e7e5' }] } as Variation
  expect(restoreActiveLine([longer], draft, draft.id)).toEqual([longer])
})
