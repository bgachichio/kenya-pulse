"""The collector's own logic, with no network.

Every network call in kenya_pulse.py lives in gather(); everything below it is
pure. That is what makes this possible: the file is imported with its network
dependencies stubbed, and the arithmetic is checked directly.

Run:  python3 tests/collector_test.py
"""
import importlib.util
import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "kenya_pulse.py"

# bs4, lxml and requests are only needed by the fetchers, which nothing here
# calls. Stubbing them keeps this suite runnable with no dependencies at all.
for name in ("requests", "bs4", "lxml"):
    if name not in sys.modules:
        mod = types.ModuleType(name)
        if name == "bs4":
            mod.BeautifulSoup = object
        if name == "requests":
            mod.get = mod.post = lambda *a, **k: None
            mod.exceptions = types.SimpleNamespace(RequestException=Exception)
        sys.modules[name] = mod

spec = importlib.util.spec_from_file_location("kenya_pulse", SRC)
kp = importlib.util.module_from_spec(spec)
sys.argv = ["kenya_pulse.py", "--dry"]
spec.loader.exec_module(kp)

passed = failed = 0


def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ {name} {detail}")


print("\n── A LINE OF LEVELS, NOT A LINE OF VISITS")
d = kp.distinct_levels
ok("repeats collapse", d([5, 5, 5, 6, 6, 7]) == [5, 6, 7], str(d([5, 5, 5, 6, 6, 7])))
ok("an empty history stays empty", d([]) == [])
ok("a single reading survives", d([3]) == [3])
ok("a real oscillation is not flattened", d([1, 2, 1, 2]) == [1, 2, 1, 2])
ok("floating point noise counts as the same level",
   d([1.0, 1.0000000001, 2.0]) == [1.0, 2.0], str(d([1.0, 1.0000000001, 2.0])))

# The point of the whole thing: the same underlying series, sampled at two
# different collection rates, has to draw the same line.
monthly_truth = [7.0, 6.8, 6.5, 6.2, 6.0]
sampled_twice_monthly = [7.0, 6.8, 6.5, 6.2, 6.0]
sampled_daily = [7.0] * 3 + [6.8] * 4 + [6.5] * 3 + [6.2] * 2 + [6.0] * 4
ok("a fortnightly schedule and a daily one give the same line",
   d(sampled_twice_monthly) == d(sampled_daily) == monthly_truth,
   f"{d(sampled_daily)}")

print("\n── SCORING A READING")
REG = kp.REGISTER
hist = [{"values": {"inflation": v}} for v in [7.0, 7.0, 6.8, 6.8, 6.5, 6.5, 6.5]]
out = kp.score({"inflation": 6.2}, {"inflation": "cbk"}, hist, [])
row = next(r for r in out if r["id"] == "inflation")
ok("prior is the previous run, so 'unchanged' stays sayable",
   row["prior"] == 6.5, str(row["prior"]))
ok("the change is measured against it", abs(row["delta"] - (6.2 - 6.5)) < 1e-9,
   str(row["delta"]))
ok("but the line holds levels", row["hist"] == [7.0, 6.8, 6.5, 6.2], str(row["hist"]))
ok("the line ends on the value shown", row["hist"][-1] == row["value"])
ok("a fall in inflation is scored as good", row["state"] == "good", row["state"])

# and when nothing moved
out = kp.score({"inflation": 6.5}, {"inflation": "cbk"}, hist, [])
row = next(r for r in out if r["id"] == "inflation")
ok("an unmoved reading reports no change", row["delta"] == 0.0, str(row["delta"]))
ok("and adds no point to the line", row["hist"] == [7.0, 6.8, 6.5], str(row["hist"]))
ok("and is scored steady", row["state"] == "steady", row["state"])

print("\n── A DAILY FAST PASS MUST NOT DAMAGE THE SLOW SERIES")
# The schedule in DEPLOY.md A6 runs --fast daily and the full sweep weekly. A
# fast row simply omits the indicators it does not collect, so an annual figure
# must build its history from the full runs only, and must not read the gaps
# between them as anything at all.
mixed = []
for world, infl in [(3.2, 7.0), (None, 7.0), (None, 6.8), (None, 6.8),
                    (3.1, 6.5), (None, 6.5), (None, 6.5), (None, 6.2)]:
    row = {"inflation": infl}
    if world is not None:
        row["world_gdp"] = world
    mixed.append({"values": row})

res = kp.score({"inflation": 6.0, "world_gdp": 3.0},
               {"inflation": "cbk", "world_gdp": "imf"}, mixed, [])
