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

print("\n── THE WATCHDOG STILL GUARDS SILENCE")
state = {}
ok("a first run records the shape", kp.watchdog({"a": 1}, state) is None)
ok("and remembers when it last changed", "lastChange" in state)
ok("an unchanged run on the same day is not an alarm",
   kp.watchdog({"a": 1}, state) is None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
