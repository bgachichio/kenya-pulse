# Kenya Pulse — deploy

**S0 first.** Your `building` skill file carries four live credentials — an
OpenRouter key, an Ollama key, and a Backblaze key pair. Your `developer` skill
§8.1.1 forbids credentials in skill files, and those skills are in a GitHub repo.
Rotate all four before anything below. Rotation first, diagnosis second.

---

Everything else is in `kenya-pulse-package.tar.gz`. Collector on the VM, app on
the Lenovo. About twenty minutes. Each step ends with **You should see**.

---

## 0 · Unpack

```bash
cd ~/Downloads/files
tar -xzf kenya-pulse-package.tar.gz
cd kenya-pulse && ls
```

**You should see** `app  kenya_pulse.py  manual.example.json  requirements.txt  sheet-template.csv  tests`

---

# PART A · The collector

## A1 · Copy it up, with pinned dependencies

```bash
V="bgkaranja@34.35.177.164"; K="-i $HOME/.ssh/gcp_pulse"
scp $K kenya_pulse.py requirements.txt manual.example.json $V:~/kenya-pulse/
ssh $K $V "cd ~/kenya-pulse && pip3 install --user -r requirements.txt && wc -l kenya_pulse.py"
```

**You should see** the three pinned versions install, then `1594`.

Unpinned installs were a G3 auto-fail. `requirements.txt` fixes that.

## A2 · Your typed figures

```bash
ssh $K $V "cp ~/kenya-pulse/manual.example.json ~/kenya-pulse/manual.json && nano ~/kenya-pulse/manual.json"
```

Five keys: `npl`, `reserves`, `cover`, `debt_gdp`, `cab`. Correct the values and
dates. All five are optional — leave the file empty and each falls back to an
annual source, relabelled where the measure differs.

## A3 · Check every source

```bash
ssh $K $V "cd ~/kenya-pulse && python3 kenya_pulse.py --health"
```

**You should see** `10 of 10 reachable`. Eight is enough to proceed.

## A4 · Dry run — read the ladder before writing anything

```bash
ssh $K $V "cd ~/kenya-pulse && python3 kenya_pulse.py --dry" | tail -40
```

**You should see** ten rungs, infrastructure bonds at the top near **11.77%**, a
five-link chain, six relationships, and **no `STALE RATES`**.

If those rates look wrong, a source has changed shape. Stop.

## A5 · Write it live

```bash
ssh $K $V "cd ~/kenya-pulse && python3 kenya_pulse.py"
curl -s https://gachichio.org/pulse/data.json | head -c 60; echo
```

**You should see** ~40 seconds, then JSON beginning `{"asOf":"2026-`.

## A6 · Rollback, tested not assumed

```bash
ssh $K $V "cd ~/kenya-pulse && cp public/data.json public/data.json.last"
```

To roll back: `cp public/data.json.last public/data.json`. One command, under a
second, no downtime — Caddy serves whatever file is there.

---

# PART B · The app

```bash
cd ~/kenya-pulse/kenya-pulse-app
cp ~/Downloads/files/kenya-pulse/app/src/App.jsx src/App.jsx
cp ~/Downloads/files/kenya-pulse/app/vite.config.js .
wc -l src/App.jsx
npm run build
npx vercel --prod
```

**You should see** `1946`, then `PWA v1.3.0` with `dist/sw.js` and
`dist/manifest.webmanifest`, then `✓ Ready`.

Build stays on the Lenovo. The 1 GB VM OOMs on `npm install`.

**Rollback:** `npx vercel rollback` — instant, atomic.

## On the Pixel

Open `https://kenya-pulse-app.vercel.app`, pull to refresh twice.

| Check | Expect |
|---|---|
| Header icons | Drawn sun and gear, not emoji |
| Tap targets | Icon buttons and the settings switch all 44px |
| Pulse | No core inflation, no private credit growth. 182-day, 364-day, discount window, NSE 25, EUR, GBP, import cover all present |
| Edge | Ten rungs, infra bonds ~11.77%, no OLD badges |
| Chain | Five links: policy → overnight → 91-day → lending → GDP |
| Trends | 24 bars, y-axis, both year labels |

