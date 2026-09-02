"""The collector's own logic, with no network.

Every network call in kenya_pulse.py lives in gather(); everything below it is
pure. That is what makes this possible: the file is imported with its network
dependencies stubbed, and the arithmetic is checked directly.

Run:  python3 tests/collector_test.py
"""
import contextlib
import importlib.util
import io
import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "kenya_pulse.py"

# The fetchers need requests, bs4 and lxml; nothing here makes a network call,
# so requests is always stubbed. bs4 and lxml are used for real when they are
# installed, because the HTML parsers below have to be exercised against a real
# parse tree - a stub would test nothing. Without them those checks are skipped
# and say so, rather than passing quietly.
HAVE_BS4 = True
try:
    import bs4  # noqa: F401
    import lxml  # noqa: F401
except ImportError:
    HAVE_BS4 = False
    for name in ("bs4", "lxml"):
        mod = types.ModuleType(name)
        if name == "bs4":
            mod.BeautifulSoup = object
        sys.modules[name] = mod
if "requests" not in sys.modules:
    mod = types.ModuleType("requests")
    mod.get = mod.post = lambda *a, **k: None
    mod.exceptions = types.SimpleNamespace(RequestException=Exception)
    sys.modules["requests"] = mod

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

print("\n── READING CBK'S TREASURY BILL TABLE")
# The page cannot be reached from a build machine, so this cannot prove the
# scraper matches CBK's live markup - only the run on the VM does that. What it
# does prove is that the parser handles both shapes such a table is published
# in, picks the newest auction rather than the first row it meets, refuses a
# figure no bill could pay, and says what it saw when it finds nothing.
if not HAVE_BS4:
    print("  ! skipped: beautifulsoup4 and lxml are not installed")
    print("    pip install -r tests/requirements-test.txt")
