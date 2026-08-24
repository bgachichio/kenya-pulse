# Tests

209 assertions, nine suites. Run from this folder:

    npm install
    for f in verify persist storage2 mobile trends share v4 ui e2e; do node $f.js; done

| Suite | Covers |
|---|---|
| verify | Ladder arithmetic against hand-computed values, tax sliders, persistence |
| persist | Mount → change → unmount → remount with surviving storage |
| storage2 | Diagnostics, blocked storage, restore, schema stamping, debounce |
| mobile | 320 / 360 / 390 / 412 / 768px, tab geometry, no overflow |
| trends | Chart maths, decade averages, ordinals, all ten series |
| share | Hard-coded feed, hidden settings row, no branding leaks |
| v4 | Plain language, deep links, staleness, break provenance |
| ui | Grouped-list structure, typography, motion, tap targets |
| e2e | The app against a real data.json the collector produced |

`live.json` is genuine collector output, used by `e2e.js`.
