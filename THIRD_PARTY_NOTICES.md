# Third-party notices

- **Stockfish.js 19.0.1:** GPL-3.0 engine and npm package. The installed package supplies the browser worker and WebAssembly engine; these generated files are not committed. License: `public/engine/COPYING.txt`. Corresponding upstream release source and build instructions: https://github.com/nmrugg/stockfish.js/tree/v19.0.1. If you redistribute built engine files, provide the corresponding source and preserve applicable license notices.
- **chess.js 1.4.0:** BSD-2-Clause. Copyright and license: `third-party/chess-js-LICENSE.txt`. Source: https://github.com/jhlywa/chess.js/tree/v1.4.0.
- **Lichess opening catalog:** CC0. The included TSV files are pinned to the revision cited in `data/openings/README.md`; `public/openings.json` and `public/book.json` are derived from them. Source and dedication: https://github.com/lichess-org/chess-openings/tree/a6189a30dc273ccb21fc2536a9a2fefd5592a67a.
- **React, React DOM, React Chessboard and XYFlow React:** MIT. **Lucide React:** ISC. These are installed as npm dependencies; their license notices are included in their respective packages. The lockfile records resolved versions and additional dependencies.

Optional integrations (Maia-2 and Patricia) are not bundled. Their own licenses and model terms apply if installed. This file summarizes direct materials and does not replace the licenses or a review of transitive dependencies and redistribution obligations.