else:
    from bs4 import BeautifulSoup

    _real_get = kp.get

    def parse(html):
        """Drive src_cbk_bills against a page, with no network."""
        kp.get = lambda *a, **k: types.SimpleNamespace(text=html)
        return kp.src_cbk_bills()

    # --- shape one: a row per tenor -----------------------------------------
    long_html = """
    <table>
      <tr><th>Issue No</th><th>Tenor</th><th>Auction Date</th>
          <th>Amount Offered</th><th>Weighted Average Rate</th></tr>
      <tr><td>2612/091</td><td>91 Day</td><td>2026-08-28</td><td>4,000</td><td>8.9123</td></tr>
      <tr><td>2612/182</td><td>182 Day</td><td>2026-08-28</td><td>10,000</td><td>9.4567</td></tr>
      <tr><td>2612/364</td><td>364 Day</td><td>2026-08-28</td><td>10,000</td><td>10.1234</td></tr>
      <tr><td>2611/182</td><td>182 Day</td><td>2026-08-21</td><td>10,000</td><td>9.4001</td></tr>
    </table>"""
    got = parse(long_html)
    ok("a row-per-tenor table gives all three tenors",
       {"tbill", "tbill182", "tbill364"} <= set(got), str(got))
    ok("the 91-day is read", abs(got.get("tbill", 0) - 8.9123) < 1e-6, str(got.get("tbill")))
    ok("the 182-day is read", abs(got.get("tbill182", 0) - 9.4567) < 1e-6, str(got.get("tbill182")))
    ok("the 364-day is read", abs(got.get("tbill364", 0) - 10.1234) < 1e-6, str(got.get("tbill364")))
    ok("the newest auction wins, not the first row met",
       abs(got["tbill182"] - 9.4567) < 1e-6, str(got["tbill182"]))
    ok("the auction date travels with the rate", got.get("_asof") == "2026-08-28", str(got.get("_asof")))

    # the same shape, with the column called something else. CBK is not
    # consistent about this across its own pages.
    term_html = long_html.replace("Tenor", "Term").replace("Weighted Average Rate",
                                                           "Average Yield")
    got = parse(term_html)
    ok("a Term column is read like a Tenor column",
       abs(got.get("tbill182", 0) - 9.4567) < 1e-6, str(got))
    ok("and an Average Yield column like an Average Rate column",
       {"tbill", "tbill182", "tbill364"} <= set(got), str(got))

    # --- shape two: a column per tenor --------------------------------------
    wide_html = """
    <table>
      <tr><th>Auction Date</th><th>91 Day</th><th>182 Day</th><th>364 Day</th></tr>
      <tr><td>14/08/2026</td><td>8.70</td><td>9.20</td><td>9.90</td></tr>
      <tr><td>28/08/2026</td><td>8.91</td><td>9.46</td><td>10.12</td></tr>
      <tr><td>21/08/2026</td><td>8.80</td><td>9.30</td><td>10.00</td></tr>
    </table>"""
    got = parse(wide_html)
    ok("a column-per-tenor table also works",
       {"tbill", "tbill182", "tbill364"} <= set(got), str(got))
    ok("it takes the newest row wherever it sits in the table",
       abs(got.get("tbill182", 0) - 9.46) < 1e-6, str(got.get("tbill182")))
    ok("and dates it from that row", got.get("_asof") == "2026-08-28", str(got.get("_asof")))

    # --- dates, in the shapes CBK writes them -------------------------------
    ok("ISO dates parse", kp._parse_date("2026-07-16") == "2026-07-16")
    ok("day-first slashes parse", kp._parse_date("16/07/2026") == "2026-07-16")
    ok("day-first dashes parse", kp._parse_date("16-07-2026") == "2026-07-16")
    ok("written months parse", kp._parse_date("16 July 2026") == "2026-07-16")
    ok("short months parse", kp._parse_date("16 Jul 2026") == "2026-07-16")
    ok("a date that is not one gives nothing, rather than today",
       kp._parse_date("n/a") is None and kp._parse_date("") is None)
    ok("an impossible date is refused", kp._parse_date("31/02/2026") is None)

    # --- a rate has to be a rate -------------------------------------------
    ok("a percentage sign does not break it", abs(kp._rate("9.46 %") - 9.46) < 1e-9)
    ok("an amount column is not mistaken for a rate", kp._rate("10,000") is None)
    ok("an issue number is not mistaken for a rate", kp._rate("2612/091") is None)
    ok("a bill cannot pay 300%", kp._rate("300") is None)
    ok("nor nothing at all", kp._rate("0") is None and kp._rate("-") is None)

    # --- failure has to be loud --------------------------------------------
    empty = parse("<html><body><p>Downloads temporarily unavailable</p></body></html>")
    ok("a page with no table yields nothing rather than a wrong number", empty == {}, str(empty))

    wrong = parse("""
    <table><tr><th>Bond</th><th>Coupon</th><th>Maturity</th></tr>
    <tr><td>FXD1</td><td>13.2</td><td>2032</td></tr>
    <tr><td>FXD2</td><td>12.9</td><td>2035</td></tr></table>""")
    ok("the wrong table is not mistaken for the right one", wrong == {}, str(wrong))

    # and it has to say what it saw, or the next failure is another long hunt
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        parse("<table><tr><th>Bond</th><th>Coupon</th></tr>"
              "<tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></table>")
    said = buf.getvalue()
    ok("and it names the headers it did find", "headers seen" in said and "Bond" in said, said.strip())

    # --- a stale auction is still returned, and still dated -----------------
    stale = parse("""
    <table><tr><th>Tenor</th><th>Auction Date</th><th>Average Rate</th></tr>
    <tr><td>182 Day</td><td>16/07/2026</td><td>8.97</td></tr>
    <tr><td>364 Day</td><td>16/07/2026</td><td>9.04</td></tr>
    <tr><td>91 Day</td><td>16/07/2026</td><td>8.77</td></tr></table>""")
    ok("a stale auction is reported with its real date, not suppressed",
       stale.get("tbill182") == 8.97 and stale.get("_asof") == "2026-07-16", str(stale))

    # --- the wrong table, which is what actually happened -------------------
    # The first live run matched something on CBK's page dated 2016 and
    # reported a ten-year-old 91-day rate of 9.06% as current, against 8.77%
    # from the homepage. A plausible wrong number is the worst outcome
    # available: it outranks the right one and nothing looks broken.
    archive = """
    <table><caption>Treasury Bills Average Rates</caption>
      <tr><th>Issue Date</th><th>91 Day</th><th>182 Day</th><th>364 Day</th></tr>
      <tr><td>07/03/2016</td><td>9.06</td><td>10.2</td><td>11.4</td></tr>
      <tr><td>14/03/2016</td><td>9.10</td><td>10.3</td><td>11.5</td></tr>
      <tr><td>21/03/2016</td><td>9.20</td><td>10.4</td><td>11.6</td></tr></table>"""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        got = parse(archive)
    said = buf.getvalue()
    ok("a decade-old auction is refused, not published as today's rate",
       got == {}, str(got))
    ok("and the refusal says what it matched and why",
       "wrong table" in said and "2016" in said, said.strip())
    ok("it names the values it threw away, so the fix is obvious",
       "9.2" in said or "9.06" in said, said.strip())

    # the same table with current dates is fine - it is the age that is wrong,
    # not the shape
    ok("the same shape with current dates parses",
       parse(archive.replace("2016", "2026")).get("tbill182") == 10.4)

    # a date in the future is equally impossible
    ahead = archive.replace("2016", "2099")
    ok("an auction dated in the future is refused too", parse(ahead) == {})

    # --- a failure must return nothing, not the part that parsed ------------
    # These functions build their result as they go. Returning it after an
    # exception hands back half a table: numbers read from the wrong columns,
    # which is how a wrong rate reaches the ladder wearing a FAILED log line.
    ok("a scraper that fails returns nothing at all",
       parse(archive) == {} and parse("<html></html>") == {})

    # put the fetcher back: leaving it stubbed makes every later scenario read
    # whichever page this block happened to feed it last
    kp.get = _real_get

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

