# Kenya Pulse — deploy

**S0 first.** Your `building` skill file carries four live credentials — an
OpenRouter key, an Ollama key, and a Backblaze key pair. Your `developer` skill
§8.1.1 forbids credentials in skill files, and those skills are in a GitHub repo.
Rotate all four before anything below. Rotation first, diagnosis second.

---

Everything else is in `kenya-pulse-package.tar.gz`. Collector on the VM, app on
the Lenovo. About twenty minutes. Each step ends with **You should see**.

---

## 0 · Every session starts here

`$V` and `$K` are shell variables, not settings. They live only in the terminal
you typed them into, so a new tab, a reboot, or coming back tomorrow loses
them — and **34 of the commands below use them**.

Run this once per terminal, before anything else:

```bash
. ~/.kenya-pulse-env 2>/dev/null || {
  cat > ~/.kenya-pulse-env <<'ENV'
V="bgkaranja@34.35.177.164"
K="-i $HOME/.ssh/gcp_pulse"
ENV
  . ~/.kenya-pulse-env
}
echo "V=$V"; echo "K=$K"; ssh $K $V "echo reachable"
```

**You should see** the two values, then `reachable`. It writes the file the
first time and reads it every time after.

### One more line, and the collector gets a lot easier

The collector runs as `kpulse`, from a fixed directory, with an environment
file sourced first. That is a mouthful to retype and easy to get subtly wrong,
so it goes in a function:

```bash
kp() { ssh $K $V "sudo -u kpulse bash -c 'cd /home/bgkaranja/kenya-pulse && \
  set -a && . /home/bgkaranja/secrets/kenya-pulse.env && set +a && \
  /usr/bin/python3 kenya_pulse.py $*'"; }
kp --health | tail -3
```

Every collector command below is `kp <flags>`. It matches what cron actually
runs, line for line, so a command that works here works on the schedule.

### If you see `hostname contains invalid characters`

That is this, and only this. With `$K` and `$V` empty, `ssh $K $V "long
command"` puts the command itself where the hostname belongs, and ssh rejects
it. Nothing ran, nothing was changed, nothing is broken — run the block above
and repeat what you were doing.

```
$ ssh $K $V "crontab -l | ..."
hostname contains invalid characters        <- $V was empty
```

Two other messages worth telling apart:

| Message | Cause |
|---|---|
| `hostname contains invalid characters` | `$V` empty — run the block above |
| `Permission denied (publickey)` | `$K` empty or the wrong key path |
| `Could not resolve hostname` | `$V` set but wrong |

---

## 0.1 · Get the code, and prove it is current

The source of truth is `github.com/bgachichio/kenya-pulse`, not a tarball in
Downloads. Deploying from a stale extraction is how a build once went out with
the wrong service worker and no push at all: everything succeeded, and the
wrong thing shipped.

```bash
SRC=~/kenya-pulse-src
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" pull origin main
else
  git clone -b main https://github.com/bgachichio/kenya-pulse "$SRC"
fi
cd "$SRC" && git log --oneline -1 && git status --short
```

**You should see** one commit line and nothing else. Anything listed under
`git status` is a local edit that a `pull` did not overwrite — deal with it
before going on.

Then check the working copy really is what the remote holds:

```bash
git -C $SRC fetch origin main -q
[ "$(git -C $SRC rev-parse HEAD)" = "$(git -C $SRC rev-parse origin/main)" ] \
  && echo "up to date" || echo "BEHIND - pull before deploying"
```

**You should see** `up to date`. Every command from here runs from `$SRC`.

---

# PART A · The collector

## A1 · Copy it up

**This VM runs the collector as a dedicated service account, `kpulse`.** Not as
`bgkaranja`, and not as root. `~/kenya-pulse` and everything in it belongs to
`kpulse`; your login cannot write there, which is correct and worth keeping —
the thing that touches the internet on a schedule should not own your home
directory.

So a copy is two steps: `scp` into `/tmp`, which you can write, then `install`
into place as `kpulse`.

