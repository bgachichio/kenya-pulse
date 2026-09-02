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
ssh $K $V "cd ~/kenya-pulse && python3 -m venv .venv && \
           .venv/bin/pip install -q -r requirements.txt && \
           .venv/bin/python -c 'import requests,bs4,lxml; print(\"deps ok\")' && \
           wc -l kenya_pulse.py"
```

**You should see** `deps ok`, then the line count.

**A virtualenv, not `pip3 install --user`.** Debian 12 marks its system Python
externally managed, so `pip3 install --user` fails with
`error: externally-managed-environment` and installs nothing. The push service
already runs from `.venv-push` for the same reason; the collector gets `.venv`.

Everything below calls `~/kenya-pulse/.venv/bin/python`, never a bare
`python3`, so cron and your shell run the same interpreter with the same
packages.

Unpinned installs were a G3 auto-fail. `requirements.txt` fixes that.

## A2 · Your typed figures

```bash
ssh $K $V "cp ~/kenya-pulse/manual.example.json ~/kenya-pulse/manual.json && nano ~/kenya-pulse/manual.json"
```

Five keys: `npl`, `reserves`, `cover`, `debt_gdp`, `cab`. Correct the values and
dates. All five are optional — leave the file empty and each falls back to an
annual source, relabelled where the measure differs.

## A3 · Check every source

Two checks, and the second is the one that matters.

```bash
ssh $K $V "cd ~/kenya-pulse && .venv/bin/python kenya_pulse.py --health"
```

**You should see** `10 of 10 reachable`. Eight is enough to proceed.

`--health` only asks whether a site answers. A site can answer perfectly while
its markup has moved, in which case the scraper returns nothing, the last good
figure is carried forward, and the app shows a stale rate wearing a fresh date.
That is the failure nobody notices. So also run:

```bash
ssh $K $V "cd ~/kenya-pulse && .venv/bin/python kenya_pulse.py --sources"
```

**You should see** a row per source with the keys it actually parsed, then a row
per indicator naming where its figure came from. What to look for:

| In the output | What it means | What to do |
|---|---|---|
| `serrari bills   0  (none)  <- returned nothing` | the auction table moved | fix `src_serrari_bills`, or type the rate into the sheet |
| `tbill182 ... <- fell back` | the live source failed, a typed figure is standing in | same |
| `tbill182 ... <- MISSING` | no source and no typed figure | type one |
| every indicator named against its live source | working | nothing |

This is the command to run first when a rate looks frozen.

## A4 · Dry run — read the ladder before writing anything

```bash
ssh $K $V "cd ~/kenya-pulse && .venv/bin/python kenya_pulse.py --dry" | tail -40
```

**You should see** ten rungs, infrastructure bonds at the top near **11.77%**, a
five-link chain, six relationships, and **no `STALE RATES`**.

If those rates look wrong, a source has changed shape. Stop.

## A5 · Write it live

```bash
ssh $K $V "cd ~/kenya-pulse && .venv/bin/python kenya_pulse.py"
curl -s https://gachichio.org/pulse/data.json | head -c 60; echo
```

**You should see** ~40 seconds, then JSON beginning `{"asOf":"2026-`.

## A6 · Put it on a schedule

The collector had no documented schedule, which is why rates could sit
unchanged for a fortnight: nothing was running.

**Cron runs on the machine's clock, not on UTC.** So the timezone is pinned in
the crontab rather than assumed, and the times below are Nairobi times.

```bash
ssh $K $V "crontab -l 2>/dev/null | grep -Ev 'kenya_pulse\.py|^CRON_TZ=' | {
  cat
  echo 'CRON_TZ=Africa/Nairobi'
  echo '20 18 * * *  cd ~/kenya-pulse && .venv/bin/python kenya_pulse.py --fast >> ~/collect.log 2>&1'
  echo '40 18 * * 1  cd ~/kenya-pulse && .venv/bin/python kenya_pulse.py       >> ~/collect.log 2>&1'
  echo '5   3 1 * *  cd ~/kenya-pulse && .venv/bin/python kenya_pulse.py --compact >> ~/collect.log 2>&1'
} | crontab -"
```

- **Daily, 18:20 Nairobi**, `--fast`: rates, markets and currency, about 15
  seconds. Evening rather than morning so the day's CBK and NSE figures are
  already published when it runs.
- **Mondays, 18:40 Nairobi**, the full sweep: adds the IMF and World Bank
  series and the long history. About 3 minutes.
- **1st of the month, 03:05**, `--compact`: rolls history older than two years
  into gzipped archives.

Odd minutes, so this never lines up with the push sender on `*/5`.

`CRON_TZ` goes **after** the existing entries, not before them. A cron
environment line applies to every line below it, so putting it at the top would
have quietly re-timed whatever else is in there — certbot at `0 2 * * *` would
have moved by three hours. Placed last, it governs the three collector lines
and nothing else.

The `grep -Ev` makes it safe to run twice: it strips any previous collector
lines and `CRON_TZ` before re-adding them, and leaves everything else — the
push sender, certbot — untouched. Tested against an empty crontab, a populated
one, and three consecutive applications.

### Stop the log growing for ever

`collect.log` gains about 2.5 KB a run, so roughly **1 MB a year** with nothing
to bound it. `push.log` has the same problem. One rotation covers both:

```bash
ssh $K $V "sudo tee /etc/logrotate.d/kenya-pulse > /dev/null" <<'CONF'
/home/bgkaranja/collect.log /home/bgkaranja/push.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
CONF
ssh $K $V "sudo logrotate -d /etc/logrotate.d/kenya-pulse 2>&1 | tail -5"
```

**You should see** logrotate's dry run naming both files and no error. A month
of logs, compressed, then discarded.

### What it costs

| | |
|---|---|
| History rows | 1.1 KB each · 417 runs a year · **436 KB a year** |
| Older than two years | archived gzipped by `--compact` |
| `data.json` | 16 KB, overwritten each run, never appended |
| `collect.log` | ~2.5 KB a run, held to four compressed weeks |
| Memory | one Python process, 15 seconds a day and 3 minutes a week |
| Supabase | untouched |

### Why collecting more often does not spoil the charts

History is one row per run, so a monthly figure sampled daily would have drawn
two dozen identical points — a flat line about a series that moves every month.
The collector now stores the levels a figure has taken rather than the times it
was looked at, so a sparkline reads the same whatever the schedule.

The mixed schedule is safe for the slow series too. A `--fast` row simply omits
the indicators it does not collect, and `score()` skips absent keys rather than
reading them as gaps, so an annual figure's history and its prior are built
only from the full runs that actually carry it. Checked in
`tests/collector_test.py`.

### Confirm it took

```bash
ssh $K $V "date; crontab -l | grep -E 'CRON_TZ|kenya_pulse'"
```

**You should see** `CRON_TZ=Africa/Nairobi` and the three lines. `date` tells
you the machine's own clock, which is what cron would have used without that
first line.

Then wait for the next daily pass, or force one now:

```bash
ssh $K $V "cd ~/kenya-pulse && .venv/bin/python kenya_pulse.py --fast" | tail -5
ssh $K $V "tail -5 ~/collect.log"
```

If `crontab -` rejects `CRON_TZ=` — some very old cron builds do — drop that
line and read the times as the machine's local clock, which `date` prints.

## A7 · Rollback, tested not assumed

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

# PART C · The daily notification

New in this version, and the only part of Kenya Pulse with a server behind it.

**Why.** A timer inside the page only runs while the page is open, which is the
one moment a reminder is worthless. Web push is the only way a browser hears
anything while it is closed, and web push needs a sender. `push_server.py` is
that sender: an API the app subscribes to, and a cron pass that does the
sending. It runs beside the collector on the same VM.

**What a device hands over:** the push endpoint the browser mints, the two keys
that encrypt to it, a time, a set of days, and a timezone name. No account, no
identifier, nothing naming the person. Switching the toggle off deletes the
record at both ends.

## C1 · Ship the files

Take the files from a clean checkout rather than a download folder — there is
no ambiguity about which version you are shipping.

Keep the checkout somewhere that survives a reboot — `/tmp` is cleared, and a
missing clone makes every `scp` below fail silently enough to be confusing.

```bash
SRC=~/kenya-pulse-src
[ -d $SRC ] && git -C $SRC pull -q || git clone --depth 1 https://github.com/bgachichio/kenya-pulse $SRC

V="bgkaranja@34.35.177.164"; K="-i $HOME/.ssh/gcp_pulse"
scp $K $SRC/push_server.py $SRC/requirements-push.txt $V:~/kenya-pulse/
ssh $K $V "ls -l ~/kenya-pulse/push_server.py"
```

**You should see** the file listed on the VM. If `scp` says *No such file or
directory*, the clone did not happen — nothing below will work.

Debian 12 refuses system-wide `pip install` (PEP 668, "externally-managed
environment"), so the service gets its own virtual environment. This keeps the
push dependencies away from the collector's, which is worth having anyway.

```bash
ssh $K $V "sudo apt-get install -y python3-venv"
ssh $K $V "cd ~/kenya-pulse && python3 -m venv .venv-push \
  && .venv-push/bin/pip install -q -r requirements-push.txt \
  && .venv-push/bin/python -c 'import fastapi, pywebpush; print(\"deps ok\")'"
```

**You should see** `deps ok`.

## C2 · Make the keys — once, and never in the repo

VAPID is how a push service knows the sender is you. The private half is a
credential: it never enters source, a prompt, or a screenshot.

```bash
ssh $K $V "cd ~/kenya-pulse && .venv-push/bin/python push_server.py --genkeys ~/secrets/kenya-pulse-push.env"
```

**You should see** one line: `Wrote /home/…/secrets/kenya-pulse-push.env (mode
600)` and the **public** key. Only the public half is ever printed — the app
fetches it at runtime, so nothing needs rebuilding when it rotates.

Edit `KP_VAPID_SUBJECT` in that file if you want a different contact address;
push services use it to reach you when something is wrong.

## C3 · Run the API under systemd

```bash
ssh $K $V "sudo tee /etc/systemd/system/kenya-pulse-push.service > /dev/null" <<'UNIT'
[Unit]
Description=Kenya Pulse push API
After=network-online.target

[Service]
User=bgkaranja
WorkingDirectory=/home/bgkaranja/kenya-pulse
EnvironmentFile=/home/bgkaranja/secrets/kenya-pulse-push.env
ExecStart=/home/bgkaranja/kenya-pulse/.venv-push/bin/python push_server.py --serve --port 8100
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/bgkaranja/kenya-pulse
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
UNIT

ssh $K $V "sudo systemctl daemon-reload && sudo systemctl enable --now kenya-pulse-push"
ssh $K $V "curl -s http://127.0.0.1:8100/health"
```

**You should see** `{"ok":true,"subscriptions":0}`.

If systemd reports *failed because of unavailable resources or another system
error*, it could not find something the unit names — almost always the env file
from C2 or the venv from C1. `systemctl status kenya-pulse-push -l` names it.

It binds `127.0.0.1` only. Caddy is the single thing on this box that faces the
internet — check with `sudo ss -tulpn | grep 8100` and expect `127.0.0.1:8100`.

## C4 · Publish it through Caddy

This goes **inside the `gachichio.org { … }` block of
`/etc/caddy/Caddyfile`** — it is configuration, not a shell command.
`handle_path` strips the prefix on the way through, so the service sees
`/health` rather than `/pulse/push/health`.

```caddy
	handle_path /pulse/push/* {
		reverse_proxy 127.0.0.1:8100
	}
```

Edit it with `sudo nano /etc/caddy/Caddyfile`, or insert it in place — the
validate step below is what makes either safe:

```bash
ssh $K $V "sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak"
ssh $K $V "sudo python3 /dev/stdin" <<'EDIT'
import re, pathlib, sys
p = pathlib.Path("/etc/caddy/Caddyfile"); s = p.read_text()
if "8100" in s:
    sys.exit("already routed")
m = re.search(r"^\s*gachichio\.org[^\n{]*\{[^\n]*$", s, re.M)
if not m:
    sys.exit("could not find the gachichio.org site block — edit by hand")
p.write_text(s[:m.end()] + "\n\thandle_path /pulse/push/* {\n\t\treverse_proxy 127.0.0.1:8100\n\t}\n" + s[m.end():])
print("inserted")
EDIT
```

If `caddy validate` fails, put the backup back before reloading anything:
`sudo cp /etc/caddy/Caddyfile.bak /etc/caddy/Caddyfile`. Caddy serves
gachichio.org, the data feed and this service, so it is the one file on the box
worth backing up before touching.

```bash
ssh $K $V "sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"
curl -s https://gachichio.org/pulse/push/health
```

**You should see** the same `{"ok":true,…}`, now over TLS.

## C5 · Send on a schedule

```bash
ssh $K $V "crontab -l | { cat; echo '*/5 * * * * cd ~/kenya-pulse && set -a && . ~/secrets/kenya-pulse-push.env && set +a && ~/kenya-pulse/.venv-push/bin/python push_server.py --send-due >> ~/push.log 2>&1'; } | crontab -"
```

Every five minutes it checks each subscription against **that device's own**
local time and sends only where the chosen minute has arrived. Five rather than
fifteen because the gap is how late a briefing can be: a run every quarter hour
means a 08:00 notification can arrive at 08:14, which reads as broken. A device is sent
to at most once a day. A briefing more than three hours late is dropped rather
than buzzing a phone at bedtime about this morning.

```bash
ssh $K $V "cd ~/kenya-pulse && set -a && . ~/secrets/kenya-pulse-push.env && set +a && .venv-push/bin/python push_server.py --send-due"
```

**You should see** `{"sent": 0, "failed": 0, "dropped": 0, "skipped": 0}` before
anyone has subscribed.

## C6 · Prove it on a real phone

The one part no test on a build machine can do, and the only evidence that the
whole chain — device, Google or Apple, this VM — actually carries a message.
`--test-send` fires immediately, ignoring the schedule, and deliberately does
not consume the day's real send:

```bash
ssh $K $V "cd ~/kenya-pulse && set -a && . ~/secrets/kenya-pulse-push.env && set +a && .venv-push/bin/python push_server.py --test-send"
```

Ten minutes, both handsets.

**Android (Pixel, Chrome):**

| Step | Expect |
|---|---|
| Open the app, Settings → Daily briefing → on | The browser asks; allow it |
| | The line "Scheduled. It arrives whether the app is open or not." |
| `ssh $V "cd ~/kenya-pulse && .venv-push/bin/python push_server.py --list"` | one subscription, your time and days |
| Set the time to two minutes ahead, **close the app entirely** (swipe it away) | |
| Wait for the cron pass, or run `--send-due` by hand | The notification arrives with the app closed |
| Tap it | The app opens on the **Edge** tab, at the briefing |
| Toggle off, then `--list` | zero subscriptions |

**iPhone (Safari, iOS 16.4 or newer):**

| Step | Expect |
|---|---|
| Open the app in Safari, Settings → Daily notification | "Add Kenya Pulse to your home screen first" |
| Share → **Add to Home Screen**, then open it from the icon | The toggle now appears |
| Turn it on | iOS asks; allow it |
| Set a time two minutes ahead and **close the app** | |
| Run `--send-due` | The notification arrives |
| Tap it | The installed app opens on the briefing |

iOS delivers web push **only** to a home-screen app — in a Safari tab there is
no push at all, which is why the app says so rather than offering a toggle that
could not work. iOS may also delay a push by a few minutes when the phone is
idle; that is Apple's power management, not the schedule.

## C7 · Rollback

The push service is separate from the app and the feed. Stopping it stops
notifications and nothing else:

```bash
ssh $K $V "sudo systemctl stop kenya-pulse-push"     # API down, app unaffected
ssh $K $V "crontab -l | grep -v send-due | crontab -" # stop sending
```

Subscriptions survive in `~/kenya-pulse/push-subscriptions.json` (mode 600).
Deleting that file unsubscribes everyone; they would each have to switch the
toggle on again.

## C8 · Starting the schedule afresh

To clear every stored schedule and begin again — the store is one file, so
this is one command:

```bash
ssh $K $V "cd ~/kenya-pulse && .venv-push/bin/python push_server.py --forget ''"
ssh $K $V "cd ~/kenya-pulse && .venv-push/bin/python push_server.py --why"
```

`--forget ''` matches every endpoint. Expect `Nothing is subscribed`. Each
device then switches its toggle off and on again to re-register; nothing else
is needed, and no key changes.

To drop one device rather than all, give it a fragment of its endpoint from
`--why`:

```bash
ssh $K $V "cd ~/kenya-pulse && .venv-push/bin/python push_server.py --forget 5Xc_15p2"
```

## C9 · What it costs

Measured, not estimated:

| | |
|---|---|
| One `--send-due` pass | ~300 ms, 49 MB peak, freed on exit |
| 288 passes a day (`*/5`) | ~86 s of CPU — 0.10% of one core |
| The API under systemd | one idle uvicorn worker, resident |
| `push-subscriptions.json` | a few hundred bytes per device |
| `push.log` | only written when something is sent or fails |

The sender is a process that starts, reads a small file and exits — it holds
nothing between runs. The log stays quiet deliberately: a line every five
minutes saying "nothing happened" is a file that grows for ever and tells you
nothing, so `--send-due` prints only when it sent, failed or dropped. Ask
`--why` for the current state instead.

## C8 · Living with it

```bash
ssh $K $V "cd ~/kenya-pulse && .venv-push/bin/python push_server.py --list"      # who is subscribed, and when
ssh $K $V "tail -20 ~/push.log"                # what each pass did
```

A device that has uninstalled the app answers `410 Gone`; the sender drops it on
the spot. Three failures of any other kind drop it too. The store needs no
tending.

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
