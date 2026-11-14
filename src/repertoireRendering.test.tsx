import { afterEach, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Chess } from 'chess.js'
import RepertoirePage from './RepertoirePage'
import { WindowedList } from './WindowedList'
import type { Variation } from './learning'
vi.mock('./StableBoard', async importOriginal => ({ ...await importOriginal<typeof import('./StableBoard')>(), StableBoard: () => <div>Board preview</div> }))
afterEach(() => vi.unstubAllGlobals())
test('family rendering has one primary action and leaves saved data and storage untouched', () => {
  const store = { getItem: vi.fn(() => null), setItem: vi.fn() }
  vi.stubGlobal('localStorage', store)
  vi.stubGlobal('location', { href: 'http://localhost/?family=Other%20%2F%20Unclassified' })
  const game = new Chess(), startFen = game.fen(); game.move('e4')
  const line = { id: 'a', name: 'A very long saved variation name', opening: '', startFen, moves: [{ uci: 'e2e4', san: 'e4' }], side: 'black', pgn: game.pgn(), created: 1 } as Variation
  const before = JSON.stringify(line)
  const html = renderToStaticMarkup(<RepertoirePage lines={[line]} catalog={[]} stats={{}} ready busy={false} remove={vi.fn()} back={vi.fn()} act={vi.fn()} practice={vi.fn()} practiceSession={vi.fn()} updateStats={vi.fn()}/>)
  expect(html.match(/>Practice<\/button>/g)).toHaveLength(1)
  expect(html).not.toContain('>Watch</button>')
  expect(html).not.toContain('Other legal moves')
  expect(html).toContain('More actions')
  expect(html).toContain('>End</button>')
  expect(store.setItem).not.toHaveBeenCalled()
  expect(JSON.stringify(line)).toBe(before)
})
test('a single saved variation keeps separate line and branch practice actions', () => {
  const store = { getItem: vi.fn(() => null), setItem: vi.fn() }
  vi.stubGlobal('localStorage', store)
  vi.stubGlobal('location', { href: 'http://localhost/?family=Other%20%2F%20Unclassified' })
  const game = new Chess(), startFen = game.fen(); game.move('e4'); game.move('e5')
  const line = { id: 'single', name: 'Single line', opening: '', startFen, moves: [{ uci: 'e2e4', san: 'e4' }, { uci: 'e7e5', san: 'e5' }], side: 'white', pgn: game.pgn(), created: 1 } as Variation
  const html = renderToStaticMarkup(<RepertoirePage lines={[line]} catalog={[]} stats={{}} ready busy={false} remove={vi.fn()} back={vi.fn()} act={vi.fn()} practice={vi.fn()} practiceSession={vi.fn()} updateStats={vi.fn()}/>)
  expect(html).toContain('aria-label="Practice branch Playing white"')
  expect(html).toContain('aria-label="Practice Single line"')
  expect(html).not.toContain('Practice branch configuration')
  expect(html).not.toContain('Opponent Selection')
})
test('ten thousand tree rows mount only the initial visible chunk', () => {
  const render = vi.fn((i: number) => <button key={i}>Line {i}</button>)
  const html = renderToStaticMarkup(<WindowedList count={10000} estimate={64} render={render}/>)
  expect(render).toHaveBeenCalledTimes(40)
  expect(html).toContain('Show entries 41 to 80')
})

test('branch practice hides the target title and separates attempted coverage from mastery', async () => {
  const {default: FamilyPractice}=await import('./FamilyPracticePage')
  const {newBranch,startFamilyAttempt,finishFamilyAttempt,branchOptions}=await import('./familyPractice')
  const {recallMove}=await import('./memorize')
  const chess=new Chess();chess.move('e4');chess.move('c5');chess.move('Nf3')
  const line={id:'branch-line',name:'Secret target continuation',side:'white',startFen:new Chess().fen(),moves:chess.history({verbose:true}).map(m=>({uci:m.from+m.to,san:m.san,source:'import'})),pgn:chess.pgn()} as Variation
  const record=startFamilyAttempt(newBranch('branch','Sicilian — c5','white',[line],2,branchOptions(null),42),new Map([[line.id,line]]))
  const render=(r:typeof record)=>renderToStaticMarkup(<FamilyPractice record={r} lines={[line]} update={()=>true} updateStats={vi.fn()} back={vi.fn()} restart={vi.fn()}/>)
  expect(render(record)).not.toContain('Secret target continuation')
  expect(render(record)).toContain('Recall your next move.')
  const wrong=recallMove(record.session.memory!,'a2a3',line.moves[2])
  expect(finishFamilyAttempt(record,wrong)).toBe(record)
  const failed=finishFamilyAttempt(record,recallMove(wrong,line.moves[2].uci,line.moves[2]))
  const html=render(failed)
  expect(html).toContain('Branch practice complete')
  expect(html).toContain('1/1 variations practiced')
  expect(html).toContain('0/1 lines')
  expect(html).toContain('not necessarily a chess blunder')
  expect(html).toContain('Review mistakes')
  const stopped=render({...record,session:{...record.session,stopped:true,finished:Date.now()}})
  expect(stopped).toContain('Branch practice stopped')
  expect(stopped).not.toContain('Recall your next move.')
})