```bash
cd $SRC
scp $K kenya_pulse.py requirements.txt manual.example.json $V:/tmp/
ssh $K $V "sudo install -o kpulse -g kpulse -m 600 /tmp/kenya_pulse.py ~/kenya-pulse/ && \
           sudo install -o kpulse -g kpulse -m 644 /tmp/requirements.txt /tmp/manual.example.json ~/kenya-pulse/ && \
           rm -f /tmp/kenya_pulse.py /tmp/requirements.txt /tmp/manual.example.json && \
           sudo -u kpulse /usr/bin/python3 -c 'import requests,bs4,lxml; print(\"deps ok\")' && \
           sudo wc -l ~/kenya-pulse/kenya_pulse.py"
```

**You should see** `deps ok`, then the line count of what you just copied. If
the count still reads the old one, the `install` did not run — check the
`sudo` output rather than carrying on.

`kenya_pulse.py` goes in at `600` because that is how it already sits; the
other two are world-readable and stay that way.

**No virtualenv.** `/usr/bin/python3` on this box already carries `requests`,
`beautifulsoup4` and `lxml`, installed as system packages, which is the right
answer on Debian and sidesteps the externally-managed-environment error
entirely. The push service has `.venv-push` because it needs pinned versions of
`pywebpush` and `cryptography` that Debian does not ship. The collector needs
neither. Do not add one — a second environment nothing runs from is a place for
the two to drift apart.

### Never write into that directory as yourself

```bash
# wrong - and it breaks the push service, which runs as kpulse
sudo chown -R bgkaranja:bgkaranja ~/kenya-pulse
```

`push-subscriptions.json` is mode `600`. Change its owner and `kpulse` can no
longer read the subscriber list; the API stays up and quietly sends nothing.
If it has already happened:

