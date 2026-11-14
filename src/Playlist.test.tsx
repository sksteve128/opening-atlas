import { expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Chess } from 'chess.js'
import { Playlist, playlistMode, playlistTitles, practiceEntryStatus, type PlaylistMode } from './Playlist'
import { newFamily, newBranch, branchOptions, startFamilyAttempt, finishFamilyAttempt, practicePlaylist, retryPracticedLine, parseFamilies } from './familyPractice'
import { recallMove, finishMemory, emptyMemoryStats, dueMemoryLines } from './memorize'
import type { Variation } from './learning'
const line = (id: string, san = 'e4') => { const game = new Chess(), move = game.move(san); return { id, side: 'white', startFen: new Chess().fen(), moves: [{ uci: move.from + move.to, san, source: 'import' }] } as Variation }

test.each(Object.keys(playlistTitles) as PlaylistMode[])('%s uses the shared, keyboard-accessible list surface', mode => {
 const html = renderToStaticMarkup(<Playlist mode={mode} count={2} render={i => <button key={i}>Line {i + 1}</button>}/>)
 expect(html).toContain('aria-label="Repertoire playlist"'); expect(html).toContain(`data-mode="${mode}"`)
 expect(html).toContain(playlistTitles[mode]); expect(html).toContain('Line 2'); expect(html).not.toContain('progressbar')
})
test('mode switching delegates explicitly and does not touch the session snapshot', () => {
 const record = newFamily('Family','white',[line('a')]), before = JSON.stringify(record), change = vi.fn()
 const tree = Playlist({ mode:'FAMILY_PRACTICE',count:1,render:()=>null,availableModes:['SAVED_LINES','FAMILY_PRACTICE'],onModeChange:change })
 const select = tree.props.children[0].props.children[0]
 select.props.onChange({target:{value:'SAVED_LINES'}})
 expect(change).toHaveBeenCalledWith('SAVED_LINES'); expect(JSON.stringify(record)).toBe(before)
 expect(playlistMode(record)).toBe('FAMILY_PRACTICE')
 expect(playlistMode({...record,session:{...record.session,reviewMode:true}})).toBe('REVIEW')
 expect(playlistMode(newBranch('b','Family','white',[line('a')],0,branchOptions(null),1))).toBe('BRANCH_PRACTICE')
 expect(playlistMode(null)).toBe('SAVED_LINES')
})
test('large playlists reuse windowing and do not render the whole library', () => {
 const render = vi.fn(i => <button key={i}>Line {i}</button>)
 const html = renderToStaticMarkup(<Playlist mode="SAVED_LINES" count={1000} render={render}/>)
 expect(render).toHaveBeenCalledTimes(40); expect(html).toContain('Show entries 961 to 1000')
})
test('entry labels keep practiced coverage and mastery independent', () => {
 expect(practiceEntryStatus('Needs review',false)).toBe('Practiced · Review suggested')
 expect(practiceEntryStatus('Needs review',true)).toBe('Practiced · Review suggested · Mastered')
 expect(practiceEntryStatus('Passed',false)).toBe('Practiced')
 expect(practiceEntryStatus('Current',false)).toBe('Current')
})
test.each([false,true])('complete coverage after a mistake without granting mastery; branch=%s', branch => {
 const lines=[line('a'),line('b','d4')], map=new Map(lines.map(l=>[l.id,l]))
 let record=startFamilyAttempt(branch ? newBranch('b','Family','white',lines,0,{...branchOptions(null),order:'sequential'},42) : newFamily('Family','white',lines,undefined,()=>.999999),map,10)
 const before=JSON.stringify(lines), id=record.session.memory!.lineId, current=map.get(id)!
 const wrong=recallMove(record.session.memory!,'a2a3',current.moves[0])
 expect(wrong.phase).toBe('active'); expect(wrong.message).toContain('differs from the saved continuation')
 expect(finishFamilyAttempt(record,wrong)).toBe(record); expect(practicePlaylist(record).attempted).toBe(0)
 const complete=recallMove(wrong,current.moves[0].uci,current.moves[0]); record=finishFamilyAttempt(record,complete,20)
 expect(practicePlaylist(record)).toMatchObject({attempted:1,mastered:0,passed:0}); expect(record.session.remaining).not.toContain(id)
 const stats=finishMemory(emptyMemoryStats(),complete,20)
 expect(stats).toMatchObject({wrong:1,completed:1,perfect:0,dueAt:600020})
 expect(dueMemoryLines([current],{[id]:stats},21)).toEqual([])
 record=parseFamilies(JSON.stringify({session:record})).session
 const upcoming=record.session.remaining[0]
 expect(retryPracticedLine(record,upcoming,map)).toBe(record)
 const retry=retryPracticedLine(record,id,map,30)
 expect(retry.session.memory).toMatchObject({lineId:id,index:0,wrong:0,phase:'active'})
 expect(retry.session.remaining).toEqual(record.session.remaining); expect(practicePlaylist(retry).attempted).toBe(1)
 expect(retryPracticedLine(retry,id,map)).toBe(retry)
 record=startFamilyAttempt({...record,session:{...record.session,memory:null,review:undefined}},map,40)
 expect(record.session.memory!.lineId).toBe(upcoming)
 record=finishFamilyAttempt(record,recallMove(record.session.memory!,map.get(upcoming)!.moves[0].uci,map.get(upcoming)!.moves[0]),50)
 expect(record.session.finished).toBe(50); expect(practicePlaylist(record)).toMatchObject({attempted:2,mastered:0,passed:1})
 expect(JSON.stringify(lines)).toBe(before)
})
