import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlannerCards } from './PlannerMode'
import { type Plan } from './planner'
import * as engine from './engine'
const plan = { id:'e2e4',label:'Central pawn advance',root:{cp:15,depth:14,line:['e2e4']},loss:0,refuted:false,preliminary:false,sans:['e4','e5'],leadIn:0 } as Plan
it('previews on hover and keyboard focus without starting analysis; click/tap locks selection', () => {
 const preview=vi.fn(),select=vi.fn(),search=vi.spyOn(engine,'analyze')
 const tree=PlannerCards({plans:[plan],selected:null,side:'w',onPreview:preview,onSelect:select})
 const button=tree.props.children[0]
 button.props.onMouseEnter(); expect(preview).toHaveBeenLastCalledWith('e2e4')
 button.props.onMouseLeave(); expect(preview).toHaveBeenLastCalledWith(null)
 button.props.onFocus(); expect(preview).toHaveBeenLastCalledWith('e2e4')
 button.props.onBlur(); expect(preview).toHaveBeenLastCalledWith(null)
 button.props.onClick(); expect(select).toHaveBeenCalledWith('e2e4')
 expect(search).not.toHaveBeenCalled(); search.mockRestore()
 // Native buttons provide Enter, Space and touch activation without separate key/pointer code.
 expect(button.type).toBe('button')
})
it('renders locked state, evaluation perspective and downgrade evidence accessibly', () => {
 const html=renderToStaticMarkup(<PlannerCards plans={[{...plan,refuted:true}]} selected="e2e4" side="b" onPreview={()=>{}} onSelect={()=>{}}/>)
 expect(html).toContain('aria-pressed="true"');expect(html).toContain('for Black');expect(html).toContain('REFUTED / DOWNGRADED')
})
it('renders compact integrated plans without a second board or manual discovery controls', async () => {
 const Planner=(await import('./PlannerMode')).default
 const html=renderToStaticMarkup(<Planner fen="8/8/8/8/8/8/4k3/6K1 w - - 0 1" depth={24} onPreview={()=>{}}/>)
 expect(html).not.toContain('chessboard-board'); expect(html).not.toContain('Discover plans')
 expect(html).toContain('Advanced plan settings'); expect(html).toContain('Shared Stockfish target: depth 24')
 expect(html).toContain('Terminal position')
})
