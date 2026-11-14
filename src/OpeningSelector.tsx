import { WindowedList } from './WindowedList'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import { familyFavoriteId, openingFamily, openingFavoriteId, openingPath, searchOpenings, type OpeningRecord } from './openings'

type Props = { records: OpeningRecord[]; favorites: string[]; onToggleFavorite: (id: string) => void; onChoose: (record: OpeningRecord) => void; onClose: () => void }

export default function OpeningSelector({ records, favorites, onToggleFavorite, onChoose, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState('')
  const [preview, setPreview] = useState<OpeningRecord | null>(null)
  const scrollPreview = useRef(false)
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('keydown', close); document.body.style.overflow = previousOverflow }
  }, [onClose])
  const families = useMemo(() => {
    const counts = new Map<string, number>()
    records.forEach(record => counts.set(openingFamily(record), (counts.get(openingFamily(record)) || 0) + 1))
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]))
  }, [records])
  const recordsById = useMemo(() => new Map(records.map(record => [openingFavoriteId(record), record])), [records])
  const favoriteItems = favorites.flatMap<{ id: string; family?: string; record?: OpeningRecord }>(id => {
    if (id.startsWith('family:')) { const name = id.slice(7); return families.some(([familyName]) => familyName === name) && name.toLowerCase().includes(query.trim().toLowerCase()) ? [{ id, family: name }] : [] }
    const record = recordsById.get(id)
    return record && searchOpenings([record], query).length ? [{ id, record }] : []
  })
  const matches = useMemo(() => searchOpenings(records, query, family).sort((a, b) => (query.toLowerCase().includes('london') || family === 'London System' ? Number(b.kind === 'study') - Number(a.kind === 'study') : 0) || a.name.localeCompare(b.name) || a.pgn.length - b.pgn.length), [records, query, family])
  const catalogCount = records.filter(record => record.kind !== 'study').length
  const star = (id: string, name: string) => <button type="button" className="opening-star" aria-label={`${favorites.includes(id) ? 'Remove from' : 'Add to'} favorites: ${name}`} aria-pressed={favorites.includes(id)} title={`${favorites.includes(id) ? 'Remove from' : 'Add to'} favorites`} onClick={() => onToggleFavorite(id)}>{favorites.includes(id) ? '★' : '☆'}</button>
  const recordRow = (record: OpeningRecord) => { const path = openingPath(record); return <div className="opening-result-row" key={openingFavoriteId(record)}><button ref={element => { if (element && preview === record && scrollPreview.current) { scrollPreview.current = false; element.scrollIntoView({ block: 'nearest' }) } }} className={`opening-result ${preview === record ? 'active' : ''}`} aria-pressed={preview === record} style={{ paddingLeft: `${12 + Math.min(3, path.length) * 12}px` }} onClick={() => setPreview(record)}><strong>{path.length ? path.at(-1) : record.name}</strong><span>{record.kind === 'study' ? 'Study setup' : record.eco} · {record.name}</span><small>{record.pgn}</small></button>{star(openingFavoriteId(record), record.name)}</div> }
  return <div className="opening-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="opening-dialog" role="dialog" aria-modal="true" aria-label="Select opening" onKeyDown={event => {
    if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !matches.length) return
    event.preventDefault()
    event.stopPropagation()
    const current = preview ? matches.indexOf(preview) : -1
    const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : matches.length - 1) : Math.max(0, Math.min(matches.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    scrollPreview.current = true
    setPreview(matches[next])
  }}>
    <div className="opening-dialog-header"><div><h2>Select opening</h2><p>{catalogCount.toLocaleString()} named catalog lines · {records.length - catalogCount} study setup · ECO A–E</p></div><button onClick={onClose} aria-label="Close opening selector">×</button></div>
    <input autoFocus aria-label="Search openings by name, ECO, or moves" placeholder="Search name, ECO, or moves (for example: London System)" value={query} onChange={event => { setQuery(event.target.value); setPreview(null) }}/>
    <div className="opening-browser"><nav className="opening-families" aria-label="Opening families">
      <section aria-label="Favorite openings" className="opening-favorites"><h3>★ Favorites</h3>{favoriteItems.map(item => <div className="opening-family-row" key={item.id}><button className={item.record ? preview === item.record ? 'active' : '' : family === item.family ? 'active' : ''} onClick={() => { if (item.record) setPreview(item.record); else { setFamily(item.family!); setQuery(''); setPreview(null) } }}>{item.record?.name || item.family}</button>{star(item.id, item.record?.name || item.family!)}</div>)}{!favoriteItems.length && <p>{favorites.length ? 'No favorites match your search.' : 'Star an opening to keep it here.'}</p>}</section>
      <button className={!family ? 'active' : ''} onClick={() => { setFamily(''); setPreview(null) }}>All families <span>{records.length}</span></button>{families.map(([name, count]) => <div className="opening-family-row" key={name}><button className={family === name ? 'active' : ''} onClick={() => { setFamily(name); setPreview(null) }}>{name}<span>{count}</span></button>{star(familyFavoriteId(name), name)}</div>)}</nav>
      <div className="opening-results"><p className="opening-results-label">{family || 'All named openings'} · {matches.length.toLocaleString()} lines · click or use ↑ ↓ to preview</p><WindowedList key={query+family} count={matches.length} estimate={76} revealIndex={preview ? matches.indexOf(preview) : undefined} render={index => recordRow(matches[index])}/>{!matches.length && <p className="empty-note">No catalog match. You can still load any legal FEN or PGN in Settings.</p>}</div>
      <aside className="opening-preview" aria-label="Opening position preview">{preview ? <><h3>{preview.name} {star(openingFavoriteId(preview), preview.name)}</h3><p>{preview.kind === 'study' ? 'Representative study setup · based on D02. Black can choose other replies.' : `Catalog opening · ${preview.eco}`}</p><button className="opening-preview-open" onClick={() => onChoose(preview)}>Open on board</button><div className="opening-preview-board"><Chessboard options={{ position: preview.fen, allowDragging: false, showNotation: true, boardStyle: { borderRadius: 5 }, lightSquareStyle: { backgroundColor: '#f0d9b5' }, darkSquareStyle: { backgroundColor: '#b58863' } }}/></div><p className="opening-preview-moves">{preview.pgn}</p><p>{preview.fen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move</p></> : <p className="opening-preview-empty">Select a line to preview its board position. Opening it will replace the current board.</p>}</aside>
    </div><p className="opening-credit">Catalog: <a href="https://github.com/lichess-org/chess-openings" target="_blank" rel="noreferrer">Lichess chess-openings</a> · CC0. The London study setup is an illustrative position. London catalog labels are grouped for browsing; original names are shown in each result.</p>
  </section></div>
}
