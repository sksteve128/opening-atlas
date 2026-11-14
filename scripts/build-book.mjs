// Regenerate the opening browser and fallback book from the pinned Lichess TSVs (CC0).
import fs from 'node:fs'
import { Chess } from 'chess.js'

const identity = fen => {
  const parts = fen.split(' ')
  if (!new Chess(fen).moves({ verbose: true }).some(move => move.flags.includes('e'))) parts[3] = '-'
  return parts.slice(0, 4).join(' ')
}
const book = {}
const openings = []
for (const file of process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c', 'd', 'e'].map(letter => `data/openings/${letter}.tsv`)) {
  for (const row of fs.readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
    const [eco, name, pgn] = row.split('\t')
    if (!pgn) continue
    const line = new Chess()
    try { line.loadPgn(pgn) } catch { throw new Error(`Invalid PGN in ${file}: ${name}`) }
    const game = new Chess()
    const uciMoves = []
    for (const move of line.history({ verbose: true })) {
      const key = identity(game.fen()), uci = move.from + move.to + (move.promotion || '')
      uciMoves.push(uci)
      const position = book[key] ||= { moves: {} }
      position.moves[uci] ||= { uci, san: move.san }
      game.move(move)
    }
    const end = book[identity(game.fen())] ||= { moves: {} }
    if (!end.name || name.length < end.name.length) end.name = name
    end.eco = eco
    openings.push({ eco, name, pgn, uci: uciMoves.join(' '), fen: game.fen() })
  }
}
fs.writeFileSync('public/book.json', JSON.stringify(Object.fromEntries(Object.entries(book).map(([fen, entry]) => [fen, { ...entry, moves: Object.values(entry.moves) }]))))
fs.writeFileSync('public/openings.json', JSON.stringify(openings))
console.log(`${openings.length} openings and ${Object.keys(book).length} positions written`)
