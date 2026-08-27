# Tests

Thirteen suites, ~330 assertions.

```bash
npm install

# the app, mounted under Node — no browser
for f in verify persist storage2 mobile trends share v4 ui e2e notify; do node $f.js; done

# the service worker as built, with a mocked worker global
node sw_test.mjs

# real Chromium: registers the worker, delivers a push, reads it back
cd ../app && npm run build && cd ../tests && node push_browser.mjs

# the push server: due-time maths, the endpoint allowlist, VAPID signing
pip install -r ../requirements-push.txt && python3 push_test.py
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
| push_test | The server: due times across timezones and days, one send per day, the SSRF allowlist, dead-device pruning, real VAPID signing |

`live.json` is genuine collector output, used by `e2e.js` and `push_test.py`.

**What these cannot do.** Safari does not run on a build machine, so every iOS
claim here is Chromium's behaviour plus the specification. The iPhone checks in
`DEPLOY.md` Part C6 are done by hand on a device, and are the only evidence
that counts for iOS.