w = next(r for r in res if r["id"] == "world_gdp")
i = next(r for r in res if r["id"] == "inflation")
ok("an annual series sees only the full runs that carry it",
   w["hist"] == [3.2, 3.1, 3.0], str(w["hist"]))
ok("and its prior is the previous full run, not yesterday's fast one",
   w["prior"] == 3.1, str(w["prior"]))
ok("its change is measured across full runs",
   abs(w["delta"] - (3.0 - 3.1)) < 1e-9, str(w["delta"]))
ok("a daily series still gets its own full line",
   i["hist"] == [7.0, 6.8, 6.5, 6.2, 6.0], str(i["hist"]))
ok("the repeated fast readings added no points to it",
   len(i["hist"]) == 5, str(i["hist"]))

print("\n── THE 182-DAY BILL")
ok("it is registered as a weekly instrument",
   REG["tbill182"][4] == "weekly", REG["tbill182"][4])
ok("a weekly figure goes stale in under a fortnight",
   kp.STALE_DAYS["weekly"] <= 12, str(kp.STALE_DAYS["weekly"]))
ok("a typed 182-day rate is not allowed to stand for three weeks",
   kp.MANUAL_CADENCE["tbill182"] <= 10, str(kp.MANUAL_CADENCE["tbill182"]))
ok("its live source is the auction scraper, with typing as the fallback",
   kp.PRECEDENCE["tbill182"] == ["sbills", "manual"], str(kp.PRECEDENCE["tbill182"]))
ok("a plausible range is enforced on it", kp.PLAUSIBLE["tbill182"] == (0, 40))

print("\n── EVERY REGISTERED INDICATOR CAN ACTUALLY BE FILLED")
src = SRC.read_text()
unreachable = [k for k in REG
               if k not in kp.PRECEDENCE and f'"{k}"' not in src.split("PRECEDENCE")[0]]
ok("every indicator has a stated source order or a scraper",
   all(k in kp.PRECEDENCE or f'"{k}"' in src for k in REG),
   ",".join(unreachable))
weekly_or_faster = [k for k, v in REG.items() if v[4] in ("daily", "weekly")]
ok("the fast pass exists for the figures that move fastest", len(weekly_or_faster) > 3,
   str(len(weekly_or_faster)))

print("\n── THE SOURCE REPORT")
ok("--sources is wired up", "--sources" in src and "def sources_report" in src)
ok("it is documented in the usage banner", "--sources  what each source" in src)
ok("it reports what parsed, not just what answered",
   "returned nothing" in src and "fell back" in src)
ok("--health still exists for reachability", "def health_report" in src)

print("\n── THE SOURCE REPORT ACTUALLY RUNS")
# Not "the string is in the file" - the function is executed with every fetcher
# stubbed, including one that fails, and its output is read back. This is the
# command someone runs when a rate looks frozen; it has to work.
import io
import contextlib

kp.src_cbk = lambda: {"cbr": 8.75, "inflation": 6.49, "kes_usd": 129.34,
                      "tbill": 8.77, "lending": 14.38, "deposit": 6.84,
                      "savings": 3.32, "kesonia": 8.75, "repo": 9.25,
                      "discount": 9.25, "kes_eur": 149.6, "kes_gbp": 175.11}
kp.src_nse = lambda: {"nasi": 145.2, "nse20": 2400.0, "nse25": 4100.0,
                      "bank_idx": 190.0, "mktcap": 2600.0}
kp.src_fred = lambda: {"fed_funds": 4.33, "us10y": 4.63}
kp.src_serrari = lambda: {"mmf_top": 12.1, "mmf_avg": 10.4}
kp.src_serrari_bonds = lambda: {"bond10": 13.5, "infra": 12.8}
kp.src_serrari_bills = lambda: {}          # the 182-day scraper, broken
kp.src_te = lambda: ({"pmi": 50.1}, {})
kp.src_fx = lambda: {}
kp.src_imf = lambda: ({}, {})
kp.src_worldbank = lambda: ({}, {})
kp.src_manual = lambda: ({"npl": 16.4, "reserves": 10.2, "cover": 4.9,
                          "cab": -3.0, "gdp": 5.3, "debt": 11.6,
                          "debt_gdp": 69.9, "debtserv": 61.0,
                          "tbill182": 9.0, "tbill364": 9.5}, {})
kp.src_sheet = lambda: ({}, {}, [])
kp.FAST = True

buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        kp.sources_report()
    out = buf.getvalue()
    ran = True
except Exception as exc:                                    # noqa: BLE001
    out, ran = f"{type(exc).__name__}: {exc}", False
