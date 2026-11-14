import type { Evaluation } from './engine'

// A depth target is a search milestone, never a claim about continuation soundness.
export function searchStatus(lines: Evaluation[], target: number, searching: boolean) {
  const depth = lines.length ? Math.min(...lines.map(line => line.depth)) : 0
  const incomplete = lines.some(line => line.search?.multiPVComplete === false || line.search?.cancelled)
  const reached = lines.length > 0 && depth >= target && !incomplete
  const state = searching ? 'Search in progress' : incomplete ? 'Incomplete analysis' : reached ? 'Target depth reached' : lines.length ? 'Search stopped below target' : 'Analysis unavailable'
  return {
    label: lines.length || searching ? `Depth ${depth}/${target}${searching ? ' ⟳' : reached ? ' ✓' : ' · Incomplete'}` : 'Unavailable',
    detail: `${state}. ${lines.some(line => line.source === 'cloud') ? 'Includes cached Lichess cloud analysis. ' : ''}${lines.some(line => line.search?.stoppedByBudget) ? 'Time budget reached. ' : ''}The checkmark means only that the displayed search depth target was reached. Independent continuation verification is recorded in line Details.`,
  }
}
