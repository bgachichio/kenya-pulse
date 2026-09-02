# Tests

Eighteen suites, 568 assertions. All of them exit on their own; a
non-zero exit code means a failure.

```bash
npm install

# the app, mounted under Node — no browser
for f in verify persist storage2 mobile trends share v4 ui e2e notify \
         interact coherence; do node $f.js; done

# the service worker as built, with a mocked worker global
node sw_test.mjs

# real Chromium: registers the worker, delivers a push, reads it back
cd ../app && npm run build && cd ../tests && node push_browser.mjs

# design.md v1.1 conformance: renders the built app in Chromium and reads the
# computed styles back, in light, in dark and at the largest text size
cd ../app && npm run build && cd ../tests && node visual-check.mjs

# real touch and a real mouse, against a real event pipeline
node touch-check.mjs

# the push server: due-time maths, the endpoint allowlist, VAPID signing.
# requirements-test.txt holds the test-only extras, kept out of the deploy set.
python3 -m venv ../.venv-push
../.venv-push/bin/pip install -r ../requirements-push.txt -r requirements-test.txt
../.venv-push/bin/python push_test.py

# the collector's own arithmetic, no network and no dependencies
python3 collector_test.py
```

| Suite | Covers |
|---|---|
| verify | Ladder arithmetic against hand-computed values, tax sliders, persistence |
| persist | Mount → change → unmount → remount with surviving storage |
| storage2 | Diagnostics, blocked storage, schema stamping, debounce |
| mobile | 320 / 360 / 390 / 412 / 768px, tab geometry, no overflow |
| trends | Chart maths, decade averages, all ten series |
| share | Hard-coded feed, hidden settings row, no branding leaks |
| v4 | Plain language, deep links, staleness, break provenance |
| ui | Grouped-list structure, typography, motion, tap targets |
| e2e | The app against a real data.json the collector produced |
| notify | Subscribing, re-registering on a change, unsubscribing, a refused permission, an unreachable server, and what an iPhone in a Safari tab is told |
| sw_test | The built worker: push → notification, tap → focus or open, a malformed payload, an off-site link, subscription rotation |
| push_browser | Chromium end to end: the worker registers, a push delivered through DevTools raises the notification, the app still opens offline |
| interact | A tap and a click: the event sequence WebKit emits for one tap, the focus a tap leaves behind, the settings veil, and a static check that no click handler is hiding on a bare div |
| coherence | Whether the figure in a row agrees with the line beside it, and whether the line's shape survives collecting more often |
| touch-check | Real Chromium with a real finger: taps on the chart, the sheet, every tap target measured, and the same page driven with a mouse and a keyboard |
| collector_test | The collector with no network: level-collapsing, scoring, that a daily fast pass leaves the annual series intact, the 182-day bill's staleness rules, `--sources` run end to end against a deliberately broken scraper, and the cron block from `DEPLOY.md` executed against a stand-in crontab |
| visual-check | The built app in real Chromium: role tokens resolve, Courier Prime on the display sizes and Inter on the UI, the 20px card shape, dark surfaces, and the text-size toggle actually moving `rem` |
| push_test | The server: due times across timezones and days, one send per day, the SSRF allowlist, dead-device pruning, real VAPID signing |

The app keeps a 30-second clock interval. Each Node suite unrefs it in its
preamble so a finished run exits instead of idling on a live timer.

`live.json` is genuine collector output, used by `e2e.js` and `push_test.py`.

**What these cannot do.** Safari does not run on a build machine, so every iOS
claim here is Chromium's behaviour plus the specification. The iPhone checks in
`DEPLOY.md` Part C6 are done by hand on a device, and are the only evidence
that counts for iOS.