ok("it runs end to end without raising", ran, out[:200])
ok("a scraper that returned nothing is named as such",
   "sbills" in out and "returned nothing" in out, "")
ok("and the indicator it feeds is flagged as having fallen back",
   re.search(r"tbill182.*fell back", out) is not None, "")

# The false positive this test exists for: manual is the FIRST choice for
# several indicators, so a manual figure there is the system working.
for ind in ("cab", "debt_gdp", "npl", "reserves", "cover"):
    assert kp.PRECEDENCE.get(ind, ["manual"])[0] == "manual", ind
ok("an indicator whose first choice is a typed figure is not flagged",
   not re.search(r"cab .*fell back", out) and not re.search(r"debt_gdp .*fell back", out),
   [l for l in out.splitlines() if l.strip().startswith(("cab ", "debt_gdp "))])

m = re.search(r"(\d+) of (\d+) indicators have a figure", out)
ok("the tally is stated", m is not None, "")
ok("and cannot exceed the register it counts against",
   m and int(m.group(1)) <= int(m.group(2)), m.group(0) if m else "")
ok("keys collected but not registered are listed separately, not counted",
   "collected but not registered" in out and "mmf_top" in out, "")

print("\n── THE SESSION VARIABLES EVERY OTHER COMMAND DEPENDS ON")
# $V and $K are shell variables. They live only in the terminal they were typed
# into, and 37 commands in the guide use them. A new tab loses them and every
# one of those commands fails with "hostname contains invalid characters",
# which names neither the cause nor the fix. Section 0 has to establish them,
# and it has to be the only place that does.
import os
import subprocess
import tempfile
import textwrap

deploy_text = (ROOT / "DEPLOY.md").read_text()
uses = deploy_text.count("ssh $K $V")
first_use = deploy_text.index("ssh $K $V")
defs = [i for i in range(len(deploy_text))
        if deploy_text.startswith('V="bgkaranja', i)]
ok("the guide really does lean on these variables", uses > 20, str(uses))
ok("they are defined exactly once, so there is one place to look",
   len(defs) == 1, f"{len(defs)} definitions")
ok("and defined before the first command that needs them",
   defs and defs[0] < first_use, f"defined at {defs[0] if defs else -1}, used at {first_use}")
ok("section 0 is where that happens",
   deploy_text.index("## 0 · Every session starts here") < defs[0])
ok("the error it produces is named, so it is self-diagnosing",
   "hostname contains invalid characters" in deploy_text)
ok("and told apart from the two it is confused with",
   "Permission denied (publickey)" in deploy_text
   and "Could not resolve hostname" in deploy_text)

# run section 0 for real, against a stand-in ssh
s0 = deploy_text[deploy_text.index("## 0 · Every session starts here"):]
s0_block = s0.split("```bash", 1)[1].split("```", 1)[0].strip()
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    (tmp / "bin").mkdir()
    (tmp / "bin" / "ssh").write_text(textwrap.dedent("""\
        #!/bin/bash
        # argv mirrors real ssh: options, hostname, then the command
        while [ "$1" = "-i" ]; do shift 2; done
        host="$1"; shift
        case "$host" in
          ""|*" "*) echo "hostname contains invalid characters" >&2; exit 255;;
        esac
        echo "$@" | sed 's/^echo //' | tr -d '"'
        """))
    (tmp / "bin" / "ssh").chmod(0o755)
    env = {**os.environ, "HOME": str(tmp), "PATH": f"{tmp / 'bin'}:{os.environ['PATH']}"}
    env.pop("V", None); env.pop("K", None)

    first = subprocess.run(["bash", "-c", s0_block], env=env, capture_output=True, text=True)
    ok("section 0 runs on a machine that has never seen it",
       first.returncode == 0 and "reachable" in first.stdout, first.stderr[:120])
    ok("and it wrote the file so the next terminal is cheaper",
       (tmp / ".kenya-pulse-env").exists())

    second = subprocess.run(["bash", "-c", s0_block], env=env, capture_output=True, text=True)
    ok("running it again reads the file rather than rewriting it",
       second.returncode == 0 and "reachable" in second.stdout, second.stderr[:120])
    ok("and yields the same host both times",
       [l for l in first.stdout.splitlines() if l.startswith("V=")]
       == [l for l in second.stdout.splitlines() if l.startswith("V=")],
       first.stdout + "|" + second.stdout)

    # and the failure it exists to prevent
    naked = subprocess.run(["bash", "-c", 'ssh $K $V "crontab -l | grep x"'],
                           env=env, capture_output=True, text=True)
    ok("without it, the reported error is exactly what appears",
       "hostname contains invalid characters" in naked.stderr, naked.stderr[:120])

