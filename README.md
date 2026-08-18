<div align="center">

# Kenya Pulse

**A dipstick on the Kenyan economy, and a read on where money is being paid.**

Thirty-five indicators from six free sources. Three layers of signal.
One JSON file. No database, no API keys, no paid feeds.

`Python 3.11` · `React 18` · `Vite` · `MIT`

</div>

---

## What it does

Most macro dashboards show numbers. This one answers three questions in order.

| Layer | Question | Method |
|---|---|---|
| **Ladder** | Where is money actually being paid? | Every instrument, after Kenyan withholding tax, less inflation, ranked |
| **Chain** | What is coming but has not printed? | Policy rate to GDP across six links, each with its own lag |
| **Breaks** | What is mispriced? | Seven relationships with known ranges, flagged when they leave them |

A number alone is noise. A number against its own history is context. A number
against a relationship that has held for twenty years is a signal.

---

## Architecture

```
     cron: 1st & 16th, plus Saturdays
                  │
                  ▼
   CBK ──▶┌──────────────────────┐──▶ public/data.json    14 KB, served
   NSE ──▶│                      │──▶ public/spine.json   11 KB, served
  FRED ──▶│    kenya_pulse.py    │──▶ history.jsonl       934 bytes per run
   IMF ──▶│                      │──▶ Telegram            when something moves
    WB ──▶│  reconcile → score   │
manual ──▶│  ladder/chain/breaks │
          └──────────────────────┘
                  │
                  ▼
          Kenya Pulse PWA — installed on the phone, settings on the device
```

One script writes one file. The app reads it. Nothing else runs.

**Why no database.** Twenty-five years of history is 1.8 MB. Postgres to hold
1.8 MB buys a daemon, a port, a backup policy and an upgrade path in exchange for
nothing. A JSON file under git already has versioning, diffing and rollback.

---

## Sources

All verified reachable and parsing from a Debian 12 VM in `africa-south1`.

| Source | Provides | Key | Requests |
|---|---|:---:|:---:|
| **Central Bank of Kenya** | CBR, KESONIA, REPO, discount window, 91-day, inflation, lending, deposit, savings, official FX | no | 1 |
| **Nairobi Securities Exchange** | NASI, NSE 20 / 25, banking index, market cap | no | 1 |
| **FRED, St Louis Fed** | US Fed funds, US 10-year | no | 2 |
| **IMF DataMapper** | Kenya, world, Sub-Saharan Africa, US — history and forecasts to 2031 | no | 9 |
| **World Bank** | Annual spine from 2002 | no | 10 |
| **manual.json** | Stanbic PMI, longer bills, 10-year, NPLs, reserves, debt, your MMF rate | — | 0 |

Twenty-three requests for a full sweep, four for the fast one.

### Three findings worth keeping

**The CBK homepage carries a complete Key Rates block.** Ten policy and banking
rates plus official currency rates in a single request. That is why the Kenya
Bankers Association is absent — KBRR already sits in that block, and a second
site for a number you already hold is bloat wearing a suit.

**Header profiles are not cosmetic.** The HTML sites drop requests without a
browser user-agent. The IMF returns `403` *to* a browser user-agent and `200` to
a plain one. One profile everywhere kills half the sources silently. The
collector carries two and swaps on `403`.

**Primary sources beat republishers, and it is not close.** A third-party feed
was quoting the NSE 20 at 3,710 on a day the Exchange itself published 4,178.50.
The Exchange's own statistics table is cleaner, richer and correct.

### Deliberately excluded

| Not used | Why |
|---|---|
| AFX, mystocks | `503` from datacentre addresses; the NSE's own table is primary anyway |
| KNBS site | `503` to automation; CPI goes in the typed lane |
| AfDB portal | `403`, and adds nothing the World Bank and IMF do not cover for Kenya |
| Kenya Bankers Association | KBRR already sits in the CBK block |
| Trading Economics | JavaScript-rendered, paid above a low ceiling |

---

## The three layers

### 1 · Ladder

```
real = gross × (1 − withholding tax) − headline inflation
```

Withholding tax for resident individuals, per EY, Cliffe Dekker and FNJ:

| Instrument | WHT |
|---|---|
| Treasury bills, bank deposits, MMFs | 15% |
| Bonds of ten years or more | 10% |
| Infrastructure bonds | exempt |

One retail aggregator claims bills are exempt for individuals. No tax practice
corroborates it, so 15% is used and the claim is surfaced as a disagreement
rather than quietly resolved. All three rates are sliders in the app.

The ladder also reports the **cost of doing nothing** — the gap between the top
instrument and cash, in points and in shillings per million.

A worked example from a live run: the 10-year bond has the higher headline at
13.45%, but the infrastructure bond at 12.80% wins after tax. Exemption is worth
more than 65bp of coupon, and only the after-tax arithmetic shows it.

> Arithmetic on published rates. Not advice.

### 2 · Chain

```
policy ─0m─▶ overnight ─1m─▶ 91-day ─5m─▶ lending ─8m─▶ credit ─11m─▶ GDP
```

