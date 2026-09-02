<div align="center">

# Kenya Pulse

**A dipstick on the Kenyan economy, and a read on where money is being paid.**

Thirty published indicators from free sources. Three layers of signal.
One JSON file. No database, no accounts, no paid feeds.

`Python 3` · `React 19` · `Vite` · `PWA` · `MIT`

**Live app:** [kenyapulse.gachichio.org](https://kenyapulse.gachichio.org) ·
**Feed:** [gachichio.org/pulse/data.json](https://gachichio.org/pulse/data.json)

</div>

---

## What it does

Most macro dashboards show numbers. This one answers three questions in order.

| Layer | Question | Method |
|---|---|---|
| **Ladder** | Where is money actually being paid? | Every Kenyan instrument, after withholding tax, less inflation, ranked by **real** return |
| **Chain** | What is coming but has not printed? | Policy rate to GDP across five links, each with its own lag |
| **Breaks** | What is mispriced? | Long-held relationships (bank margin over policy, sovereign spread, real deposit rate…) flagged when they leave their range |

A number alone is noise. A number against its own history is context. A number
against a relationship that has held for twenty years is a signal.

There is deliberately **no composite score**. The headline is the most
actionable fact instead: the best real return available today, and what
standing still in cash costs against it.

---

## Architecture

```
     cron: 1st & 16th, plus a lighter Saturday pass
                  │
                  ▼
   CBK ──▶┌──────────────────────┐
   NSE ──▶│                      │──▶ public/data.json   one static file,
  FRED ──▶│    kenya_pulse.py    │        served by Caddy
   IMF ──▶│                      │──▶ Telegram alert when something moves
    WB ──▶│  reconcile → ladder  │        or a rate goes stale
manual ──▶│    chain · breaks    │
          └──────────────────────┘
                  │
                  ▼
     Kenya Pulse PWA — React + Vite, hosted on Vercel,
     installable on Android, iOS and desktop
```

One script writes one file. The app reads it. Nothing else runs.

**Why no database.** Twenty-five years of history is under 2 MB. Postgres to
hold 2 MB buys a daemon, a port, a backup policy and an upgrade path in
exchange for nothing. A JSON file under git already has versioning, diffing
and rollback.

---

## The collector — `kenya_pulse.py`

- Pulls its sources in one run (~40 s) and writes `public/data.json`.
- `--health` checks every source is reachable; `--dry` prints the full ladder,
  chain and relationships without writing anything.
- `manual.json` (copy `manual.example.json`) holds up to five typed figures —
  NPLs, reserves, import cover, debt/GDP, current account. All optional; each
  falls back to an annual source, relabelled where the measure differs.
- Where two sources disagree, **nothing is averaged**: one figure is kept, the
  other shown beside it in the app with the reason.
- If a source fails, the last good reading is carried forward and labelled
  with its age; stale rates surface in the app as an `OLD` badge.
- Dependencies pinned in `requirements.txt`; `gitleaks`, `ruff` and
  private-key detection run pre-commit (`.pre-commit-config.yaml`).

**Two sources for every Treasury bill.** CBK runs the auction, so
`src_cbk_bills` reads
[its results table](https://www.centralbank.go.ke/bills-bonds/treasury-bills/)
first; Serrari is the second opinion; a typed figure is the last resort. Each
rate carries the date of the auction it came from, so `--sources` can say a
figure is stale *at the publisher* rather than merely present. That distinction
exists because Serrari once served a 16 July auction into September without
anything noticing.

## The app — `app/`

A single-file React PWA (`app/src/App.jsx`).

- **Pulse** — every indicator in grouped lists, each expandable into
  plain-language *what it is / why it matters*, with sparklines and pinned
  favourites.
- **Edge** — an executive briefing (narrative call plus a five-line snapshot,
  one tap to copy), then the ladder, the transmission chain, and the breaks.
- **Trends** — 24 years of World Bank annual data, ten series, decade averages.
- **Outlook** — IMF projections to 2031, actuals separated from forecast.
- **Data** — sync controls, sources, disagreements, every reading in a table.
- **Share** — indicators, breaks and trends deep-link (`#pulse/cbr`,
  `#edge/…`, `#trends/…`) through the device's native share sheet, with a
  clipboard fallback on desktop.
- **Daily notification** — optional, and off unless asked for. Pick a time of
  day and the days of the week in Settings; one notification arrives at that
  time carrying the headline figures, **whether the app is open, backgrounded
  or closed**, because it is sent by the VM rather than scheduled in the page.
  Tapping it opens the app at the briefing. Works on Android and desktop
  Chrome, Edge and Firefox; on iPhone once the app is on the home screen, which
  the app explains rather than offering a toggle that cannot work.
  See [the push service](#the-push-service--push_serverpy).
- **Device clock** — the header date and time come from the viewing device,
  with the feed's as-of date shown alongside as "readings to …".
- **Yours to tune** — theme (light/dark/system), text size, pinned indicators,
  and the withholding-tax assumptions the ladder is computed with. All of it
  persists in `localStorage` on the device, and no account exists.
- The feed URL is a hard-coded constant, not a setting. Users personalise the
  presentation; the data lane stays locked.

**Design.** Every colour, size, radius and easing resolves to a token declared
in `app/src/index.css`; the component file holds no hex value and no `px` font
size. Light and dark are the same token names with different values, and the
class on `<html>` decides which is live. Conformance against `design.md` v1.1,
including the two exceptions taken and why, is written up in
[`DESIGN-COMPLIANCE.md`](DESIGN-COMPLIANCE.md) and enforced by `tests/ui.js`
and `tests/visual-check.mjs`.

---

## The push service — `push_server.py`

The one piece with a server behind it, and only because there is no other way:
a timer inside a web page stops when the page does, so a schedule that lives in
the browser can never reach a closed app. Web push can, and web push needs a
sender.

It runs on the same VM as the collector, in two modes — `--serve` for the small
API the app subscribes to (localhost only, Caddy publishes it at
`/pulse/push/`), and `--send-due` for the cron pass that does the sending.
Subscriptions live in a JSON file at mode 600; still no database.

- Each pass compares every subscription against **that device's own** local
  time, so a phone in London and one in Nairobi each get their own morning.
- One send per device per day. A briefing more than three hours late is
  dropped rather than buzzing at bedtime.
- A device that has uninstalled answers `410 Gone` and is removed on the spot.
- `/subscribe` accepts endpoints belonging to the four real push services only.
  Without that check the endpoint field would make this server a relay pointed
  at whatever an attacker named.
- The VAPID private key is generated on the VM by `--genkeys`, written at mode
  600 and read from the environment. It is not in this repository, and the
  command prints only the public half.
- `--why` explains, per device, whether it is due and if not why not;
  `--test-send` fires immediately without consuming the day's real send;
  `--forget` drops a device that re-registered and left an old address behind.

**What it costs.** One pass is ~300 ms and 49 MB, freed on exit; 288 passes a
day is 0.10% of one core. The store is a few hundred bytes per device, and the
log is written only when something is sent or fails. Nothing is held between
runs, and no database is involved — here or anywhere else in the project.

Setup, systemd unit, Caddy block and cron line: [`DEPLOY.md`](DEPLOY.md) Part C.

## Running it

Full step-by-step deployment, with expected output at every step, is in
[`DEPLOY.md`](DEPLOY.md). The short version:

**Collector** (on the VM):

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python kenya_pulse.py --health    # every source reachable
.venv/bin/python kenya_pulse.py --sources   # what each source actually parsed
.venv/bin/python kenya_pulse.py --dry       # read the ladder before writing
.venv/bin/python kenya_pulse.py             # write data.json live
```

**App** (build on a real machine — never on a 1 GB VM, it OOMs on install):

```bash
cd app && npm ci
npm run build
npx vercel --prod
```

## Tests

Eighteen suites, 654 assertions. Most run against the component mounted under
Node with no browser at all; the push work is checked three ways, because a
notification that fails silently is worse than none, and the design tokens are
read back out of a real browser rather than trusted.
See [`tests/README.md`](tests/README.md).

```bash
cd tests && npm ci
node verify.js && node notify.js          # …and the rest
node sw_test.mjs                          # the built worker, mocked globals
node push_browser.mjs                     # real Chromium, real push delivery
node visual-check.mjs                     # computed styles, light, dark, xlarge
node touch-check.mjs                      # a real finger, a real mouse, a keyboard
../.venv-push/bin/python push_test.py     # the server, timezones and all
python3 collector_test.py                 # the collector, no network needed
```

## Rolling back

- **Feed:** `cp public/data.json.last public/data.json` — under a second,
  Caddy serves whatever file is there.
- **App:** `npx vercel rollback` — instant and atomic.
- **Notifications:** `sudo systemctl stop kenya-pulse-push` — stops the
  reminders and touches nothing else.

## Privacy

No account, no analytics, no cookies. Settings — theme, text size, pins, tax
assumptions — stay in `localStorage` on the device and are never sent anywhere.

With notifications **off**, which is the default, the only network calls are
the static data feed and the app's own assets.

Turning notifications **on** necessarily sends something: the push endpoint the
browser mints for that device, the two keys that encrypt to it, the chosen time
and days, and the timezone name. That is what a reminder to a closed app costs,
and it is the whole of it — no account, no identifier, nothing naming the
person. Turning the toggle off deletes the record from the server and releases
the subscription in the browser.

---

<div align="center">

Made with ❤ by [Brian Gachichio](https://gachichio.org/kenya-pulse) · MIT

</div>