print("\n── THE CRON BLOCK IN DEPLOY.MD ACTUALLY WORKS")
# The command in the deploy guide is extracted from the document and run for
# real against a stand-in crontab. A documented command nobody executes is a
# guess, and this one has to be safe to run twice on a box that already has
# other jobs in it.
import subprocess
import tempfile
import textwrap

deploy = (ROOT / "DEPLOY.md").read_text()
a6 = deploy[deploy.index("## A6 · Put it on a schedule"):deploy.index("## A7 ")]
block = a6.split("```bash", 1)[1].split("```", 1)[0].strip()
ok("the A6 cron block is still findable", "crontab -" in block, block[:60])

# unwrap `ssh $K $V "…"` so the inner script runs locally
inner = block[block.index('"') + 1:block.rindex('"')]

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    fake = tmp / "crontab"
    fake.write_text(textwrap.dedent("""\
        #!/bin/bash
        # faithful crontab(1): the writer drains stdin before replacing the spool
        STORE="$CRONTEST_STORE"
        case "$1" in
          -l) [ -s "$STORE" ] || { echo "no crontab" >&2; exit 1; }; cat "$STORE";;
          -)  t=$(mktemp); cat > "$t"; mv "$t" "$STORE";;
          *)  exit 2;;
        esac
        """))
    fake.chmod(0o755)
    store = tmp / "spool"
    env = {**__import__("os").environ,
           "PATH": f"{tmp}:{__import__('os').environ['PATH']}",
           "CRONTEST_STORE": str(store)}

    def run():
        return subprocess.run(["bash", "-c", inner], env=env,
                              capture_output=True, text=True)

    # 1. an empty crontab
    r = run()
    ok("it runs cleanly against an empty crontab", r.returncode == 0, r.stderr[:120])
    ok("and installs three collector entries",
       store.read_text().count("kenya_pulse.py") == 3, store.read_text())

    # 2. a populated one, applied three times
    store.write_text(
        "*/5 * * * * ~/kenya-pulse/.venv-push/bin/python push_server.py --send-due\n"
        "0 2 * * * /usr/bin/certbot renew --quiet\n")
    for _ in range(3):
        r = run()
        assert r.returncode == 0, r.stderr
    out = store.read_text()
    lines = [l for l in out.splitlines() if l.strip()]
    ok("running it three times leaves three collector entries, not nine",
       out.count("kenya_pulse.py") == 3, str(out.count("kenya_pulse.py")))
    ok("the push sender survives untouched", out.count("send-due") == 1)
    ok("so does anything else already scheduled", out.count("certbot") == 1)
    ok("exactly one timezone line", out.count("CRON_TZ=") == 1)

    # 3. the placement that matters: a cron env line governs what follows it,
    #    so anything already there must sit ABOVE it and keep its own hours.
    tz_at = next(i for i, l in enumerate(lines) if l.startswith("CRON_TZ="))
    certbot_at = next(i for i, l in enumerate(lines) if "certbot" in l)
    coll_at = [i for i, l in enumerate(lines) if "kenya_pulse.py" in l]
    ok("existing jobs sit above the timezone line, so their hours do not move",
       certbot_at < tz_at, f"certbot at {certbot_at}, CRON_TZ at {tz_at}")
    ok("and every collector line sits below it",
       all(i > tz_at for i in coll_at), f"{coll_at} vs {tz_at}")

    # 4. the entries themselves
    fields = [l.split()[:5] for l in lines if "kenya_pulse.py" in l]
    ok("each entry has five schedule fields",
       all(len(f) == 5 for f in fields), str(fields))
    ok("one runs every day", any(f[2:] == ["*", "*", "*"] for f in fields), str(fields))
    ok("one runs weekly on a single weekday",
       any(f[2] == "*" and f[4] in list("0123456") for f in fields), str(fields))
    ok("nothing runs more than once a day",
       all("/" not in f[0] and "/" not in f[1] for f in fields), str(fields))
    ok("every entry calls the virtualenv, never a bare python3",
       all(".venv/bin/python" in l for l in lines if "kenya_pulse.py" in l)
       and not any("python3 kenya_pulse" in l for l in lines), out)

print("\n── THE WATCHDOG STILL GUARDS SILENCE")
state = {}
ok("a first run records the shape", kp.watchdog({"a": 1}, state) is None)
ok("and remembers when it last changed", "lastChange" in state)
ok("an unchanged run on the same day is not an alarm",
   kp.watchdog({"a": 1}, state) is None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
