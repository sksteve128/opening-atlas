export type BoardEvaluation = { cp: number; mate?: number; winner?: string; estimated?: boolean }
export function evaluationLabel(value?: BoardEvaluation) {
  return !value ? 'Not analyzed' : value.winner ? `${value.winner} wins` : value.mate !== undefined ? `M${value.mate}` : `${value.cp >= 0 ? '+' : ''}${(value.cp / 100).toFixed(2)}`
}
export function EvaluationBar({ evaluation, orientation }: { evaluation?: BoardEvaluation; orientation: 'white' | 'black' }) {
  const cp = evaluation?.cp ?? 0
  const share = evaluation?.winner ? evaluation.winner === 'White' ? 100 : 0 : 50 + 49.5 * Math.tanh(cp / 350)
  return <div className={'eval-bar ' + orientation} role="meter" aria-label={evaluation?.winner ? `Checkmate · ${evaluation.winner} wins` : `Stockfish ${evaluation?.estimated ? 'latest estimate' : 'evaluation'} ${evaluationLabel(evaluation)} from White perspective`} aria-valuemin={-1000} aria-valuemax={1000} aria-valuenow={evaluation ? Math.max(-1000, Math.min(1000, cp)) : undefined}><span className="eval-fill" style={{ height: (orientation === 'white' ? share : 100 - share) + '%' }}/><span className="eval-midpoint"/></div>
}
