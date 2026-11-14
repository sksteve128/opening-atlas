import { FAMILY_STORAGE, rememberSession, familyKey, branchSessionKey, newFamily, parseFamilies, type FamilyRecord, ACTIVE_PRACTICE, BRANCH_SETTINGS, branchOptions, branchLines, newBranch, type BranchOptions, lineSignature } from './familyPractice'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import type { Side } from './core'
import type { Variation } from './learning'
import type { OpeningRecord } from './openings'
import type { MemoryStats } from './memorize'
import { branchProvenance, opponentProvenance, repertoireDate, repertoireEvaluation, repertoireOutcome } from './repertoireSummary'
import { OpponentSource } from './OpponentSource'
import { RepertoirePreview, previewStart } from './RepertoirePreview'
import { WindowedList } from './WindowedList'
import { repertoireTitle, repertoireBadge, repertoireGroupTitle, buildRepertoireTree, compressed, descendantEntries, filterRepertoire, PREFERENCES_KEY, preferenceKey, preferMove, readPreferences, repertoireEntries, sequenceLabel, type RepertoireNode } from './repertoireTree'
import './repertoire.css'
export type RepertoireAction = 'analysis' | 'watch' | 'memorize' | 'practice'
type PracticeOptions = Pick<BranchOptions, 'order' | 'coverage' | 'start'>
type Props = { embedded?: boolean; filters?: Variation['filters']; targetRating?: number; lines: Variation[]; catalog: OpeningRecord[]; stats: Record<string, MemoryStats>; ready: boolean; busy: boolean; remove: (line: Variation) => void; back: () => void; act: (action: RepertoireAction, line: Variation, ply: number, orientation: Side) => void; practice: (lines: Variation[]) => void; practiceSession: (record: FamilyRecord) => void; updateStats: (id: string, change: (stats: MemoryStats) => MemoryStats) => void }
export default function RepertoirePage({ embedded, lines, catalog, stats, ready, busy, back, act, remove, filters, targetRating, practiceSession }: Props) {
  const [familyStore, setFamilyStore] = useState(() => { try { return { records: parseFamilies(localStorage.getItem(FAMILY_STORAGE)), error: '' } } catch { return { records: {} as Record<string, FamilyRecord>, error: 'Family sessions could not be read. Existing storage has been retained.' } } })
  const [sessionError, setSessionError] = useState('')
  const [practiceOptions, setPracticeOptions] = useState<PracticeOptions>(() => { try { const { order, coverage, start } = branchOptions(JSON.parse(localStorage.getItem(BRANCH_SETTINGS) || '{}')); return { order, coverage, start } } catch { const { order, coverage, start } = branchOptions(null); return { order, coverage, start } } })
  const [configuration, setConfiguration] = useState<{ key: string; label: string; side: Side; candidates: Variation[]; ply: number; nodes?: RepertoireNode[] } | null>(null)
  const configurationRef = useRef<HTMLElement>(null)
  useEffect(() => { if (configuration) { configurationRef.current?.scrollIntoView({block:'start'}); configurationRef.current?.focus({preventScroll:true}) } }, [configuration?.key])
  const [practiceSelection, setPracticeSelection] = useState<{ id: string; ply: number; saved: boolean } | null>(null)
  function openSession(key: string | null) { try { if (key) localStorage.setItem(ACTIVE_PRACTICE,key); else localStorage.removeItem(ACTIVE_PRACTICE) } catch { setSessionError('Session navigation could not be saved. Browser storage is unavailable.') } }
  function changePractice(options: PracticeOptions) { try { localStorage.setItem(BRANCH_SETTINGS,JSON.stringify(options)); setPracticeOptions(options) } catch { setSessionError('Practice preferences could not be saved.') } }

  function saveFamily(record: FamilyRecord) {
    try { const records = rememberSession(parseFamilies(localStorage.getItem(FAMILY_STORAGE)), record); localStorage.setItem(FAMILY_STORAGE, JSON.stringify(records)); setFamilyStore({ records, error: '' }); setSessionError(''); return true } catch { setSessionError('Family progress could not be saved. Free browser storage before continuing.'); return false }
  }
  const [targetLine] = useState(() => new URL(location.href).searchParams.get('repertoireLine'))
  const openedTarget = useRef(false), scrollTarget = useRef(!!targetLine)
  const [side, setSide] = useState<Side | 'both'>('both'), [query, setQuery] = useState('')
  const [family, setFamily] = useState(() => new URL(location.href).searchParams.get('family') || '')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState<{ id: string; ply: number; saved?: boolean } | null>(null)
  const [previewPly, setPreviewPly] = useState<number | null>(null)
  const [details, setDetails] = useState(false), [notice, setNotice] = useState('')
  const [familySide, setFamilySide] = useState<Side>('white')
  const [orientation, setOrientation] = useState<Side>('white'), [preferenceError, setPreferenceError] = useState('')
  const [preferences, setPreferences] = useState(() => { try { return readPreferences(localStorage.getItem(PREFERENCES_KEY)) } catch { return {} } })
  // Large libraries are indexed off the UI thread. Small libraries reuse main-board history caches.
  const [indexed, setIndexed] = useState<{ lines: Variation[]; catalog: OpeningRecord[]; value: ReturnType<typeof repertoireEntries> } | null>(null)
  const [treeResult, setTreeResult] = useState<{ members: ReturnType<typeof repertoireEntries>; value: ReturnType<typeof buildRepertoireTree> } | null>(null)
  const [indexError, setIndexError] = useState('')
  useEffect(() => {
    if (lines.length <= 200) return
    const worker = new Worker(new URL('./repertoireTree.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => { if (event.data.error) setIndexError(event.data.error); else setIndexed({ lines, catalog, value: event.data.value }) }
    worker.onerror = () => setIndexError('Repertoire indexing failed. Reload to try again; saved records are unchanged.')
    worker.postMessage({ task: 'entries', lines, catalog })
    return () => worker.terminate()
  }, [lines, catalog])
  const entries = useMemo(() => lines.length <= 200 ? repertoireEntries(lines, catalog) : indexed?.lines === lines && indexed.catalog === catalog ? indexed.value : [], [lines, catalog, indexed])
  const matching = useMemo(() => filterRepertoire(entries, query, side), [entries, query, side])
  const families = useMemo(() => {
    const groups = new Map<string, typeof entries>()
    for (const entry of matching) { const group = groups.get(entry.family) || []; group.push(entry); groups.set(entry.family, group) }
    return [...groups].sort(([a], [b]) => a.localeCompare(b))
  }, [matching])
  const members = useMemo(() => matching.filter(entry => entry.family === family), [matching, family])
  useEffect(() => {
    if (members.length <= 200) return
    const worker = new Worker(new URL('./repertoireTree.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => { if (event.data.error) setIndexError(event.data.error); else setTreeResult({ members, value: event.data.value }) }
    worker.onerror = () => setIndexError('Move tree indexing failed. Reload to try again; saved records are unchanged.')
    worker.postMessage({ task: 'tree', entries: members })
    return () => worker.terminate()
  }, [members])
  const tree = useMemo(() => members.length <= 200 ? buildRepertoireTree(members) : treeResult?.members === members ? treeResult.value : buildRepertoireTree([]), [members, treeResult])
  const indexing = lines.length > 200 && indexed?.lines !== lines || members.length > 200 && treeResult?.members !== members
  useEffect(() => {
    if (!targetLine || openedTarget.current) return
    const entry = entries.find(entry => entry.line.id === targetLine)
    if (!entry) return
    if (family !== entry.family) { setFamily(entry.family); return }
    const targetPath = tree.paths.get(targetLine)
    if (!targetPath) return
    setSelection({ id: targetLine, ply: targetPath.length - 1, saved: true })
    setPreviewPly(previewStart(entry.line))
    setExpanded(new Set(targetPath.map(node => node.key)))
    openedTarget.current = true
    const url = new URL(location.href); url.searchParams.set('family', entry.family); history.replaceState(null, '', url)
  }, [targetLine, entries, family, tree])
  const selected = selection ? tree.paths.get(selection.id)?.[selection.ply] : undefined
  const branchNode = selected || tree.roots[0]
  const node = previewPly !== null && branchNode ? tree.paths.get(selection?.id || branchNode.representative.id)?.[previewPly] || branchNode : branchNode
  const associated = useMemo(() => branchNode ? descendantEntries(branchNode) : [], [branchNode])
  const line = associated.find(entry => entry.line.id === selection?.id)?.line || node?.representative
  const path = line && node ? tree.paths.get(line.id)!.slice(1, node.ply + 1) : []
  const selectedPath = new Set(path.map(step => step.key))
  const selectedLine = selected && selection?.saved ? lines.find(line => line.id === selection.id) : undefined
  const evaluation = selectedLine && repertoireEvaluation(selectedLine)
  const familyMembers = entries.filter(entry => entry.family === family)
  const availableSides = (['white', 'black'] as const).filter(value => familyMembers.some(entry => !entry.line.sideUnconfirmed && entry.line.side === value))
  const practiceSide = side !== 'both' ? side : availableSides.includes(familySide) ? familySide : availableSides[0]
  const selectedFamily = !selected
  const rows = useMemo(() => {
    const output: { first: RepertoireNode; chain: RepertoireNode[]; depth: number; saved?: Variation }[] = []
    const visit = (first: RepertoireNode, depth: number) => {
      const chain = compressed(first), last = chain[chain.length - 1]
      if (last.children.size) output.push({ first, chain, depth })
      for (const entry of last.ends) output.push({ first, chain, depth: depth + (last.children.size ? 1 : 0), saved: entry.line })
      if (first.count < 2 || expanded.has(first.key)) for (const child of last.children.values()) visit(child, depth + 1)
    }
    tree.roots.forEach(root => { output.push({ first: root, chain: [root], depth: -1 }); root.children.forEach(child => visit(child, 0)) })
    return output
  }, [tree, expanded])
  function chooseFamily(name: string) { setPreviewPly(null); setPracticeSelection(null); setDetails(false); setFamily(name); setSelection(null); setExpanded(new Set()); const url = new URL(location.href); if (name) url.searchParams.set('family', name); else url.searchParams.delete('family'); history.replaceState(null, '', url) }
  function select(next: RepertoireNode, id = next.representative.id, saved = false) { setPreviewPly(saved ? previewStart(lines.find(line => line.id === id)!) : null); setPracticeSelection({id,ply:next.ply,saved}); setSelection({ id, ply: next.ply, saved }); setDetails(false); setNotice('') }
  function navigate(ply: number) { if (line) setPreviewPly(ply) }
  async function copy(value: string, label: string) { try { await navigator.clipboard.writeText(value); setNotice(`${label} copied`) } catch { setNotice(`Could not copy ${label}. Open Details to copy it manually.`); setDetails(true) } }
  function toggle(key: string) { setExpanded(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next }) }
  function prefer(next: RepertoireNode) {
    if (!next.parent || !next.move || next.unconfirmed) return
    try { const updated = preferMove(readPreferences(localStorage.getItem(PREFERENCES_KEY)), next.side, next.parent.fen, next.move); localStorage.setItem(PREFERENCES_KEY, JSON.stringify(updated)); setPreferences(updated); setPreferenceError('') } catch { setPreferenceError('Preferred move could not be saved. Browser storage is unavailable.') }
  }
  // The snapshot follows tree edges, never the transposition index or preview leaf.
  const fullPracticeTree = useMemo(() => query ? buildRepertoireTree(entries.filter(e=>e.family===family)) : tree, [query,entries,family,tree])
  function configureBranch(target: RepertoireNode, nodes?: RepertoireNode[]) {
    const exact = fullPracticeTree.paths.get(target.representative.id)?.[target.ply] || target
    const key = branchSessionKey(family, exact.side, exact.key, familyStore.records)
    setConfiguration({key, label: `${family} — ${sequenceLabel([exact]) || 'Starting position'}`, side: exact.side, candidates: descendantEntries(exact).map(e=>e.line), ply: exact.ply, nodes})
  }
  function practiceSelected() {
    if (selectedLine) { act('practice', selectedLine, 0, selectedLine.side); return }
    if (selectedFamily) { if (practiceSide) practiceFamily(practiceSide); return }
    const target = practiceSelection && tree.paths.get(practiceSelection.id)?.[practiceSelection.ply] || node
    if(target) configureBranch(target)
  }
  function launchBranch(reviewOnly = false, existing?: FamilyRecord) {
    const old = existing || (configuration ? familyStore.records[configuration.key] : undefined)
    const prior = old?.session.branch
    const byId = new Map(lines.map(line=>[line.id,line]))
    const failed = old ? new Set([...new Map(old.session.attempts.map(a=>[a.id,a])).values()].filter(a=>!a.success).map(a=>a.id)) : new Set<string>()
    const config = configuration || (old && prior ? {key:prior.key,label:old.session.family,side:old.session.side,candidates:old.session.ids.flatMap(id=>{const l=byId.get(id);return l && lineSignature(l)===old.session.signatures[id] ? [l] : []}),ply:Object.values(prior.starts)[0] || 0} : null)
    if(!config) return
    const options: BranchOptions = configuration ? {...practiceOptions,opponent:'uniform'} : {...prior!.options,opponent:'uniform',coverage: reviewOnly ? 'once' : prior!.options.coverage}
    const record = newBranch(config.key,config.label,config.side,config.candidates.filter(l=>!reviewOnly||failed.has(l.id)),config.ply,options,crypto.getRandomValues(new Uint32Array(1))[0],old,Date.now(),{filters,targetRating})
    record.session.reviewMode = reviewOnly
    if(!record.session.ids.length) {setSessionError('No unchanged, replayable continuations with moves for this side.');return}
    if(saveFamily(record)){setConfiguration(null);openSession(config.key);practiceSession(record)}
  }
  function beginFamily(playingSide: Side, name = family) {
    const key = familyKey(name, playingSide)
    const record = newFamily(name, playingSide, entries.filter(entry => entry.family === name).map(entry => entry.line), familyStore.records[key])
    if (record.session.ids.length) {
      if (saveFamily(record)) { openSession(key); practiceSession(record) }
    }
    else if (!record.session.ids.length) setSessionError('No replayable saved lines with moves for this side.')
  }
  function practiceFamily(playingSide: Side) {
    const key = familyKey(family, playingSide), existing = familyStore.records[key]
    if (existing && !existing.session.finished) { openSession(key); practiceSession(existing) }
    else beginFamily(playingSide)
  }
  return <div className="learn-shell repertoire-page">
    {!embedded && <header className="learn-header"><nav aria-label="Main navigation"><button onClick={back}>♞ Opening Atlas</button><span aria-current="page">Repertoire</span></nav></header>}
    <main className="rep-main">
      <h1>My repertoire</h1>
      <div className="rep-toolbar"><span>Playing as</span><div role="group" aria-label="Repertoire playing side">{(['white', 'black', 'both'] as const).map(value => <button key={value} aria-pressed={side === value} onClick={() => { setSide(value); setPreviewPly(null); setSelection(null); setPracticeSelection(null); setDetails(false) }}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><input aria-label="Search repertoire" placeholder="Search openings, ECO or moves…" value={query} onChange={event => setQuery(event.target.value)}/></div>
      {configuration && <section ref={configurationRef} tabIndex={-1} onKeyDown={event=>{if(event.key==='Escape')setConfiguration(null)}} className="rep-practice-config" role="dialog" aria-modal="false" aria-label="Practice branch configuration">
        <h2>Practice {configuration.label}</h2>
        <p>{branchLines(configuration.candidates,configuration.side,configuration.ply,{...practiceOptions,opponent:'uniform'}).length} saved variation{branchLines(configuration.candidates,configuration.side,configuration.ply,{...practiceOptions,opponent:'uniform'}).length===1?'':'s'} · Playing {configuration.side}</p>
        {!!configuration.nodes && configuration.nodes.length>1 && <label>Branch position <select aria-label="Practice branch position" value={configuration.ply} onChange={e=>configureBranch(configuration.nodes!.find(n=>n.ply===Number(e.target.value))!,configuration.nodes)}>{configuration.nodes.map(n=><option key={n.key} value={n.ply}>{sequenceLabel([n])}</option>)}</select></label>}
        {([['order','Order',[['mixed','Mixed'],['sequential','Sequential']]],['coverage','Coverage',[['once','Every line once'],['continuous','Continuous']]],['start','Starting point',[['branch','Branch position'],['full','Full opening']]]] as const).map(([key,label,choices])=><fieldset key={key}><legend>{label}</legend>{choices.map(([value,text])=><label key={value}><input type="radio" name={`branch-${key}`} checked={practiceOptions[key]===value} onChange={()=>changePractice({...practiceOptions,[key]:value})}/>{text}</label>)}</fieldset>)}
        <p>Recall saved continuations. Session coverage and memorization mastery are separate. Full opening starts from the saved line’s original position.</p>
        <button disabled={busy||!!familyStore.error} onClick={()=>launchBranch()}>Start Practice</button>
        {familyStore.records[configuration.key] && <button onClick={()=>{openSession(configuration.key);setConfiguration(null);practiceSession(familyStore.records[configuration.key])}}>Resume session</button>}
        <button onClick={()=>setConfiguration(null)}>Cancel</button>
      </section>}
      {(familyStore.error || sessionError) && <p role="alert">{familyStore.error || sessionError}</p>}{indexError && <p role="alert">{indexError}</p>}{indexing && <p role="status">Indexing saved repertoire… You can keep navigating.</p>}
      {preferenceError && <p role="alert">{preferenceError}</p>}
      {!ready ? <p role="status">Loading saved variations…</p> : !family ? <section aria-label="Opening families" className="rep-families"><WindowedList count={families.length} estimate={64} render={i => { const [name, group] = families[i]; return <button key={name} onClick={() => chooseFamily(name)}><strong>{name}</strong><span>{group.length} saved variation{group.length === 1 ? '' : 's'}</span></button> }}/>{!indexing && !families.length && <p>No saved variations match. Generate or import a line on the main board.</p>}</section> : <>
        <div className="rep-family-heading"><button onClick={() => chooseFamily('')}>← All openings</button><h2><button onClick={() => { setSelection(null); setPreviewPly(null); setPracticeSelection(null); setDetails(false) }}>{family}</button></h2></div>
        <div className="rep-layout">
        {node && line && <details className="rep-preview" open aria-label="Repertoire position preview"><summary className="rep-preview-toggle">Line preview</summary>
          <div className="rep-preview-heading"><strong>{node.fen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move · move {node.fen.split(' ')[5]}</strong><button onClick={() => setOrientation(value => value === 'white' ? 'black' : 'white')}>Flip preview</button></div>
          <RepertoirePreview key={line.id} line={line} ply={node.ply} orientation={orientation} navigate={navigate}/>
          <section className="rep-selected-line" aria-label="Selected repertoire item">
            <h3>{selectedLine ? repertoireTitle(selectedLine, family) : selectedFamily ? family : repertoireGroupTitle([branchNode!], catalog, family) || 'Selected branch'}</h3>
            {selectedLine ? <>
              <p>{selectedLine.sideUnconfirmed ? 'Color unconfirmed' : `Playing ${selectedLine.side === 'black' ? 'Black' : 'White'}`} · {Math.ceil(selectedLine.moves.length / 2)} moves</p>
              <p><OpponentSource line={selectedLine}/></p>
              <p>Memorized {stats[selectedLine.id]?.perfect || 0}/{stats[selectedLine.id]?.target || 5}</p>
              {(stats[selectedLine.id]?.lastPracticed || selectedLine.lastPracticed) && <p className="rep-note">Last practiced {repertoireDate(stats[selectedLine.id]?.lastPracticed || selectedLine.lastPracticed)}</p>}
            </> : selectedFamily ? <><p>{familyMembers.length} saved variations · White: {familyMembers.filter(e => !e.line.sideUnconfirmed && e.line.side === 'white').length} · Black: {familyMembers.filter(e => !e.line.sideUnconfirmed && e.line.side === 'black').length}</p><p>{familyMembers.filter(e => (stats[e.line.id]?.perfect || 0) >= (stats[e.line.id]?.target || 5)).length}/{familyMembers.length} lines memorized</p></> : <p>{associated.length} saved variations · Playing {branchNode?.side}</p>}
            <div className="rep-actions">
              {selectedFamily && side === 'both' && availableSides.length > 1 && <select aria-label="Family practice side" value={practiceSide} onChange={e => setFamilySide(e.target.value as Side)}><option value="white">White</option><option value="black">Black</option></select>}
              <button className="rep-primary" disabled={busy || indexing || (selectedFamily ? !practiceSide || !!familyStore.error : selectedLine ? selectedLine.sideUnconfirmed || !selectedLine.moves.length : !associated.some(e => !e.line.sideUnconfirmed && e.line.moves.length))} onClick={practiceSelected}>{selectedLine || selectedFamily ? 'Practice' : 'Practice branch'}{!selectedLine && practiceSelection && !practiceSelection.saved ? ` · ${sequenceLabel([tree.paths.get(practiceSelection.id)![practiceSelection.ply]]) || 'Starting position'}` : ''}</button>
              <button disabled={busy || line.sideUnconfirmed} onClick={() => act('analysis', line, node.ply, orientation)}>Open in Analysis</button>
              <details className="rep-overflow" key={`${selection?.id}-${selection?.saved}-${selectedFamily}`}><summary aria-label="More actions">⋯</summary><div className="rep-menu">
                {selectedFamily && practiceSide && <button onClick={()=>practiceFamily(practiceSide)}>Practice family until mastered</button>}
                <button disabled={busy || node.unconfirmed || !line.moves.slice(node.ply).length} onClick={()=>selectedLine ? act('practice',selectedLine,node.ply,selectedLine.side) : configureBranch(node,tree.paths.get(line.id)?.slice(0,node.ply+1))}>{selectedLine ? 'Practice from preview position' : 'Practice branch from preview position'}</button>
                {selectedLine && <><button onClick={() => void copy(selectedLine.pgn, 'PGN')}>Copy PGN</button><button onClick={() => void copy(node.fen, 'FEN')}>Copy FEN</button></>}
                <button onClick={e => { setDetails(value => !value); e.currentTarget.closest('details')?.removeAttribute('open') }}>View Details</button>
                {selectedLine && <button className="rep-delete" disabled={busy} onClick={() => remove(selectedLine)}>Delete line</button>}
              </div></details>
            </div>
            {notice && <p role="status">{notice}</p>}
            {details && <div className="rep-details">{selectedLine && <>              <p>{repertoireDate(selectedLine.created) ? `Created ${repertoireDate(selectedLine.created)}` : 'Date unavailable'}</p>
              <p>{evaluation ? `${evaluation.provenance}: ${evaluation.score}` : 'Evaluation unavailable'}</p>
              <p className="rep-note">{repertoireOutcome(selectedLine)} · {evaluation?.quality || 'Verification unavailable'}{evaluation?.depth !== undefined ? ` · Depth ${evaluation.depth}` : ''}</p>
</>}<p>{selectedLine?.termination || 'Stopping reason unavailable'}</p><p>Position FEN: <code>{node.fen}</code></p>{selectedLine && <><p><OpponentSource line={selectedLine}/></p><pre className="rep-pgn">{opponentProvenance(selectedLine).details}</pre><pre className="rep-pgn">{selectedLine.pgn}</pre><p>Attempts {stats[selectedLine.id]?.attempts || 0}</p><details><summary>Saved generation metadata</summary><pre className="rep-pgn">{JSON.stringify({ recommendation: selectedLine.recommendation, branch: selectedLine.branch, aggressive: selectedLine.aggressive, castlingPreference: selectedLine.castlingPreference }, null, 2)}</pre></details></>}<div className="rep-history">{path.map(step => <button key={step.key} onClick={() => navigate(step.ply)}>{sequenceLabel([step])}</button>)}</div></div>}
          </section>
        </details>}
<section className="rep-tree" aria-label="Repertoire move tree">

          <WindowedList count={rows.length} revealIndex={rows.findIndex(row => row.saved?.id === targetLine)} estimate={84} render={i => {
            const { first, chain, depth, saved } = rows[i], last = chain[chain.length - 1], expandable = !saved && first.count >= 2 && last.children.size > 0
            if (depth === -1) return <div className="rep-node" key={first.key}><button className="rep-root" aria-pressed={selected === first} onClick={() => select(first)}>{first.unconfirmed ? 'Playing color unconfirmed' : `Playing ${first.side}`} · {first.fen === new Chess().fen() ? 'Starting position' : `Custom start · move ${first.fen.split(' ')[5]}`} · {first.count} continuations</button>{!first.unconfirmed && <button className="rep-practice-icon" aria-label={`Practice branch Playing ${first.side}`} onClick={()=>configureBranch(first)}>▶</button>}</div>
            const ownMove = !first.unconfirmed && first.parent?.fen.split(' ')[1] === first.side[0]
            const preferred = ownMove && preferences[preferenceKey(first.side, first.parent!.fen)] === first.move
            const badge = repertoireBadge(first, preferences), progress = saved && stats[saved.id], rowEvaluation = saved && repertoireEvaluation(saved)
            return <div ref={element => { if (element && saved?.id === targetLine && scrollTarget.current && selection?.id === targetLine) { scrollTarget.current = false; requestAnimationFrame(() => element.scrollIntoView({ block: 'nearest' })) } }} className={`rep-node${selectedPath.has(first.key) ? ' rep-path' : ''}`} style={{ marginLeft: Math.min(depth, 5) * 12 }} key={saved?.id || first.key}>
              {expandable && <button className="rep-expand" aria-label={`${expanded.has(first.key) ? 'Collapse' : 'Expand'} ${sequenceLabel(chain)}`} aria-expanded={expanded.has(first.key)} onClick={() => toggle(first.key)}>{expanded.has(first.key) ? '−' : '+'}</button>}
              <button className="rep-node-label" aria-pressed={saved ? !!selection?.saved && selection.id === saved.id : selected === first} onClick={() => select(saved ? last : first, saved?.id, !!saved)}><strong>{saved ? repertoireTitle(saved, family, `${sequenceLabel([first])} Line`) : repertoireGroupTitle(chain, catalog, family)}</strong><small>{saved ? `${rowEvaluation ? rowEvaluation.provenance + ': ' + rowEvaluation.score + ' · ' : side === 'both' ? saved.side + ' · ' : ''}${Math.ceil(saved.moves.length / 2)} moves · ${progress?.perfect || 0}/${progress?.target || 5} memorized · ${repertoireOutcome(saved)}` : `${first.count} saved continuations`}{!saved && badge ? ` · ${badge}` : ''}</small>{saved ? <small className="rep-source"><OpponentSource line={saved}/></small> : <small className="rep-source" title="Each saved record counted once. Maia-based includes mixed Lichess and Maia lines; unknown includes records without verified generated opponent sources.">{branchProvenance(first)}</small>}</button>
              {!first.unconfirmed && <button className="rep-practice-icon" aria-label={saved ? `Practice ${repertoireTitle(saved,family)}` : `Practice branch ${sequenceLabel([first])}`} disabled={!!saved && (saved.sideUnconfirmed || !saved.moves.length)} onClick={()=>saved ? act('practice',saved,0,saved.side) : configureBranch(first,chain)}>▶</button>}
              {ownMove && <button className="rep-star" aria-label={`${preferred ? 'Clear preferred' : 'Prefer'} ${first.san}`} aria-pressed={!!preferred} onClick={() => prefer(first)}>{preferred ? '★' : '☆'}</button>}
            </div>
          }}/>
          {tree.invalid.map(entry => <p key={entry.line.id}>{entry.line.customName || entry.line.name} — stored move history cannot be replayed. Original record retained.</p>)}
          {!indexing && !members.length && <p>No matching lines in this family.</p>}
        </section>
        </div>
      </>}
    </main>
  </div>
}
