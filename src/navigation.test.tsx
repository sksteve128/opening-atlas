import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import GenerationQueue from './GenerationQueue'
import type { BatchStatus, RecentBatch } from './backgroundBatch'
const handlers={onOpenLine:vi.fn(),onStop:vi.fn(),onRepertoire:vi.fn(),lines:[]}
it('hides the idle queue and summarizes running and completed jobs without removing history access',()=>{
 expect(renderToStaticMarkup(<GenerationQueue {...handlers} active={null} recent={[]}/>)).not.toContain('Generation Queue')
 const active={id:'test',status:'running',completed:0,total:3,jobs:[{id:'a',status:'running'},{id:'b',status:'pending'}]} as BatchStatus
 expect(renderToStaticMarkup(<GenerationQueue {...handlers} active={active} recent={[]}/>)).toContain('◉ 1 running')
 expect(renderToStaticMarkup(<GenerationQueue {...handlers} active={null} recent={[{completed:5} as RecentBatch]}/>)).toContain('✓ 5 completed')
})