print("\n── OLD IS NOT THE SAME AS OVERDUE")
# A quarterly figure is not published the day the quarter ends. KNBS releases
# GDP about three months later, so a 155-day-old GDP reading is a normal one.
# Thresholds set to the cycle alone flagged all three fiscal series every run,
# which teaches the reader to ignore the flag - and the flag is the only thing
# that would have shown the 182-day bill going quiet.
C = kp.MANUAL_CADENCE
ok("quarterly GDP tolerates a real publication lag",
   C["gdp"] >= 190, str(C["gdp"]))
ok("so does the current account", C["cab"] >= 190, str(C["cab"]))
ok("and debt to GDP", C["debt_gdp"] >= 190, str(C["debt_gdp"]))
ok("the monthly debt stock allows for the Treasury's lag",
   110 <= C["debt"] <= 150, str(C["debt"]))
ok("an annual figure gets a year and a bit", C["debtserv"] >= 365, str(C["debtserv"]))
ok("but a weekly auction still gets days, not months",
   C["tbill182"] <= 14, str(C["tbill182"]))
ok("and weekly reserves stay tight", C["reserves"] <= 21, str(C["reserves"]))
ok("every threshold is longer than the cycle it guards",
   all(C[k] > kp.STALE_DAYS[kp.REGISTER[k][4]] * 0.9
       for k in ("gdp", "cab", "debt", "npl") if k in C and k in kp.REGISTER),
   str({k: (C.get(k), kp.REGISTER[k][4]) for k in ("gdp", "cab", "debt", "npl")}))

# the live ages from the 2 September run must no longer raise an alarm
for name, age, should_flag in (("gdp", 155, False), ("debt", 94, False),
                               ("debt_gdp", 155, False), ("cab", 64, False),
                               ("npl", 33, False), ("tbill182", 48, True)):
    ok(f"{name} at {age} days is {'flagged' if should_flag else 'not flagged'}",
       (age > C[name]) == should_flag, f"threshold {C[name]}")