Each link is marked `moved`, `still` or `waiting`. A link that has not moved
while the one before it has is the part nobody has priced.

`waiting` means fewer than three logged readings — reported as waiting, not as
"has not moved". Dressing an absence of evidence as a signal is the easiest way
to make a dashboard lie.

### 3 · Breaks

| Relationship | Usual range |
|---|---|
| Bank margin over policy | 3.5 – 5.5 pp |
| 91-day over policy | −1.0 – 0.75 pp |
| Sovereign spread, Kenya less US 10-year | 7 – 11 pp |
| Real deposit rate | −1.0 – 2.0 pp |
| Credit intensity, credit ÷ GDP growth | 1.2 – 2.5× |
| Market cap to GDP | 15 – 30% |
| Overnight against policy | −0.5 – 0.5 pp |

---

## Reconciliation

Sources disagree. The collector never averages them: averaging two vintages
produces a third figure nobody published, worse than either.

Each indicator carries a ranked source list. **Whoever publishes a number
officially beats whoever republishes it.** National sources win on current
readings; multilaterals win on long history, because they rebase whole series
consistently where national releases do not.

The winner is kept, the loser recorded, and any gap beyond tolerance shown in the
app side by side with an explanation.

**Failure behaviour.** A source going down never blanks an indicator. The last
good reading is carried forward and labelled with its age. A gap in a chart is a
lie; a number marked "nine days old" is the truth. Staleness thresholds follow
each indicator's release cadence — five days for daily, forty-five for monthly.

---

## The app

React 18, single file, no backend.

**Tabs** — Pulse (indicators by group) · Edge (ladder, chain, breaks) · Trends
(2002–2025) · Outlook (IMF to 2031) · Data (sources, disagreements, storage,
briefing)

**Settings** — theme `dark / light / same as device` · text size `S M L XL` ·
feed URL · sync on open · three tax sliders · anomaly threshold · target bands ·
compact rows · four pinned indicators

### Storage

Settings live on the device. Three things make that reliable rather than hopeful:

- **Writes are verified.** Every write is read back to confirm it landed. Silent
  failure is what makes people distrust an app.
- **The schema is versioned.** A future change migrates rather than resetting.
- **The state is reportable.** A panel in the Data tab shows whether storage
  works, which address you are on, what is stored and how large.

That last one matters more than it sounds. Browser storage is **per origin**, so
an app served from two addresses keeps two separate sets of settings. A hosting
platform that issues a fresh URL per deploy will therefore look exactly like
broken persistence. The panel names the address, and warns when it detects a
one-off deployment address.

Writes are debounced by 250ms — dragging a slider fired thirty writes a second
before that. Backup and restore are both present: a backup you cannot restore is
not a backup.

### Mobile

The tab strip stays. Five views you switch between constantly should not cost an
extra tap and a hidden menu, so rather than hiding the navigation it was made to
fit. Labels size off the viewport with `clamp(11px, 3.3vw, 15px)`, so the text
size setting can never overflow the nav.

Measured against the worst label, *Outlook*:

| Viewport | Space per tab | Needed | Headroom |
|---|---|---|---|
| 320px | 58px | 47px | 11px |
| 360px | 66px | 50px | 16px |
| 412px (Pixel 9 Pro) | 77px | 57px | 20px |
| 768px | 146px | 65px | 81px |

Sparklines shrink 88px → 52px under 440px and disappear under 360px. Indicator
labels wrap rather than truncate. The pinned block drops to one column under
360px. The settings sheet respects `env(safe-area-inset-bottom)`.

**Accessibility** — `prefers-reduced-motion` honoured throughout, focus rings on
every control, `aria-expanded` on expanders, `role="switch"` on toggles, tabular
figures.

---

## Tests

```bash
cd tests
npm install
node harness.js && node verify.js && node persist.js && node storage2.js && node mobile.js
```

Seventy assertions across four suites, all passing.

| Suite | Covers |
|---|---|
| `verify.js` | Ladder arithmetic against hand-computed values, tax sliders recomputing and re-sorting, toggles, persistence |
| `persist.js` | Mount → change → unmount → remount with a surviving storage mock |
| `storage2.js` | Diagnostics panel, one-off-address detection, blocked storage, restore, schema stamping, debounce |
| `mobile.js` | Renders at 320 / 360 / 390 / 412 / 768px, tab geometry, narrow-mode adaptations, no fixed widths that overflow |

The component is mounted under `react-test-renderer` and every tab, button,
slider, toggle and expander is exercised.

---

## Footprint

Measured on the running VM, not estimated.

| | |
|---|---|
| One log record | 934 bytes |
| One year, 76 runs | 71 KB raw · 13 KB gzipped |
| Twenty-five years | 1.8 MB |
| `data.json` served | 14 KB |
| `spine.json` served | 11 KB, overwritten not appended |
| Full run | ~100 s, most of it waiting on the IMF |
| Fast run | ~7 s |
| Peak memory | under 100 MB |

