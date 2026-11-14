import type { OpponentModel, GenerationMode } from './learning'
export function opponentPreference(storage: Pick<Storage,'getItem'>):OpponentModel {
 const saved=storage.getItem('atlas-opponent-model')
 return saved==='lichess-stockfish'||saved==='maia'||saved==='lichess'||saved==='hybrid'?saved:'lichess-stockfish'
}
export function effectiveOpponent(preference:OpponentModel,mode:GenerationMode):OpponentModel {
 return mode==='advanced'?'lichess':preference==='stockfish'?'lichess-stockfish':preference
}

export function availableGenerationMode(mode:GenerationMode):GenerationMode {
 return mode==='complete'||mode==='strong'||mode==='human'?'advantage':mode
}