print("\n── THE 182-DAY BILL")
ok("it is registered as a weekly instrument",
   REG["tbill182"][4] == "weekly", REG["tbill182"][4])
ok("a weekly figure goes stale in under a fortnight",
   kp.STALE_DAYS["weekly"] <= 12, str(kp.STALE_DAYS["weekly"]))
ok("a typed 182-day rate is not allowed to stand for three weeks",
   kp.MANUAL_CADENCE["tbill182"] <= 10, str(kp.MANUAL_CADENCE["tbill182"]))
ok("CBK is asked first, Serrari second, typing last",
   kp.PRECEDENCE["tbill182"] == ["cbkbills", "sbills", "manual"],
   str(kp.PRECEDENCE["tbill182"]))
ok("the 91-day keeps the homepage rate first",
   kp.PRECEDENCE["tbill"][0] == "cbk", str(kp.PRECEDENCE["tbill"]))
ok("all three tenors have two independent live sources",
   all(len([x for x in kp.PRECEDENCE[k] if x != "manual"]) >= 2
       for k in ("tbill", "tbill182", "tbill364")),
   str({k: kp.PRECEDENCE[k] for k in ("tbill", "tbill182", "tbill364")}))
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
kp.src_cbk = lambda: {"cbr": 8.75, "inflation": 6.49, "kes_usd": 129.34,
                      "tbill": 8.77, "lending": 14.38, "deposit": 6.84,
                      "savings": 3.32, "kesonia": 8.75, "repo": 9.25,
                      "discount": 9.25, "kes_eur": 149.6, "kes_gbp": 175.11}
kp.src_nse = lambda: {"nasi": 145.2, "nse20": 2400.0, "nse25": 4100.0,
                      "bank_idx": 190.0, "mktcap": 2600.0}
kp.src_fred = lambda: {"fed_funds": 4.33, "us10y": 4.63}
kp.src_serrari = lambda: {"mmf_top": 12.1, "mmf_avg": 10.4}
kp.src_serrari_bonds = lambda: {"bond10": 13.5, "infra": 12.8}
kp.src_cbk_bills = lambda: {}             # CBK not answering
kp.src_serrari_bills = lambda: {}          # and Serrari's scraper broken too
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

# "is the connection working" is a different question from "is the figure
# fresh", and it gets its own line rather than being inferred from the table.
ok("the report states how many live sources answered",
   re.search(r"connection: \d+ of \d+ live sources answered", out) is not None,
   [l for l in out.splitlines() if "connection" in l])
ok("and names the ones that did not",
   "SILENT: " in out and "cbkbills" in out.split("SILENT: ")[1][:60],
   [l for l in out.splitlines() if "connection" in l])

print("\n── A SOURCE THAT ANSWERS, PARSES, AND IS STILL STALE")
# The failure that hid for weeks and that neither --health nor a parse check
# sees: serrarigroup answered, the table parsed, 8.97% came back - and the
# auction it belongs to was six weeks old. Reachability said fine. Parsing
# said fine. The number was stale at the publisher.
kp.src_serrari_bills = lambda: {"tbill182": 8.97, "tbill364": 9.04,
                                "_asof": "2026-07-16"}
kp.src_te = lambda: ({"pmi": 50.1}, {"pmi": "2026-08-01"})
kp.src_manual = lambda: ({"npl": 16.4, "reserves": 10.2, "cover": 4.9,
                          "cab": -3.0, "gdp": 5.3, "debt": 11.6,
                          "debt_gdp": 69.9, "debtserv": 61.0},
                         {"npl": "2026-08-20", "reserves": "2026-08-25"})
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    kp.sources_report()
out2 = buf.getvalue()

ok("the reading's own date is shown, not the time it was fetched",
   "2026-07-16" in out2, "")
ok("its age in days is shown beside it",
   re.search(r"tbill182.*2026-07-16\s+\d+", out2) is not None,
   [l for l in out2.splitlines() if "tbill182" in l])
