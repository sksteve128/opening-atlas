import type { Variation } from './learning'
import { opponentProvenance } from './repertoireSummary'

export function OpponentSource({ line, className = '' }: { line: Variation; className?: string }) {
  const source = opponentProvenance(line)
  return <span className={className} title={source.details} aria-label={`${source.label}${source.reason ? ` · ${source.reason}` : ''}`}>
    {source.label}{source.reason && <> · {source.reason}</>}
  </span>
}