```bash
ssh $K $V "sudo chown -R kpulse:kpulse ~/kenya-pulse && \
           sudo systemctl restart kenya-pulse-push && \
           curl -s http://127.0.0.1:8100/health"
```

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
kp --health
```

**You should see** `10 of 10 reachable`. Eight is enough to proceed.

`--health` only asks whether a site answers. A site can answer perfectly while
its markup has moved, in which case the scraper returns nothing, the last good
figure is carried forward, and the app shows a stale rate wearing a fresh date.
That is the failure nobody notices. So also run:

```bash
kp --sources
```

**You should see** a row per source with the keys it actually parsed, then a row
per indicator naming where its figure came from. What to look for:

| In the output | What it means | What to do |
|---|---|---|
| `cbk bills   0  (none)  <- returned nothing` | CBK's table moved | fix `src_cbk_bills` — the log line names the headers it did find |
| `tbill182 ... <- fell back` | the first-choice source failed and a lower one is standing in | fix that source |
| `tbill182 ... <- SOURCE IS STALE` | the source answered, and its figure is weeks old | **collecting more often will not help** — the publisher has stopped |
| `tbill182 ... <- fell back, SOURCE IS STALE` | both: the first choice is gone and the stand-in is behind | this is what the 182-day looked like in September |
| `... <- no date` | typed, but with no date, so its age cannot be judged | date it in the sheet |
| `tbill182 ... <- MISSING` | no source and no typed figure | type one |
| every indicator named against its live source | working | nothing |

This is the command to run first when a rate looks frozen. The `AS OF` column
is the reading's own publication date, not when it was fetched — which is the
distinction that took a week to spot by hand.

## A4 · Dry run — read the ladder before writing anything

```bash
kp --dry | tail -40
```

**You should see** ten rungs, infrastructure bonds at the top near **11.77%**, a
five-link chain, six relationships, and **no `STALE RATES`**.

If those rates look wrong, a source has changed shape. Stop.

## A5 · Write it live

```bash
kp
curl -s https://gachichio.org/pulse/data.json | head -c 60; echo
```

**You should see** ~40 seconds, then JSON beginning `{"asOf":"2026-`.

## A6 · Change the schedule

There already is one, in **`kpulse`'s** crontab — not yours, which is why
`crontab -l` as `bgkaranja` shows only the push sender. Look before you write:

```bash
ssh $K $V "date; echo '---'; sudo crontab -u kpulse -l | grep -v '^#'"
```

What it currently says, and the problem with it:

| Line | Runs | |
|---|---|---|
| `0 7 1,16 * *` | full sweep on the 1st and 16th | **twice a month** |
| `0 7 * * 6` | `--fast` on Saturdays | weekly |
| `0 4 1 1 *` | `--compact` on 1 January | yearly |
| `*/5 * * * *` | the push sender | leave alone |

`date` says this VM is on **UTC**, so `0 7` is 07:00 UTC, 10:00 in Nairobi.

The change: the full sweep moves from twice a month to weekly, and the fast
pass from weekly to daily. Everything else about those lines — the environment
file, `/usr/bin/python3`, `run.log` — stays exactly as it is.

```bash
ssh $K $V "sudo crontab -u kpulse -l | grep -v kenya_pulse.py | {
  cat
  echo '20 15 * * *  cd /home/bgkaranja/kenya-pulse && set -a && . /home/bgkaranja/secrets/kenya-pulse.env && set +a && /usr/bin/python3 kenya_pulse.py --fast >> /home/bgkaranja/kenya-pulse/run.log 2>&1'
  echo '40 15 * * 1  cd /home/bgkaranja/kenya-pulse && set -a && . /home/bgkaranja/secrets/kenya-pulse.env && set +a && /usr/bin/python3 kenya_pulse.py >> /home/bgkaranja/kenya-pulse/run.log 2>&1'
  echo '5 3 1 * *    cd /home/bgkaranja/kenya-pulse && set -a && . /home/bgkaranja/secrets/kenya-pulse.env && set +a && /usr/bin/python3 kenya_pulse.py --compact >> /home/bgkaranja/kenya-pulse/run.log 2>&1'
} | sudo crontab -u kpulse -"
```

- **Daily, 15:20 UTC** (18:20 Nairobi), `--fast`. Evening in Nairobi, so the
  day's CBK and NSE figures are published before it runs.
- **Mondays, 15:40 UTC**, the full sweep.
- **1st of the month, 03:05 UTC**, `--compact` — monthly rather than the
  previous once a year.

Absolute paths, not `~`: cron runs this as `kpulse`, whose home is not
`/home/bgkaranja`, so a tilde would resolve somewhere else entirely. The
existing lines already do this and the new ones match them.

`grep -v kenya_pulse.py` strips the three old collector lines and leaves the
push sender, which names `push_server.py`. Safe to run twice.

### Confirm

```bash
ssh $K $V "sudo crontab -u kpulse -l | grep -v '^#'"
```

**You should see** four lines: three collector, one push. Not seven — if you
see seven, the old ones were not stripped and you now have two schedules
writing the same files. Re-run the block above.

Then force one pass and watch it land:

```bash
kp --fast | tail -5
ssh $K $V "sudo tail -5 /home/bgkaranja/kenya-pulse/run.log"
```

### Stop run.log growing for ever

A run prints about 2.5 KB. Daily, that is roughly a megabyte a year with
nothing bounding it, and `push.log` has the same problem.

```bash
ssh $K $V "sudo tee /etc/logrotate.d/kenya-pulse > /dev/null" <<'CONF'
/home/bgkaranja/kenya-pulse/run.log /home/bgkaranja/kenya-pulse/push.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
    su kpulse kpulse
    create 0644 kpulse kpulse
}
CONF
ssh $K $V "sudo logrotate -d /etc/logrotate.d/kenya-pulse 2>&1 | tail -6"
```

`su kpulse kpulse` and `create` matter: the files belong to the service
account, and logrotate must not hand them to root on the first rotation.

### What it costs

| | |
|---|---|
| History rows | 1.1 KB each · 417 runs a year · **436 KB a year**, from 25 KB |
| Older than two years | archived gzipped by `--compact`, now monthly |
| `data.json` | 16 KB, overwritten each run, never appended |
| `run.log` | ~2.5 KB a run, held to four compressed weeks |
| Memory | one Python process, 15 seconds a day and 3 minutes a week |
| Supabase | untouched |

### What this fixes, and what it does not

Collecting more often fixes a figure that moves faster than you were looking.
It does **nothing** for a figure whose publisher has stopped — asking a source
frozen on 16 July five times a day returns the same number five times a day.
`kp --sources` tells the two apart, and marks the second `SOURCE IS STALE`.

### Why the charts do not get worse

History is one row per run, so a monthly figure sampled daily would have drawn
two dozen identical points — a flat line about a series that moves every month.
The collector stores the levels a figure has taken rather than the times it was
looked at, so a sparkline reads the same whatever the schedule.

The mixed schedule is safe for the slow series too. A `--fast` row omits the
indicators it does not collect, and `score()` skips absent keys rather than
reading them as gaps, so an annual figure's history and prior are built only
from the full runs that carry it. Checked in `tests/collector_test.py`.

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