ok("and it is called out rather than left to be noticed",
   re.search(r"tbill182.*SOURCE IS STALE", out2) is not None,
   [l for l in out2.splitlines() if "tbill182" in l])
ok("both faults are shown, not just the first - CBK gave nothing AND "
   "the source that answered is weeks behind",
   re.search(r"tbill182.*fell back, SOURCE IS STALE", out2) is not None,
   [l for l in out2.splitlines() if "tbill182" in l])
ok("the summary says plainly that collecting more often will not help",
   "collecting more often will not move them" in out2, "")
ok("and that a normal publication lag is not what it means",
   "publication lag" in out2, "")
ok("a value is still reported - it is stale, not missing",
   re.search(r"tbill182\s+8\.97", out2) is not None, "")
# and when CBK itself answers with a stale auction, that is stale only - it
# did not fall back to anything
kp.src_cbk_bills = lambda: {"tbill182": 8.97, "tbill364": 9.04,
                            "_asof": "2026-07-16"}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    kp.sources_report()
out3 = buf.getvalue()
ok("a first-choice source that is stale is marked stale, not fallen back",
   re.search(r"tbill182.*SOURCE IS STALE", out3) is not None
   and not re.search(r"tbill182.*fell back", out3),
   [l for l in out3.splitlines() if "tbill182" in l])
ok("and the date shown is CBK's own auction date",
   re.search(r"tbill182.*2026-07-16", out3) is not None, "")
kp.src_cbk_bills = lambda: {}

# and the three problems stay apart
ok("a figure typed with a recent date is not flagged",
   not re.search(r"\bnpl\b.*(STALE|no date)", out2),
   [l for l in out2.splitlines() if l.strip().startswith("npl ")])
ok("a figure typed with no date at all is a separate, milder note",
   "typed but carrying no date" in out2 and "cab" in out2.split("typed but carrying no date")[1],
   "")
ok("a fresh live source is flagged as nothing at all",
   not re.search(r"\bcbr\b.*(STALE|fell back|no date)", out2),
   [l for l in out2.splitlines() if l.strip().startswith("cbr ")])

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

    # Everything a session needs has to be in that one file. Saving only V and
    # K left $SRC and the kp helper behind, and a new terminal then failed with
    # "not a git repository" and "kp: command not found" instead.
    envfile = (tmp / ".kenya-pulse-env").read_text()
    for name in ("V=", "K=", "SRC=", "kp()"):
        ok(f"the file carries {name.rstrip('=()')}", name in envfile, envfile[:200])

    # and it all survives into a genuinely new shell
    fresh = subprocess.run(
        ["bash", "-c", '. ~/.kenya-pulse-env; echo "V=$V"; echo "SRC=$SRC"; '
                       'type kp >/dev/null 2>&1 && echo KP_OK; kp --sources'],
        env=env, capture_output=True, text=True)
    ok("a new terminal that only sources the file gets the host",
       "V=bgkaranja@" in fresh.stdout, fresh.stdout[:120])
    ok("and the checkout path", "SRC=" in fresh.stdout and "kenya-pulse-src" in fresh.stdout,
       fresh.stdout[:120])
    ok("and the kp helper", "KP_OK" in fresh.stdout, fresh.stdout[:120])
    ok("kp passes its flags through to the collector",
       "kenya_pulse.py --sources" in fresh.stdout, fresh.stdout[-200:])
    ok("and runs it as kpulse, the way cron does",
       "sudo -u kpulse" in fresh.stdout, fresh.stdout[-200:])
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
a6 = deploy[deploy.index("## A6 · Change the schedule"):deploy.index("## A7 ")]
# the first fence in A6 only looks; the second is the one that writes
block = a6.split("```bash")[2].split("```", 1)[0].strip()
ok("the A6 cron block is still findable", "crontab -" in block, block[:60])

