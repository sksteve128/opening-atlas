import { expect,test } from 'vitest'
import { opponentPreference,effectiveOpponent,availableGenerationMode } from './opponentSettings'
test('default and explicit persistent opponent preferences',()=>{
 expect(opponentPreference({getItem:()=>null})).toBe('lichess-stockfish')
 expect(opponentPreference({getItem:()=> 'invalid'})).toBe('lichess-stockfish')
 for(const value of ['lichess-stockfish','maia','lichess','hybrid'])expect(opponentPreference({getItem:()=>value})).toBe(value)
 expect(effectiveOpponent('maia','advantage')).toBe('maia')
 expect(effectiveOpponent('stockfish','advantage')).toBe('lichess-stockfish')
 expect(opponentPreference({getItem:()=> 'stockfish'})).toBe('lichess-stockfish')
 expect(availableGenerationMode('complete')).toBe('advantage')
 expect(availableGenerationMode('strong')).toBe('advantage')
 expect(availableGenerationMode('mainline')).toBe('mainline')
 expect(effectiveOpponent('stockfish','advanced')).toBe('lichess')
})
