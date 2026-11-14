import { Chess } from 'chess.js'
import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { generationProvenance } from './generationProvenance'
import { GenerationDetails } from './GenerationDetails'
import { opponentProvenance } from './repertoireSummary'
import { branchVariation } from './openingTree'
import { type Variation } from './learning'

function fixture(ply: number): Variation {
 const game=new Chess();game.loadPgn('1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.d3 Bc5 5.O-O d6')
 const line: Variation={id:'test',startFen:new Chess().fen(),moves:game.history({verbose:true}).map(m=>({uci:m.from+m.to,san:m.san,source:'engine'})),side:'white',opening:'Italian',name:'Test',pgn:game.pgn(),database:'lichess',filters:{ratings:[],speeds:[]},created:1,endPosition:game.fen(),fallback:false,stats:{firstTry:0,errors:0,reveals:0,completions:0,totalMs:0}}
 line.moves.forEach(move => { move.source = 'engine' })
 return branchVariation(line, {startFen:line.startFen,prefix:line.moves.slice(0,ply),opening:'Italian',playMode:'advantage'})
}
test.each([0,5,6])('boundary at ply %i separates inherited engine moves from generated moves', ply => {
 const line=fixture(ply),before=JSON.stringify(line),p=generationProvenance(line)
 expect(p.boundary).toBe(ply)
 expect(p.entries.filter(e=>e.contextual)).toHaveLength(ply)
 const html=renderToStaticMarkup(<GenerationDetails line={line}/>)
 expect(html).toContain(p.start)
 expect(html).not.toContain('Move source unavailable')
 expect(html).not.toContain('Unknown (saved context)')
 expect(html).toContain('<details><summary>Generation Details')
 if(ply===6){expect(p.start).toBe('After 3...Nf6');expect(html).toContain('Generated opponent moves: Stockfish · 4...Bc5 through 5...d6')}
 if(ply===5)expect(p.start).toBe('After 3.Bc4')
 expect(JSON.stringify(line)).toBe(before)
})
test('mixed sources and missing generated provenance remain separate from opening context',()=>{
 const line=fixture(6)
 line.moves[7].source='lichess';line.moves[9].source='model'
 expect(opponentProvenance(line).label).toContain('Lichess → Maia from 5...d6')
 line.moves[7].source=undefined as unknown as Variation['moves'][number]['source']
 const html=renderToStaticMarkup(<GenerationDetails line={{...line}}/>)
 expect(html).toContain('4...Bc5: Generated move · Source unavailable')
 expect(html).toContain('5...d6: Maia')
})
test('unknown historical boundary is not guessed; invalid recorded boundaries are rejected',()=>{
 const line=fixture(6);delete line.branch
 expect(generationProvenance(line).start).toBe('Generation boundary unavailable')
 line.moves.forEach(move=>{move.source='import'})
 expect(generationProvenance(line).boundary).toBeUndefined()
 expect(opponentProvenance(line).details).toContain('Historical move · Source unavailable')
 line.branch={...fixture(6).branch!,fen:new Chess().fen()}
 expect(generationProvenance(line).boundary).toBeUndefined()
})
test('legacy recovery requires a contiguous preset prefix',()=>{
 const line=fixture(6);delete line.branch
 line.moves.slice(0,6).forEach(move=>{move.source='preset'})
 expect(generationProvenance(line).boundary).toBe(6)
 line.moves[7].source='preset'
 expect(generationProvenance(line).boundary).toBeUndefined()
})
test('middlegame FEN preserves black-to-move numbering and explicit zero boundary',()=>{
 const line=fixture(5),board=new Chess(line.startFen)
 line.moves.slice(0,5).forEach(move=>board.move(move.uci))
 const startFen=board.fen().replace(/ 3$/, ' 20')
 const partial={...line,startFen,moves:line.moves.slice(5),branch:{...line.branch!,ply:0,fen:startFen}}
 const p=generationProvenance(partial)
 expect(p.start).toBe('At supplied position · move 20 · Black to move')
 expect(p.entries[0].label).toBe('20...Nf6')
 expect(p.context).toBe('')
})

test('hybrid takeover explains its actual reason without implying pending verification',()=>{
 const line=fixture(6)
 line.opponentModel='lichess-stockfish'
 line.moves[7].source='lichess'
 line.opponentTransition={ply:9,issue:'authentication',reason:'Database unavailable; Stockfish fallback enabled (authentication): HTTP 401'}
 line.recommendation={policy:'simple',verification:'pending',preliminary:true}
 const html=renderToStaticMarkup(<GenerationDetails line={line}/>)
 expect(html).toContain('Deep verification: Not performed')
 expect(html).not.toContain('Verification: pending')
 expect(html).toContain('Stockfish takeover at 5...d6')
 expect(html).toContain('HTTP 401')
 expect(opponentProvenance(line).label).toContain('Lichess → Stockfish')
 line.moves[7].source='engine'
 expect(opponentProvenance({...line,opponentTransition:{...line.opponentTransition,ply:7}}).label).toBe('Opponent: Stockfish from generation start')
})

test.each(['lichess','model'] as const)('%s takeover is visible immediately and survives serialization',source=>{
 const line=fixture(6);line.moves[7].source=source
 const before=JSON.stringify(line)
 const expected=`${source==='lichess'?'Lichess':'Maia'} → Stockfish from 5...d6`
 expect(opponentProvenance(line).label).toBe(`Opponent: ${expected}`)
 expect(opponentProvenance(JSON.parse(before)).label).toBe(`Opponent: ${expected}`)
 expect(opponentProvenance(line).runs.map(r=>r.first)).toEqual(['4...Bc5','5...d6'])
 expect(JSON.stringify(line)).toBe(before)
})
test('unknown moves prevent invented transition timing',()=>{
 const line=fixture(4)
 line.moves[5].source='lichess';line.moves[7].source=undefined as unknown as Variation['moves'][number]['source']
 expect(opponentProvenance(line).label).toBe('Opponent: Lichess → Stockfish · Transition unknown')
})
test('white opponent transition numbering excludes black user moves',()=>{
 const line={...fixture(5),side:'black' as const}
 line.moves[6].source='model'
 expect(opponentProvenance(line).label).toBe('Opponent: Maia → Stockfish from 5.O-O')
})
test('all known single-source continuations use compact throughout labels',()=>{
 for(const [source,label] of [['lichess','Lichess throughout'],['model','Maia throughout'],['engine','Stockfish from generation start']] as const){
  const line=fixture(6);line.moves.slice(6).forEach(m=>{m.source=source})
  expect(opponentProvenance(line).label).toBe(`Opponent: ${label}`)
  expect(opponentProvenance(line).label).not.toContain('No Maia')
 }
})