Runs on a `e2-micro` with 1 GB of RAM alongside other services. A cron job, not a
daemon: no standing process, no port, nothing held between runs. `--compact`
gzips anything over two years into `archive/YYYY.jsonl.gz`.

The app must be built on a real machine — `npm install` will exhaust an
`e2-micro`.

---

## Install

```bash
git clone https://github.com/bgachichio/kenya-pulse.git
cd kenya-pulse

# collector
pip3 install --user --break-system-packages requests beautifulsoup4 lxml
# or on Debian:  sudo apt install python3-requests python3-bs4 python3-lxml
cp manual.example.json manual.json    # then fill in the typed figures
python3 kenya_pulse.py --health       # prove every source is reachable
python3 kenya_pulse.py --dry          # full run, writes nothing
python3 kenya_pulse.py                # writes public/data.json

# app
cd app && npm install && npm run dev
```

Full walkthrough in [DEPLOY.md](DEPLOY.md). Mobile and PWA notes in
[MOBILE-PWA.md](MOBILE-PWA.md).

### Commands

| | |
|---|---|
| `kenya_pulse.py` | full sweep |
| `kenya_pulse.py --fast` | rates, markets, currency only |
| `kenya_pulse.py --dry` | print, write nothing, send nothing |
| `kenya_pulse.py --health` | source reachability |
| `kenya_pulse.py --compact` | roll the log up |

### Environment

| Variable | Purpose | Default |
|---|---|---|
| `KP_TG_TOKEN` | Telegram bot token | none, alerts off |
| `KP_TG_CHAT` | Telegram chat id, numeric | none, alerts off |
| `KP_Z` | z-score anomaly threshold | `1.5` |

Put these at the **top of the crontab**, not only in `.bashrc`. Cron does not
read your shell profile, and this is the most common reason a job runs perfectly
and never alerts.

### Cron

```cron
KP_TG_TOKEN=...
KP_TG_CHAT=...
0 7 1,16 * *  cd ~/kenya-pulse && /usr/bin/python3 kenya_pulse.py >> run.log 2>&1
0 7 * * 6     cd ~/kenya-pulse && /usr/bin/python3 kenya_pulse.py --fast >> run.log 2>&1
0 4 1 1 *     cd ~/kenya-pulse && /usr/bin/python3 kenya_pulse.py --compact >> run.log 2>&1
```

### Serving the file

Caddy, four lines, placed **before** any catch-all `handle`:

```
handle /pulse/* {
    root * /home/YOU/kenya-pulse
    header Access-Control-Allow-Origin "*"
    file_server
}
```

Caddy appends the URL path to `root`, so symlink `public` to `pulse`:
`ln -sfn ~/kenya-pulse/public ~/kenya-pulse/pulse`.

The CORS header is what lets the app read the file from another domain. Without
it the browser fetches, discards, and the app silently sits on seeded figures
with no error to tell you why.

---

## The manual lane

Some numbers exist only inside a PDF. Rather than a scraper that rots without
telling you, type them. About a minute a month.

| Release | Publisher | When |
|---|---|---|
| CPI and inflation | KNBS | last working day, monthly |
| Stanbic PMI | S&P Global | first working day, monthly |
| MPC decision | CBK | every second month |
| Debt bulletin | National Treasury | mid-month |
| Quarterly GDP | KNBS | ~10 weeks after quarter end |
| WEO | IMF | April and October |

Every automated source fails quietly. A typed number fails loudly, because you
notice you did not type it. For a dozen figures a month, loud beats clever.

---

## Repository layout

```
kenya-pulse/
├── kenya_pulse.py          collector, one file
├── manual.example.json     template for the typed figures
├── app/
│   ├── src/App.jsx         the PWA
│   ├── vite.config.js      PWA manifest and caching
│   └── public/             icons
├── tests/                  four suites, seventy assertions
├── DEPLOY.md
├── MOBILE-PWA.md
└── README.md
```

Generated data — `public/data.json`, `history.jsonl`, `state.json`, `archive/` —
is not committed. It is output, not source.

---

## Design notes

**On the score.** The share of indicators moving the right way for the economy,
direction-weighted, scaled to 100. A thermometer, not a forecast. The arithmetic
fits in one line deliberately: any model you cannot explain in a sentence is one
you will stop trusting the first time it surprises you.

**On z-scores.** How far a reading sits from its own recent average, in standard
deviations. Above 1.5 it is flagged.

**On honesty.** Three choices define this project. Never average disagreeing
sources. Never blank an indicator when its source fails. Never report an absence
of evidence as a signal. Each makes the app say "I don't know" more often, and
each is why the answers it does give can be trusted.

---

## Licence

MIT.

Data belongs to its publishers: CBK, KNBS, NSE, the National Treasury, the World
Bank, the IMF and the Federal Reserve Bank of St Louis. This project reads public
figures and does arithmetic on them. It is not investment advice.

---

<div align="center">

Made with ❤️ by [Brian Gachichio](https://gachichio.org)

</div>
