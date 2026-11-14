# Opening catalog source

The five TSV files are from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings), pinned to commit `a6189a30dc273ccb21fc2536a9a2fefd5592a67a` (2026-10-06). The maintainers release this dataset under the [CC0 Public Domain Dedication](https://github.com/lichess-org/chess-openings/blob/master/COPYING.txt). Opening names and representative move sequences are catalog facts; the dataset does not define a complete parent tree or name every possible position.

Run `npm run book` to regenerate `public/openings.json` and the published-line fallback at `public/book.json` from these files.

The selector also includes one separately labeled London study setup defined in `src/openings.ts`. It illustrates the common d4/e3/c3 pawn triangle with Bf4, Bd3, Nf3, and Nbd2, as taught in this [Lichess London study](https://lichess.org/study/HObNeKJK/AZnj2zbU). Its particular Black replies are illustrative; it is not an additional official catalog record.
