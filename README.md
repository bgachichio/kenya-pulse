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
- **Daily notification** — optional. Pick a time of day and the days of the
  week in Settings; the app refreshes the readings and posts one notification
  carrying the briefing snapshot, at most once per day. Client-only by design
  (there is no push server): it fires while the app is open, or on the next
  open after the chosen time.
- **Device clock** — the header date and time come from the viewing device,
  with the feed's as-of date shown alongside as "readings to …".
- **Yours to tune** — theme (light/dark/system), text size, pinned indicators,
  and the withholding-tax assumptions the ladder is computed with. Everything
  persists in `localStorage` on the device; nothing is sent anywhere and no
  account exists.
- The feed URL is a hard-coded constant, not a setting. Users personalise the
  presentation; the data lane stays locked.

---

## Running it

Full step-by-step deployment, with expected output at every step, is in
[`DEPLOY.md`](DEPLOY.md). The short version:

**Collector** (on the VM):

```bash
pip3 install --user -r requirements.txt
python3 kenya_pulse.py --health   # every source reachable
python3 kenya_pulse.py --dry      # read the ladder before writing
python3 kenya_pulse.py            # write data.json live
```

**App** (build on a real machine — never on a 1 GB VM, it OOMs on install):

```bash
cd app && npm ci
npm run build
npx vercel --prod
```

## Tests

Nine suites, ~200 assertions, run against the component mounted under Node —
no browser needed: ladder arithmetic, feed merge, deep links, share,
persistence and schema versioning, storage failure modes, mobile layouts at
320/360/412 px, and an end-to-end pass against a live `data.json`.
See [`tests/README.md`](tests/README.md).

```bash
cd tests && npm ci
node verify.js && node e2e.js   # …and the rest
```

## Rolling back

- **Feed:** `cp public/data.json.last public/data.json` — under a second,
  Caddy serves whatever file is there.
- **App:** `npx vercel rollback` — instant and atomic.

## Privacy

Settings live on the device. No account, no analytics, no cookies, no data
leaves the browser. The only network calls are the static data feed and the
app's own assets.

---

<div align="center">

Made with ❤ by [Brian Gachichio](https://gachichio.org/kenya-pulse) · MIT

</div>
