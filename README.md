# Opening Atlas

A local chess opening trainer that combines Stockfish analysis with Lichess opening data to explore, visualize, and practice continuations. It uses chess.js for legal moves; it does not implement a chess engine.

## Run locally

Requires Node.js and npm. Install dependencies, copy the Stockfish browser assets from the installed package, and start Vite:

```sh
npm ci
cp node_modules/stockfish/bin/stockfish-19-lite-single.{js,wasm} public/engine/
npm run dev
```

Open the local address printed by Vite. Run `npm test` and `npm run build` for checks. The generated Stockfish files are ignored by Git.

## How it works

The React and TypeScript interface presents a board, opening explorer, and practice tools. A browser worker runs Stockfish analysis; searches are queued and can be cancelled. Opening lines can be replayed as branches, including positions reached through different move orders. Saved lines and practice records use IndexedDB. PGN import and export are supported. Background generation requires the local Vite server; static hosting alone does not provide it.

Lichess Explorer may require sign-in. If access fails, the app labels the published-opening fallback and does not present it as game-frequency data. Optional Maia-2 and Patricia integrations require separate installation; basic browser analysis does not require them. Browser data can be lost if the profile is cleared.

## Third-party materials

Stockfish.js is GPL-3.0 and is installed separately from npm; see `public/engine/COPYING.txt` and https://github.com/nmrugg/stockfish.js for the project and source. The opening catalog comes from the CC0 Lichess opening dataset; details and its pinned revision are in `data/openings/README.md`. Other dependencies have their own licenses.

This review copy is not a public release. Review third-party license obligations, configuration, and security before publishing. No license for the original app code has been selected yet.
