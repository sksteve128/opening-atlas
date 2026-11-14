import type { ReactNode } from 'react'
import type { FamilyRecord } from './familyPractice'
import { WindowedList } from './WindowedList'

export type PlaylistMode = 'SAVED_LINES' | 'BRANCH_PRACTICE' | 'FAMILY_PRACTICE' | 'REVIEW' | 'SAVED_CUSTOM'
export const playlistTitles: Record<PlaylistMode, string> = { SAVED_LINES: 'Saved Lines', BRANCH_PRACTICE: 'Branch Practice', FAMILY_PRACTICE: 'Family Practice', REVIEW: 'Review', SAVED_CUSTOM: 'Saved Playlist' }
export function playlistMode(record: FamilyRecord | null): PlaylistMode {
  return !record ? 'SAVED_LINES' : record.session.reviewMode ? 'REVIEW' : record.session.branch ? 'BRANCH_PRACTICE' : 'FAMILY_PRACTICE'
}
export function practiceEntryStatus(status: string, mastered: boolean) {
  return [status === 'Passed' ? 'Practiced' : status === 'Needs review' ? 'Practiced · Review suggested' : status, mastered ? 'Mastered' : ''].filter(Boolean).join(' · ')
}
export function Playlist({ mode, count, render, tools, progress, title, availableModes = [mode], onModeChange }: {
  title?: string; mode: PlaylistMode; count: number; render: (index: number) => ReactNode; tools?: ReactNode; progress?: ReactNode;
  availableModes?: PlaylistMode[]; onModeChange?: (mode: PlaylistMode) => void;
}) {
  return <section className="shared-playlist" aria-label="Repertoire playlist" data-mode={mode}>
    <div className="playlist-heading">{availableModes.length > 1 ? <select aria-label="Playlist mode" value={mode} onChange={event => onModeChange?.(event.target.value as PlaylistMode)}>{availableModes.map(value => <option key={value} value={value}>{playlistTitles[value]}</option>)}</select> : <strong>{title || playlistTitles[mode]}</strong>}<span>{progress ?? `${count} variations`}</span></div>
    {tools}
    <div className="saved-list"><WindowedList count={count} estimate={64} render={render}/>{!count && <p className="empty-note">No variations match this view.</p>}</div>
  </section>
}
