import { afterEach, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Chess } from 'chess.js'
import type { Variation } from './learning'
import { positions } from './gameAnalysis'
import { previewStart, RepertoirePreview } from './RepertoirePreview'
import { EvaluationBar } from './EvaluationBar'
import * as engine from './engine'
vi.mock('./StableBoard', async original => ({...await original<typeof import('./StableBoard')>(), StableBoard: ({options}: {options: unknown}) => <div data-board={JSON.stringify(options)}/>}))
afterEach(() => vi.restoreAllMocks())
function line() {
 const game = new Chess(); game.loadPgn('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5')
 return {id:'preview',startFen:new Chess().fen(),side:'white',moves:game.history({verbose:true}).map(m=>({uci:m.from+m.to,san:m.san,source:'import'}))} as Variation
}
test('starts at verified generation boundary and safely falls back for missing or invalid metadata',()=>{
 const value=line(), before=JSON.stringify(value), fens=positions(value)
 expect(previewStart(value)).toBe(0)
 expect(previewStart({...value,branch:{ply:4,fen:fens[4]} as Variation['branch']})).toBe(4)
 expect(previewStart({...value,branch:{ply:4,fen:fens[3]} as Variation['branch']})).toBe(0)
 expect(previewStart({...value,moves:value.moves.map((m,i)=>({...m,source:i<2?'preset':'engine'}))})).toBe(2)
 expect(JSON.stringify(value)).toBe(before)
})
test('navigation renders correct FEN, orientation, current move and next arrow without changing records or searching',()=>{
 const value=line(), before=JSON.stringify(value), search=vi.spyOn(engine,'analyze')
 const render=(ply:number)=>renderToStaticMarkup(<RepertoirePreview line={value} ply={ply} orientation="black" navigate={()=>{}}/>)
 const atFour=render(4), atThree=render(3), atEnd=render(6)
 expect(atFour).toContain(positions(value)[4]);expect(atThree).toContain(positions(value)[3])
 expect(atFour).toContain('&quot;boardOrientation&quot;:&quot;black&quot;')
 expect(atFour).toContain('&quot;startSquare&quot;:&quot;f1&quot;')
 expect(atThree).toContain('&quot;startSquare&quot;:&quot;b8&quot;')
 expect(atEnd).toContain('&quot;arrows&quot;:[]')
 expect(atFour).toContain('aria-current="step"');expect(atFour).toContain('Not analyzed')
 expect(atFour).not.toContain('Chronological movement paths')
 expect(atFour).toContain('Show plan');expect(atFour).toContain('Saved line moves')
 expect(search).not.toHaveBeenCalled();expect(JSON.stringify(value)).toBe(before)
})
test('uses compatible cached evaluation at the displayed position and converts Black perspective',()=>{
 const value=line()
 vi.spyOn(engine,'cachedAnalysis').mockReturnValue([{cp:89,depth:18,line:['e7e5']}])
 const html=renderToStaticMarkup(<RepertoirePreview line={value} ply={1} orientation="white" navigate={()=>{}}/>)
 expect(html).toContain('Stockfish -0.89 · Depth 18')
 expect(html).toContain('aria-valuenow="-89"')
})
test('shared evaluation bar preserves checkmate winner and flipped orientation',()=>{
 const white=renderToStaticMarkup(<EvaluationBar evaluation={{cp:100000,mate:0,winner:'White'}} orientation="white"/>)
 const black=renderToStaticMarkup(<EvaluationBar evaluation={{cp:100000,mate:0,winner:'White'}} orientation="black"/>)
 expect(white).toContain('Checkmate · White wins');expect(white).toContain('height:100%')
 expect(black).toContain('height:0%')
 expect(renderToStaticMarkup(<EvaluationBar orientation="white"/>)).toContain('Not analyzed')
})