# unwrap `ssh $K $V "…"` so the inner script runs locally
inner = block[block.index('"') + 1:block.rindex('"')]

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    fake = tmp / "crontab"
    fake.write_text(textwrap.dedent("""\
        #!/bin/bash
        # faithful crontab(1): understands -u, and the writer drains stdin
        # before replacing the spool, the way Debian's does
        STORE="$CRONTEST_STORE"
        if [ "$1" = "-u" ]; then USER_ARG="$2"; shift 2; fi
        case "$1" in
          -l) [ -s "$STORE" ] || { echo "no crontab" >&2; exit 1; }; cat "$STORE";;
          -)  t=$(mktemp); cat > "$t"; mv "$t" "$STORE";;
          *)  exit 2;;
        esac
        """))
    fake.chmod(0o755)
    # and a sudo that just runs what it is given
    (tmp / "sudo").write_text('#!/bin/bash\nexec "$@"\n')
    (tmp / "sudo").chmod(0o755)
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

    # 2. the real starting state on the VM: three old collector lines plus the
    #    push sender, all in kpulse's crontab
    store.write_text(
        "0 7 1,16 * *  cd /home/bgkaranja/kenya-pulse && /usr/bin/python3 kenya_pulse.py >> run.log 2>&1\n"
        "0 7 * * 6     cd /home/bgkaranja/kenya-pulse && /usr/bin/python3 kenya_pulse.py --fast >> run.log 2>&1\n"
        "0 4 1 1 *     cd /home/bgkaranja/kenya-pulse && /usr/bin/python3 kenya_pulse.py --compact >> run.log 2>&1\n"
        "*/5 * * * * cd /home/bgkaranja/kenya-pulse && .venv-push/bin/python push_server.py --send-due >> push.log 2>&1\n")
    for _ in range(3):
        r = run()
        assert r.returncode == 0, r.stderr
    out = store.read_text()
    lines = [l for l in out.splitlines() if l.strip()]
    ok("running it three times leaves three collector entries, not nine",
       out.count("kenya_pulse.py") == 3, str(out.count("kenya_pulse.py")))
    ok("the old twice-monthly line is gone", "1,16" not in out, out)
    ok("the push sender survives untouched", out.count("send-due") == 1)
    ok("it writes to kpulse's crontab, not the caller's",
       "crontab -u kpulse" in inner, inner[:80])

    # 3. everything the existing lines depend on has to survive
    coll = [l for l in lines if "kenya_pulse.py" in l]
    ok("every line still sources the environment file",
       all("kenya-pulse.env" in l for l in coll), str(coll[:1]))
    ok("every line still uses the system python that has the packages",
       all("/usr/bin/python3" in l for l in coll), str(coll[:1]))
    ok("no line invents a virtualenv the box does not have",
       not any(".venv/bin" in l for l in coll))
    ok("every line still logs where the old ones logged",
       all("run.log" in l for l in coll), str(coll[:1]))
    ok("paths are absolute, because kpulse's home is not bgkaranja's",
       not any(" ~/" in l for l in coll), str([l for l in coll if " ~/" in l]))

    # 4. the entries themselves
    fields = [l.split()[:5] for l in lines if "kenya_pulse.py" in l]
    ok("each entry has five schedule fields",
       all(len(f) == 5 for f in fields), str(fields))
    ok("the fast pass now runs every day, not weekly",
       any(f[2:] == ["*", "*", "*"] for f in fields), str(fields))
    ok("the full sweep now runs weekly, not twice a month",
       any(f[2] == "*" and f[4] in list("0123456") for f in fields), str(fields))
    ok("nothing runs more often than daily",
       all("/" not in f[0] and "/" not in f[1] for f in fields), str(fields))
    ok("compact runs monthly, not yearly",
       any(f[3] == "*" and f[2] == "1" for f in fields), str(fields))

print("\n── THE WATCHDOG STILL GUARDS SILENCE")
state = {}
ok("a first run records the shape", kp.watchdog({"a": 1}, state) is None)
ok("and remembers when it last changed", "lastChange" in state)
ok("an unchanged run on the same day is not an alarm",
   kp.watchdog({"a": 1}, state) is None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
