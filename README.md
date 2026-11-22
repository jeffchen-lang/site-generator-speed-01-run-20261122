[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/jeffchen-lang/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/jeffchen-lang/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122

A faster drop-in for makefun-site 1.0.0: a static-site generator that answers
exactly as makefun-site does on every case, byte for byte, in less CPU time.

Entry for the [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122)
"Build a static site faster, 22 November 2026".

## What it does

`solve.js` exports `run(input)`, which builds one site's output tree from
`{ site, templates, files }`: front matter, permalinks, Markdown, collections,
tags, layouts (index / tag / tags pages) and `build-report.txt` — the same
pipeline as makefun-site 1.0.0, reimplemented for speed:

- Front matter and Markdown are scanned line by line without building token
  objects; inline rendering is a single pass where plain text is scanned by
  the regex engine and only constructs are handled in JavaScript.
- `slugify` takes an ASCII fast path (NFKD is the identity there); word
  counting is a table lookup over the exact `\s` set; link resolution has a
  fast path for plain names.
- Templates are parsed once per case and compiled to plain JavaScript
  functions (`new Function`), so rendering a page is straight-line code with
  inlined scope-chain lookups instead of a node-tree walk.

No dependencies, no I/O, no clock, no randomness: `run(input)` is a pure
function of its input.

## Layout

- `solve.js` — the entry (ES module, `run(input)`).
- `main.ts` — the harness driver (unchanged from the house baseline): reads
  `/input/cases.json`, answers each case with `run`, writes
  `/output/answers.json`.
- `package.json` — `{"type": "module"}`.

## Verification

On the kit's practice set (3 cases, 200–600 Markdown sources each) the entry
matches the reference output byte for byte (`grade-local`: 3/3 cases passed)
and runs about 3x faster than the house baseline in local interleaved
timing (median ~160 ms vs ~465 ms per 3-case set on this machine).