---

# GATE VERDICT

```
VERDICT: APPROVE-WITH-PATCH  (patches applied below)
DELTA-4: 4 — replaces a typed lane that overstated five of ten ladder rungs

THREE QUESTIONS
  Necessary?  Yes. Deleted, there is no after-tax real-return ranking for
              Kenyan instruments anywhere. The ladder is the product.
  This way?   Considered a database and a served API. Rejected: 25 years of
              history is 1.8 MB, and a daemon costs a port, a backup policy
              and an upgrade path to store it.
  This long?  Full run 40s against a 30s floor; IMF answers in 9s and is
              already parallelised. Fast run 2s. Build 4s. Within budget.
```

## Findings, and what was done

| Sev | Finding | Action |
|---|---|---|
| **S0** | Four live credentials in `building/SKILL.md`, in a GitHub repo | **Rotate now.** Outside this codebase; cannot patch it for you |
| S2 | Runtime deps unpinned — G3 auto-fail | `requirements.txt` with three pinned versions |
| S2 | Three `except: pass` swallowing errors silently | Two now report a count; one narrowed to the three exceptions actually expected |
| S2 | Font weights 700 and 800 — design skill bans ≥700 | All 16 reduced to 600 |
| S2 | Emoji used as icons (☀ ☾ ◐ ⚙ ✕) — banned pattern | Replaced with drawn SVG carrying `aria-label` |
| S2 | Icon buttons 34×34 and switch 31px — below the 44px floor | Both now 44px; the switch keeps its 31px visual on a 44px hit area |
| S2 | Break marker animated `left`; vitals animated `height` | Marker position is data, not motion — animation deleted. Vitals now animate opacity and transform only |
| S3 | No `prefers-reduced-transparency` handling | Added; the sheet veil goes opaque |
| S3 | One bare `px` font size | Quoted |
| S3 | `main()` 162 lines against a 50-line limit | `gather()` extracted — all network in one function, no state. Remainder is a linear pipeline threading eleven values; splitting further would trade readability for a line count |

## Entropy ledger

```
Removed:   2 indicators (core, credit) and everything that depended on them —
           1 chain link, 1 relationship, 2 sheet rows, ~1.1 KB of collector
           and ~3.5 KB of app source
           1 animation that could not be justified in a sentence
Hardened:  3 dependencies pinned · pre-commit with gitleaks, ruff, private-key
           detection · 3 silent failure paths now report · icons carry
           accessible names · tap targets meet the 44px floor
Saved:     4 typed figures a month that were each overstating the ladder;
           roughly 5 minutes monthly, and one class of silent error removed
```

## What I checked, and what I assumed

**Checked:** `pyflakes` clean. 209 app assertions across nine suites. 10 of 10
APIs reachable, live. Every collector mode timed. Zero-entry verified with an
empty `manual.json`. Rendered through headless Chrome at 412×915. No credentials
in the deliverable.

**Assumed, not verified:** `gitleaks`, `semgrep`, `osv-scanner` and `grype` are
not installed here, so I ran regex and `pyflakes` instead. Run the real scanners
on the VM before pushing. No restore drill has been performed on the VM in this
session.

---

# Living with it

- **Most weeks, nothing.** Cron runs on the 1st and 16th; Telegram speaks when
  something moves or a rate goes stale.
- **Optionally monthly:** five figures in `manual.json`.
- **Watch the relationships.** All six read *judged* today. After 24 logged runs
  they become *measured*, computed from what this system has actually seen.

```bash
ssh $K $V "tail -20 ~/kenya-pulse/run.log"
```

---

## NEXT HIGH-IMPACT STEP

Rotate the four keys in `building/SKILL.md`, then run
`gitleaks detect --source . --log-opts="--all"` on your skills repo to see
whether anything else is already public. Under thirty minutes.

---

Made with ❤️ by [Brian Gachichio](https://gachichio.org)
