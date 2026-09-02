#!/usr/bin/env python3
"""
KENYA PULSE — collector v3

Pulls Kenyan and global macro data, reconciles sources that disagree, computes
the three signal layers, and writes one JSON the app renders.

    python3 kenya_pulse.py            full sweep, about 3 minutes
    python3 kenya_pulse.py --fast     rates, markets, currency only, ~15 seconds
    python3 kenya_pulse.py --dry      print, write nothing, send nothing
    python3 kenya_pulse.py --health   source reachability, no writes
    python3 kenya_pulse.py --sources  what each source actually parsed, no writes
    python3 kenya_pulse.py --tables URL   print every table on a page, no writes
    python3 kenya_pulse.py --remind   Telegram nudge listing what needs typing
    python3 kenya_pulse.py --remind   nudge about figures that need typing
    python3 kenya_pulse.py --compact  roll the log up

Dependencies, pinned. A virtualenv, because Debian marks its system Python
externally managed and `pip3 install --user` fails there outright:
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
On the VM every call runs as ~/kenya-pulse/.venv/bin/python, cron included.

The three layers, computed here rather than in the browser so the app stays a
renderer and this file stays the single place logic can be wrong:

  LADDER    after-tax real return on every instrument, ranked
  CHAIN     the transmission from policy rate to GDP, with lags
  BREAKS    long-running relationships that have come apart

Author: Brian Gachichio · gachichio.org
"""

import csv, gzip, io, json, os, re, shutil, statistics as st, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

import requests
from bs4 import BeautifulSoup

HERE    = os.path.dirname(os.path.abspath(__file__))
PUBLIC  = os.path.join(HERE, "public")
OUT     = os.path.join(PUBLIC, "data.json")
SPINE   = os.path.join(PUBLIC, "spine.json")
LOG     = os.path.join(HERE, "history.jsonl")
ARCHIVE = os.path.join(HERE, "archive")
MANUAL  = os.path.join(HERE, "manual.json")
STATE   = os.path.join(HERE, "state.json")

FAST    = "--fast"    in sys.argv
REMIND  = "--remind"  in sys.argv
REMIND  = "--remind"  in sys.argv
DRY     = "--dry"     in sys.argv
HEALTH  = "--health"  in sys.argv
SOURCES = "--sources" in sys.argv
TABLES  = "--tables"  in sys.argv
COMPACT = "--compact" in sys.argv

TG_TOKEN = os.environ.get("KP_TG_TOKEN", "")
TG_CHAT  = os.environ.get("KP_TG_CHAT", "")
Z_ALERT  = float(os.environ.get("KP_Z", "1.5"))

# Two header profiles. The HTML sites drop requests without a browser
# user-agent; the IMF returns 403 to one. Sending the same headers everywhere
# silently kills half the sources.
UA_BROWSER = {"User-Agent": ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                             "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"),
              "Accept": "text/html,application/xhtml+xml,*/*",
              "Accept-Language": "en-GB,en;q=0.9"}
UA_PLAIN = {"Accept": "application/json, text/csv, */*"}


def log(*a):
    print(f"[{datetime.now().strftime('%H:%M:%S')}]", *a, flush=True)


def get(url, tries=3, timeout=30, plain=False):
    """Every network call goes through here. Retries, swaps header profile on
    403, and never raises past its own caller."""
    profiles = [UA_PLAIN, UA_BROWSER] if plain else [UA_BROWSER, UA_PLAIN]
    last = None
    for n in range(tries):
        for h in profiles:
            try:
                r = requests.get(url, headers=h, timeout=timeout)
                if r.status_code == 200:
                    return r
                last = f"HTTP {r.status_code}"
            except Exception as e:
                last = str(e)[:80]
        time.sleep(1.2 * (n + 1))
    raise RuntimeError(last or "unreachable")


# ===========================================================================
# REGISTER
# ===========================================================================
# dir: +1 rising is good for the economy, -1 rising is bad, 0 neutral
REGISTER = {
    "cbr":       ("Central Bank Rate",            "Policy",   "%",       0, "bi-monthly"),
    "kesonia":   ("KESONIA overnight",            "Policy",   "%",       0, "daily"),
    "repo":      ("REPO rate",                    "Policy",   "%",       0, "weekly"),
    "discount":  ("Discount window",              "Policy",   "%",       0, "bi-monthly"),
    "tbill":     ("91-day Treasury bill",         "Policy",   "%",       0, "weekly"),
    "tbill182":  ("182-day Treasury bill",        "Policy",   "%",       0, "weekly"),
    "tbill364":  ("364-day Treasury bill",        "Policy",   "%",       0, "monthly"),
    "bond10":    ("10-year bond",                 "Policy",   "%",       0, "monthly"),

    "inflation": ("Headline inflation",           "Prices",   "%",      -1, "monthly"),

    "lending":   ("Average lending rate",         "Banking",  "%",      -1, "monthly"),
    "savings":   ("Average savings rate",         "Banking",  "%",      +1, "monthly"),
    "deposit":   ("Average deposit rate",         "Banking",  "%",      +1, "monthly"),
    "npl":       ("Non-performing loans",         "Banking",  "%",      -1, "monthly"),

    "kes_usd":   ("KES per USD",                  "External", "",       -1, "daily"),
    "kes_eur":   ("KES per EUR",                  "External", "",       -1, "daily"),
    "kes_gbp":   ("KES per GBP",                  "External", "",       -1, "daily"),
    "reserves":  ("FX reserves",                  "External", "$bn",    +1, "weekly"),
    "cover":     ("Import cover",                 "External", " months",+1, "weekly"),
    "cab":       ("Current account",              "External", "% GDP",  +1, "quarterly"),

    "gdp":       ("GDP growth",                   "Activity", "%",      +1, "quarterly"),
    "pmi":       ("Stanbic PMI",                  "Activity", "",       +1, "monthly"),

    "nasi":      ("NSE All Share",                "Markets",  "",       +1, "daily"),
    "nse20":     ("NSE 20 Share",                 "Markets",  "",       +1, "daily"),
    "nse25":     ("NSE 25 Share",                 "Markets",  "",       +1, "daily"),
    "bank_idx":  ("NSE Banking Sector",           "Markets",  "",       +1, "daily"),
    "mktcap":    ("NSE market cap",               "Markets",  " KES bn",+1, "daily"),

    "debt":      ("Public debt stock",            "Fiscal",   " KES tn",-1, "monthly"),
    "debt_gdp":  ("Public debt to GDP",           "Fiscal",   "%",      -1, "monthly"),
    "debtserv":  ("Debt service to revenue",      "Fiscal",   "%",      -1, "annual"),

    "fed_funds": ("US Fed funds",                 "Global",   "%",       0, "daily"),
    "us10y":     ("US 10-year",                   "Global",   "%",       0, "daily"),
    "world_gdp": ("World growth",                 "Global",   "%",      +1, "annual"),
    "ssa_gdp":   ("Sub-Saharan Africa growth",    "Global",   "%",      +1, "annual"),
}

STALE_DAYS = {"daily": 5, "weekly": 12, "monthly": 45,
              "bi-monthly": 75, "quarterly": 130, "annual": 400}

PRECEDENCE = {
    "inflation": ["cbk", "manual"],
    "cbr": ["cbk"], "kesonia": ["cbk"], "repo": ["cbk"], "discount": ["cbk"],
    # CBK runs the auction, so CBK is asked first and Serrari is the second
    # opinion. Two independent sources is the point: when one goes quiet the
    # other keeps the rate moving, and the disagreement check sees the gap.
    # The offer panel is the auction figure to four decimals and carries its own
    # date; the homepage prints the same number rounded and undated. So the
    # panel leads, the homepage backs it up, Serrari is third.
    "tbill": ["cbkbills", "cbk", "sbills"],
    "tbill182": ["cbkbills", "sbills", "manual"],
    "tbill364": ["cbkbills", "sbills", "manual"], "bond10": ["sbonds", "manual"],
    "infra": ["sbonds", "manual"],
    "lending": ["cbk", "manual"], "savings": ["cbk", "manual"], "deposit": ["cbk", "manual"],
    "mmf_top": ["serrari", "manual"], "mmf_avg": ["serrari", "manual"],
    "npl": ["manual"],
    "pmi": ["te", "manual"], "debt": ["te", "manual"], "gdp": ["te", "manual", "imf"],
    "kes_usd": ["cbk", "fx"], "kes_eur": ["cbk", "fx"], "kes_gbp": ["cbk", "fx"],
    "reserves": ["manual"], "cover": ["manual"],
    "cab": ["manual", "imf"],
    "nasi": ["nse"], "nse20": ["nse"], "nse25": ["nse"],
    "bank_idx": ["nse"], "mktcap": ["nse"],
    "debt_gdp": ["manual", "imf"], "debtserv": ["manual"],
    "fed_funds": ["fred"], "us10y": ["fred"],
    "world_gdp": ["imf"], "ssa_gdp": ["imf"],
}

TOLERANCE = {"gdp": 0.08, "cab": 0.15, "debt_gdp": 0.03, "kes_usd": 0.01,
             "inflation": 0.05, "_default": 0.05}

# Annual World Bank series used only as fallbacks when a typed figure goes
# stale. They are one to two years behind and two of them measure a slightly
# different quantity, which is why they never override a current typed value.
# key: (code, caveat, relabel)
#
# `relabel` is the important column. Two of these fallbacks do not measure the
# same thing as the figure they stand in for — World Bank reserves are total
# rather than the CBK usable figure, and their debt-service series counts
# interest without principal. Substituting them under the original name would
# swap the quantity while keeping the label, which is the precise way a
# dashboard tells a quiet lie. So when the measure changes, the name changes
# with it, and the reader can see that it did.
WB_FALLBACK = {
    "npl":      ("FB.AST.NPER.ZS",    "World Bank annual, same measure", None),
    "cover":    ("FI.RES.TOTL.MO",    "World Bank annual, same measure", None),
    "reserves": ("FI.RES.TOTL.CD",    "World Bank annual — total reserves, which "
                                      "includes gold and SDRs", "Total FX reserves"),
    "debtserv": ("GC.XPN.INTP.RV.ZS", "World Bank annual — interest only, without "
                                      "principal repayment", "Interest to revenue"),
}

WB_CODES = {"gdp_growth": "NY.GDP.MKTP.KD.ZG", "inflation": "FP.CPI.TOTL.ZG",
            "gdp_usd": "NY.GDP.MKTP.CD", "gdp_pc": "NY.GDP.PCAP.CD",
            "exports": "NE.EXP.GNFS.ZS", "imports": "NE.IMP.GNFS.ZS",
            "cab": "BN.CAB.XOKA.GD.ZS", "credit": "FS.AST.PRVT.GD.ZS",
            "reserves": "FI.RES.TOTL.CD", "remit": "BX.TRF.PWKR.CD.DT"}

IMF_KENYA = {"gdp_growth": "NGDP_RPCH", "inflation": "PCPIPCH",
             "debt_gdp": "GGXWDG_NGDP", "cab": "BCA_NGDPD",
             "fiscal_bal": "GGXCNL_NGDP", "gdp_pc": "NGDPDPC"}
IMF_WORLD = {"world": "WEOWORLD", "ssa": "SSA", "us": "USA"}


# ===========================================================================
# SOURCES
# ===========================================================================
def src_cbk():
    """
    One request to the CBK homepage yields the whole Key Rates block plus the
    official indicative currency rates. Ten policy and banking rates from a
    single fetch, which is why the Kenya Bankers Association is not in this
    list: KBRR already sits in this block.

    Dates are captured alongside values because they are not uniform. KBRR in
    particular still carries a 2016 date, and a rate frozen for a decade should
    be labelled, not quietly treated as current.
    """
    out, dates = {}, {}
    try:
        txt = BeautifulSoup(get("https://www.centralbank.go.ke/").text,
                            "lxml").get_text(" ", strip=True)
        m = re.search(r"Key Rates(.{0,700})", txt)
        block = m.group(1) if m else txt

        rates = {
            "cbr":       r"Central Bank Rate\s+([\d.]+)\s*%\s*([\d/A-Za-z,]+)?",
            "kesonia":   r"KESONIA\s+([\d.]+)\s*%\s*([\d/A-Za-z,]+)?",
            "discount":  r"Discount Window\s+([\d.]+)\s*%\s*([\d/A-Za-z,]+)?",
            "tbill":     r"91-Day T-Bill\s+([\d.]+)\s*%\s*([\d/A-Za-z,]+)?",
            "repo":      r"REPO\s+([\d.]+)\s*%\s*([\d/A-Za-z,]+)?",
            "inflation": r"Inflation Rate\s+([\d.]+)\s*%\s*([\d/A-Za-z,]+)?",
            "lending":   r"Lending Rate\s+([\d.]+)\s*%\s*([\d/A-Za-z,]+)?",
            "savings":   r"Savings Rate\s+([\d.]+)\s*%\s*([\d/A-Za-z,]+)?",
            "deposit":   r"Deposit Rate\s+([\d.]+)\s*%\s*([\d/A-Za-z,]+)?",
        }
        for k, pat in rates.items():
            mm = re.search(pat, block)
            if mm:
                out[k] = float(mm.group(1))
                if mm.group(2):
                    dates[k] = mm.group(2)

        fxm = re.search(r"(US DOLLAR.{0,140})", txt)
        if fxm:
            for k, pat in (("kes_usd", r"US DOLLAR\s+([\d.]+)"),
                           ("kes_gbp", r"STG POUND\s+([\d.]+)"),
                           ("kes_eur", r"EURO\s+([\d.]+)")):
                mm = re.search(pat, fxm.group(1))
                if mm:
                    out[k] = float(mm.group(1))
        out["_dates"] = dates
        log(f"    cbk: {len(out)-1} values in one request")
    except Exception as e:
        log(f"    cbk FAILED: {e}")
    return out


def src_nse():
    """The exchange's own statistics table. Primary source, refreshed daily."""
    out = {}
    try:
        txt = BeautifulSoup(get("https://www.nse.co.ke/dataservices/market-statistics/").text,
                            "lxml").get_text(" | ", strip=True)
        for k, pat in (("nasi",     r"NSE ALL SHARE INDEX \| ([\d,]+\.?\d*)"),
                       ("nse20",    r"NSE 20 SHARE INDEX \| ([\d,]+\.?\d*)"),
                       ("nse25",    r"NSE 25 SHARE INDEX \| ([\d,]+\.?\d*)"),
                       ("bank_idx", r"BANKING SECTOR INDEX \| ([\d,]+\.?\d*)"),
                       ("mktcap",   r"MARKET CAPITALIZATION \(Billions\) \| ([\d,]+\.?\d*)")):
            mm = re.search(pat, txt, re.I)
            if mm:
                out[k] = float(mm.group(1).replace(",", ""))
        mm = re.search(r"Statistics as of ([\d]{1,2}-\w{3}-[\d]{4})", txt)
        if mm:
            out["_asof"] = mm.group(1)
        log(f"    nse: {len(out)-1} values, as of {out.get('_asof','?')}")
    except Exception as e:
        log(f"    nse FAILED: {e}")
    return out


def src_fred():
    """
    US policy rate and the 10-year. These matter to Kenya through two channels:
    the sovereign spread that sets what Kenya pays to borrow abroad, and the
    carry that decides whether foreign money stays in Kenyan paper.
    Date-limited so the download is 68 KB rather than 420 KB.
    """
    out = {}
    for key, sid in (("fed_funds", "DFF"), ("us10y", "DGS10")):
        try:
            r = get(f"https://fred.stlouisfed.org/graph/fredgraph.csv"
                    f"?id={sid}&cosd=2015-01-01", plain=True)
            rows = [x for x in csv.reader(io.StringIO(r.text))][1:]
            vals = [(d, float(v)) for d, v in rows if v not in (".", "")]
            if vals:
                out[key] = vals[-1][1]
                out[f"_{key}_asof"] = vals[-1][0]
        except Exception as e:
            log(f"    fred {key}: {e}")
    log(f"    fred: fed {out.get('fed_funds')}, us10y {out.get('us10y')}")
    return out


def src_imf():
    """
    IMF WEO. Kenya's own series plus world, Sub-Saharan Africa and US growth.
    The only free source with forecasts, running to 2031.
    """
    out, spine = {}, {}

    def pull(job):
        key, code, region = job
        try:
            d = get(f"https://www.imf.org/external/datamapper/api/v1/{code}/{region}",
                    plain=True).json()
            ser = d.get("values", {}).get(code, {}).get(region, {})
            ser = {int(y): v for y, v in ser.items() if v is not None}
            return key, dict(sorted(ser.items())) if ser else None
        except Exception as e:
            log(f"    imf {key}: {e}")
            return key, None

    jobs = [(k, c, "KEN") for k, c in IMF_KENYA.items()]
    jobs += [(f"{k}_gdp", "NGDP_RPCH", r) for k, r in IMF_WORLD.items()]
    # Each call takes about ten seconds and they do not depend on one another.
    # Four at a time keeps the run short without leaning on the API.
    with ThreadPoolExecutor(max_workers=4) as pool:
        for key, ser in pool.map(pull, jobs):
            if ser:
                spine[key] = ser

    yr = datetime.now().year
    for skey, ind in (("gdp_growth", "gdp"), ("debt_gdp", "debt_gdp"), ("cab", "cab")):
        if skey in spine and (yr - 1) in spine[skey]:
            out[ind] = spine[skey][yr - 1]
    for skey, ind in (("world_gdp", "world_gdp"), ("ssa_gdp", "ssa_gdp")):
        if skey in spine and yr in spine[skey]:
            out[ind] = spine[skey][yr]

    horizon = max((max(v) for v in spine.values()), default="none")
    log(f"    imf: {len(spine)} series, forecasts to {horizon}")
    return out, spine


def src_worldbank():
    """Annual spine back to 2002. The long memory the app compares against."""
    out, spine = {}, {}

    def pull(item):
        key, code = item
        try:
            rows = get(f"https://api.worldbank.org/v2/country/KEN/indicator/{code}"
                       f"?format=json&per_page=90&date=2002:{datetime.now().year}",
                       plain=True).json()[1] or []
            ser = {int(r["date"]): r["value"] for r in rows if r["value"] is not None}
            return key, dict(sorted(ser.items())) if ser else None
        except Exception as e:
            log(f"    worldbank {key}: {e}")
            return key, None

    jobs = list(WB_CODES.items()) + [(f"fb_{k}", t[0]) for k, t in WB_FALLBACK.items()]
    with ThreadPoolExecutor(max_workers=6) as pool:
        for key, ser in pool.map(pull, jobs):
            if ser:
                spine[key] = ser
    if "gdp_growth" in spine:
        out["gdp"] = list(spine["gdp_growth"].values())[-1]
    log(f"    worldbank: {len(spine)} series")
    return out, spine


def src_serrari():
    """
    Money market fund rates, from Serrari's daily comparison table.

    This closes the last big hole in the ladder. Fund rates were typed by hand
    and went stale fastest of anything — the figure this replaced was 142 days
    old and overstated the best fund by a full percentage point.

    Their published net yields match 15% withholding tax on every fund in the
    table, which independently confirms the tax assumption used here.

    `mmf_top` is the mean of the top quartile rather than the single best fund,
    because one outlier is not an investable strategy and a quartile is.
    """
    out = {}
    try:
        soup = BeautifulSoup(get("https://serrarigroup.com/ke/mmf").text, "lxml")
        table = soup.find("table")
        if table is None:
            raise RuntimeError("comparison table not found")
        rows = table.find_all("tr")
        head = [c.get_text(" ", strip=True).replace("↕", "").replace("↓", "").strip().lower()
                for c in rows[0].find_all(["th", "td"])]

        funds = []
        for r in rows[1:]:
            cells = [c.get_text(" ", strip=True) for c in r.find_all(["td", "th"])]
            if len(cells) < 7:
                continue
            d = dict(zip(head, cells))
            m = re.search(r"([\d.]+)", d.get("annual yield", "") or "")
            if not m:
                continue
            gross = float(m.group(1))
            if not (0 < gross < 40):          # a fund yielding 40% is a parse error
                continue
            funds.append({"name": d.get("fund name") or d.get("company", ""),
                          "gross": gross, "min": d.get("min. investment", "")})

        if len(funds) < 5:
            raise RuntimeError(f"only {len(funds)} funds parsed, table shape may have changed")

        funds.sort(key=lambda f: -f["gross"])
        quartile = funds[:max(1, len(funds) // 4)]
        out["mmf_top"] = round(st.mean(f["gross"] for f in quartile), 2)
        out["mmf_avg"] = round(st.mean(f["gross"] for f in funds), 2)
        out["_best"] = {"name": funds[0]["name"], "gross": funds[0]["gross"],
                        "min": funds[0]["min"], "count": len(funds),
                        "quartileN": len(quartile)}
        log(f"    serrari: {len(funds)} funds · top quartile {out['mmf_top']}% · "
            f"average {out['mmf_avg']}% · best {funds[0]['name'][:28]} {funds[0]['gross']}%")
    except Exception as e:
        log(f"    serrari FAILED: {e}")
    return out


# Trading Economics republishes several Kenyan series and, usefully, puts the
# current figure in the page's meta description as plain prose. No JavaScript,
# no key, one request each.
#
# Only three are taken. The others on that site look tempting and are not:
# their FX reserves are gross official reserves including gold and SDRs, which
# is a different quantity from the CBK usable figure this app tracks, and their
# debt-to-GDP and current account are annual where this app wants the latest
# monthly or quarterly reading. Adopting a number because it shares a name with
# the one you want is how a dashboard starts lying quietly.
TE = {
    "pmi": ("manufacturing-pmi",
            r"Manufacturing PMI in Kenya[^\d]{0,40}([\d.]+)\s*points in (\w+)"
            r".*?of (\d{4})", 1.0),
    "debt": ("government-debt",
             r"Government Debt in Kenya[^\d]{0,40}([\d,.]+)\s*KES Billion in (\w+)"
             r".*?of (\d{4})", 0.001),          # billions → trillions
    "gdp": ("gdp-growth-annual",
            r"Gross Domestic Product \(GDP\) in Kenya\s+\w+\s+([\d.]+)\s*percent"
            r" in the (\w+) quarter of (\d{4})", 1.0),
}
MONTH_NUM = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], 1)}
QUARTER_END = {"first": "03-31", "second": "06-30", "third": "09-30", "fourth": "12-31"}


def _find_table(soup, *required):
    """
    Locate a table by what its header says rather than by position. Tables get
    added and reordered; a header called 'YTM %' means the same thing wherever
    it sits on the page.
    """
    for t in soup.find_all("table"):
        rows = t.find_all("tr")
        if len(rows) < 3:
            continue
        head = [c.get_text(" ", strip=True).replace("↕", "").replace("↓", "")
                .strip().lower() for c in rows[0].find_all(["th", "td"])]
        if all(any(r in h for h in head) for r in required):
            return head, rows[1:]
    return None, []


def src_serrari_bonds():
    """
    Treasury bond yields, from Serrari's live comparison of 77 issues.

    The `Type` column separates government from infrastructure paper, which is
    the distinction that matters here: infrastructure bonds are tax-exempt and
    sit at the top of the ladder because of it.

    A ten-year yield is taken as the median of everything maturing eight to
    twelve years out, rather than a single issue. One bond can be illiquid or
    oddly priced; a bucket cannot.
    """
    out = {}
    try:
        soup = BeautifulSoup(get("https://serrarigroup.com/ke/bonds").text, "lxml")
        head, rows = _find_table(soup, "ytm", "maturity", "type")
        if not rows:
            raise RuntimeError("yield table not found")
        today = datetime.now(timezone.utc).date()
        bonds = []
        for r in rows:
            cells = [c.get_text(" ", strip=True) for c in r.find_all(["td", "th"])]
            if len(cells) < len(head):
                continue
            d = dict(zip(head, cells))
            m = re.search(r"([\d.]+)", d.get("ytm %", ""))
            try:
                mat = datetime.fromisoformat(d.get("maturity", "")[:10]).date()
            except ValueError:
                continue
            if not m:
                continue
            ytm = float(m.group(1))
            if not (0 < ytm < 40):
                continue
            bonds.append({"ytm": ytm, "type": (d.get("type") or "").lower(),
                          "years": (mat - today).days / 365.25})
        if len(bonds) < 10:
            raise RuntimeError(f"only {len(bonds)} bonds parsed")

        def tenyear(kind):
            band = [b["ytm"] for b in bonds if b["type"] == kind and 8 <= b["years"] <= 12]
            if len(band) < 2:                       # widen once rather than guess
                band = [b["ytm"] for b in bonds if b["type"] == kind and 5 <= b["years"] <= 15]
            return round(st.median(band), 2) if band else None

        for key, kind in (("bond10", "gov"), ("infra", "infra")):
            v = tenyear(kind)
            if v is not None:
                out[key] = v
        log(f"    serrari bonds: {len(bonds)} issues · 10yr gov {out.get('bond10')}% "
            f"· infra {out.get('infra')}%")
    except Exception as e:
        # Nothing, not the half of it that parsed before the failure. A partly
        # read table hands back numbers from the wrong columns, and a plausible
        # wrong number beats a missing one straight into the ladder.
        log(f"    serrari bonds FAILED: {e}")
        return {}
    return out


CBK_BILLS = "https://www.centralbank.go.ke/bills-bonds/treasury-bills/"


def _parse_date(raw):
    """A date in whatever shape the page felt like. ISO out, or None.

    CBK writes dates several ways across its own pages, and a wrong guess here
    is worse than no date: it would make a stale auction look fresh."""
    if not raw:
        return None
    raw = re.sub(r"\s+", " ", str(raw)).strip()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if m:
        try:
            return datetime(*(int(x) for x in m.groups())).date().isoformat()
        except ValueError:
            return None
    # 16/07/2026 or 16-07-2026, day first, which is how Kenya writes them
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", raw)
    if m:
        d, mo, y = (int(x) for x in m.groups())
        y = y + 2000 if y < 100 else y
        try:
            return datetime(y, mo, d).date().isoformat()
        except ValueError:
            return None
    # 16 Jul 2026 / 16 July 2026 / 3rd September 2026
    raw = re.sub(r"(\d{1,2})(st|nd|rd|th)\b", r"\1", raw, flags=re.I)
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})", raw)
    if m:
        months = {mn: i for i, mn in enumerate(
            ["jan", "feb", "mar", "apr", "may", "jun",
             "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
        mo = months.get(m.group(2)[:3].lower())
        if mo:
            try:
                return datetime(int(m.group(3)), mo, int(m.group(1))).date().isoformat()
            except ValueError:
                return None
    return None


def _rate(raw):
    """A percentage out of a cell, or None. Rejects anything outside the range a
    Treasury bill can plausibly pay, because a mis-read column is far more
    likely than a 300% bill."""
    if raw is None:
        return None
    # The whole number, then a range check. Matching only the first digit or
    # two would read "300" as 30 and wave a nonsense rate straight through -
    # silently wrong is the one outcome this file exists to prevent.
    m = re.search(r"(\d+(?:\.\d+)?)", str(raw).replace(",", ""))
    if not m:
        return None
    v = float(m.group(1))
    return v if 0 < v < 40 else None


def src_cbk_bills():
    """
    Treasury bill rates, from the "Treasury Bills on Offer" panel on CBK's own
    bills page.

    Not from a table. The page carries eight of them and none holds the current
    rates: there is an offer/maturity calendar, three enormous auction result
    archives keyed by issue number, a twelve-row sample of 91-day results from
    2016, a 4,500-row OTC deal blotter, and two re-discount calculators. The
    first version of this function searched for a table with a tenor column and
    a rate column, found the 2016 sample, and reported a ten-year-old rate as
    current.

    The figures are in a text panel instead, one column per tenor:

        91-DAY
        Issue Number: 2698/091
        Auction Date: 3rd September 2026
        Value Dated: 7th September 2026
        Previous Average Interest Rate: 8.7692%

    which is read the way src_cbk reads the homepage's Key Rates block: by
    regular expression over the page's text, anchored on the tenor headings.

    One honesty note carried into the date. The rate shown is the *previous*
    auction's average, while the date shown is the auction now on offer. Bills
    auction weekly, so the reading is dated a week before the offer rather than
    on it. Overstating freshness by a week is exactly the error that let a
    frozen 182-day rate sit unnoticed.
    """
    out = {}
    TENORS = (("91", "tbill"), ("182", "tbill182"), ("364", "tbill364"))
    try:
        txt = BeautifulSoup(get(CBK_BILLS).text, "lxml").get_text(" ", strip=True)
        m = re.search(r"Treasury Bills on Offer(.{0,1600})", txt, re.I | re.S)
        if not m:
            raise RuntimeError("the 'Treasury Bills on Offer' panel is not on the page")
        block = m.group(1)

        offers = []
        for days, key in TENORS:
            # from this tenor's heading up to the next one, so a rate can never
            # be read out of a neighbouring column
            seg = re.search(rf"\b{days}\s*-?\s*DAY\b(.*?)(?=\b(?:91|182|364)\s*-?\s*DAY\b|$)",
                            block, re.I | re.S)
            if not seg:
                continue
            body = seg.group(1)
            rate = re.search(r"Average\s+Interest\s+Rate\s*:?\s*([\d.]+)\s*%", body, re.I)
            if not rate:
                continue
            v = _rate(rate.group(1))
            if v is None:
                continue
            out[key] = v
            auc = re.search(r"Auction\s+Date\s*:?\s*([0-9]{1,2}[a-z]{0,2}\s+[A-Za-z]+\s+[0-9]{4})",
                            body, re.I)
            when = _parse_date(auc.group(1)) if auc else None
            if when:
                offers.append(when)

        if not out:
            raise RuntimeError(
                "found the panel but no rates in it; first 200 characters: "
                + re.sub(r"\s+", " ", block[:200]))

        if offers:
            # the rate belongs to the auction before the one on offer
            newest = max(offers)
            out["_asof"] = (datetime.fromisoformat(newest).date()
                            - timedelta(days=7)).isoformat()
        else:
            raise RuntimeError(
                "read rates but no auction date, so their age cannot be judged: "
                + ", ".join(f"{k}={v}" for k, v in out.items()))

        # Found something is not the same as found the right thing. A bill
        # auctions weekly, so a date a year out proves the match is wrong, and
        # the parse is discarded rather than trusted.
        age = (datetime.now(timezone.utc).date()
               - datetime.fromisoformat(out["_asof"]).date()).days
        if age > 400 or age < -9:
            raise RuntimeError(
                f"panel dated {out['_asof']} ({age} days) cannot be a current auction. "
                "Values discarded: "
                + ", ".join(f"{k}={v}" for k, v in out.items() if k != "_asof"))

        missing = [d for d, k in TENORS if k not in out]
        if missing:
            log(f"    cbk bills: {', '.join(missing)}-day not in the offer panel")
        log(f"    cbk bills: 91d {out.get('tbill')}% · 182d {out.get('tbill182')}% "
            f"· 364d {out.get('tbill364')}% · auction {out.get('_asof', '?')}")
    except Exception as e:
        # Nothing, not the half that parsed before the failure.
        log(f"    cbk bills FAILED: {e}")
        return {}
    return out


def src_serrari_bills():
    """Treasury bill auction results — the 182 and 364-day tenors, which the
    CBK front page does not carry. The 91-day comes from CBK, which is fresher."""
    out = {}
    try:
        soup = BeautifulSoup(get("https://serrarigroup.com/ke/tbills").text, "lxml")
        head, rows = _find_table(soup, "tenor", "avg rate")
        if not rows:
            raise RuntimeError("auction table not found")
        for r in rows:
            cells = [c.get_text(" ", strip=True) for c in r.find_all(["td", "th"])]
            if len(cells) < len(head):
                continue
            d = dict(zip(head, cells))
            tenor = re.search(r"(91|182|364)", d.get("tenor", "") or "")
            rate = re.search(r"([\d.]+)", d.get("avg rate", "") or "")
            if not (tenor and rate):
                continue
            v = float(rate.group(1))
            if not (0 < v < 40):
                continue
            key = {"91": "tbill", "182": "tbill182", "364": "tbill364"}[tenor.group(1)]
            out[key] = v
            date_m = re.search(r"(\d{4}-\d{2}-\d{2})", d.get("auction date", "") or "")
            if date_m:
                out["_asof"] = date_m.group(1)
        log(f"    serrari bills: 182d {out.get('tbill182')}% · 364d {out.get('tbill364')}% "
            f"· auction {out.get('_asof', '?')}")
    except Exception as e:
        # Nothing, not the half of it that parsed before the failure. A partly
        # read table hands back numbers from the wrong columns, and a plausible
        # wrong number beats a missing one straight into the ladder.
        log(f"    serrari bills FAILED: {e}")
        return {}
    return out


def src_te():
    """PMI, the debt stock and quarterly GDP, from Trading Economics."""
    out, dates = {}, {}
    for key, (slug, pattern, scale) in TE.items():
        try:
            html = get(f"https://tradingeconomics.com/kenya/{slug}").text
            desc = ""
            for m in re.finditer(r'<meta[^>]+name=["\']description["\'][^>]*'
                                 r'content=["\']([^"\']+)', html):
                desc = m.group(1)
                break
            if not desc:
                raise RuntimeError("no description on the page")
            mm = re.search(pattern, desc)
            if not mm:
                raise RuntimeError("figure not found in the description")
            value = float(mm.group(1).replace(",", "")) * scale
            period, year = mm.group(2).lower(), mm.group(3)
            if period in QUARTER_END:
                dates[key] = f"{year}-{QUARTER_END[period]}"
            elif period in MONTH_NUM:
                mnum = MONTH_NUM[period]
                nxt = datetime(int(year) + (mnum == 12), (mnum % 12) + 1, 1)
                dates[key] = (nxt - timedelta(days=1)).date().isoformat()
            value, problem = parse_number(str(round(value, 4)), key)
            if problem:
                log(f"    te {key}: {problem}")
                continue
            out[key] = value
        except Exception as e:
            log(f"    te {key}: {e}")
    log(f"    trading economics: {len(out)} values {dict(out)}")
    return out, dates


def src_fx():
    """Fallback currency crosses for the pairs CBK does not post."""
    out = {}
    try:
        d = get("https://open.er-api.com/v6/latest/USD", plain=True).json()
        kes = d["rates"]["KES"]
        out["kes_usd"] = round(kes, 2)
        for cur, key in (("EUR", "kes_eur"), ("GBP", "kes_gbp"),
                         ("CHF", "kes_chf"), ("CNY", "kes_cny")):
            if d["rates"].get(cur):
                out[key] = round(kes / d["rates"][cur], 2)
    except Exception as e:
        log(f"    fx FAILED: {e}")
    return out


# How old a typed figure may be before it stops being current. A rate you last
# checked in March is not a rate, it is a memory.
MANUAL_CADENCE = {
    # inflation is scraped from CBK and mmf_* from Serrari, so neither appears here
    # Cycle PLUS publication lag, not cycle alone. Quarterly GDP is not
    # published the day the quarter ends - KNBS releases it about three months
    # later - so a 155-day-old GDP reading is a normal one, and flagging it
    # taught the reader to ignore the flag. The threshold is what "overdue"
    # actually means for each series: how long after which a figure of this
    # kind genuinely should have been replaced.
    "pmi": 45,            # monthly, out in the first week of the next month
    "npl": 90,            # monthly, CBK bank supervision runs a month or two behind
    "reserves": 21, "cover": 21,          # weekly, CBK publishes on Thursdays
    # The 182-day auctions weekly. Letting a typed one stand for three weeks
    # meant three missed auctions could pass without the app saying a word.
    "tbill182": 10, "tbill364": 45, "bond10": 45, "infra": 45,
    "debt": 120,          # monthly, Treasury publishes a couple of months back
    "debt_gdp": 200,      # quarterly in practice, and lags the debt stock
    "gdp": 200,           # quarterly, KNBS about three months behind the quarter
    "cab": 200,           # quarterly balance of payments, same shape
    "debtserv": 400,      # annual
}


# A published Google Sheet, read as CSV. No key, no OAuth, no service account —
# publishing to the web makes it readable by anyone with the link, which is fine
# for figures the government already published.
#
# Set KP_SHEET to the sheet id, or leave it blank to use manual.json instead.
SHEET_ID = os.environ.get("KP_SHEET", "").strip()
SHEET_TAB = os.environ.get("KP_SHEET_TAB", "").strip()   # optional gid

# What each figure could plausibly be. A typed number outside its range is far
# more likely a slip than a real reading, and a wrong rate here corrupts the
# ladder silently — which is worse than a missing one.
PLAUSIBLE = {
    "npl": (0, 60), "pmi": (20, 80),
    "lending": (0, 40), "reserves": (0, 60), "cover": (0, 24),
    "cab": (-30, 20), "gdp": (-20, 25), "debt": (0, 100), "debt_gdp": (0, 250),
    "debtserv": (0, 200), "tbill": (0, 40), "tbill182": (0, 40), "tbill364": (0, 40),
    "bond10": (0, 40), "infra": (0, 40), "mmf_top": (0, 40), "mmf_avg": (0, 40),
}


def parse_number(raw, key):
    """
    Turn a typed cell into a number, or say why it cannot.

    Commas are the trap. '4,047' is four thousand; '12,80' is somebody typing a
    decimal comma. Stripping both gives 1280, and a bond at 1280% would sail
    through every other check in this file. So a comma is only removed when it
    genuinely separates groups of three.
    """
    t = raw.replace("%", "").replace(" ", "").strip()
    if "," in t:
        if re.fullmatch(r"-?\d{1,3}(,\d{3})+(\.\d+)?", t):
            t = t.replace(",", "")                      # 4,047.48 → 4047.48
        else:
            return None, f"{key}: '{raw}' — ambiguous comma, use a full stop"
    try:
        v = float(t)
    except ValueError:
        return None, f"{key}: '{raw}' is not a number"
    lo, hi = PLAUSIBLE.get(key, (float("-inf"), float("inf")))
    if not (lo <= v <= hi):
        return None, f"{key}: {v:g} is outside the plausible range {lo}–{hi}"
    return v, None


def src_sheet():
    """
    Twelve numbers a month is tabular data, so it belongs in a table rather than
    in hand-edited JSON over SSH. Edit it in the Sheets app on the phone; the
    collector reads it on the next run.

    Expected columns, header row required, order and case unimportant:

        key        value    asOf          notes
        mmf_top    12.10    2026-08-01    ICEA LION Money Market
        inflation  6.49     2026-07-31    KNBS release

    Unknown keys are ignored, so notes rows and blank lines cost nothing. A row
    with a bad number or an unreadable date is skipped and reported rather than
    silently poisoning the ladder.
    """
    if not SHEET_ID:
        return {}, {}, []
    url = (f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv"
           + (f"&gid={SHEET_TAB}" if SHEET_TAB else ""))
    try:
        text = get(url, plain=True).text
    except Exception as e:
        log(f"    sheet unreachable: {e}")
        return {}, {}, [f"sheet unreachable: {e}"]

    out, dates, problems = {}, {}, []
    try:
        rows = list(csv.DictReader(io.StringIO(text)))
    except Exception as e:
        return {}, {}, [f"sheet unparseable: {e}"]

    for row in rows:
        clean = {(k or "").strip().lower(): (v or "").strip()
                 for k, v in row.items() if k}
        key = clean.get("key", "")
        if not key or key.startswith("#"):
            continue
        raw = clean.get("value", "")
        if raw == "":
            continue
        value, problem = parse_number(raw, key)
        if problem:
            problems.append(problem)
            continue
        out[key] = value
        d = clean.get("asof") or clean.get("as of") or clean.get("date") or ""
        if d:
            try:
                dates[key] = datetime.fromisoformat(d[:10]).date().isoformat()
            except ValueError:
                problems.append(f"{key}: date '{d}' unreadable")
    log(f"    sheet: {len(out)} values, {len(dates)} dated"
        + (f", {len(problems)} problems" if problems else ""))
    for p in problems:
        log(f"      ! {p}")
    return out, dates, problems


def src_manual():
    """
    What only exists inside a PDF or behind a paywall: the Stanbic PMI, the
    longer bills, the 10-year bond, NPLs, reserves, the debt stock, quarterly
    GDP and your own money market rate.

    Each entry may carry the date it was published:

        "mmf_top": {"value": 12.10, "asOf": "2026-08-01"}

    A bare number still works but counts as undated, and undated is treated as
    stale. Six of the ten rungs on the ladder come from this file, and a
    confidently wrong ladder is worse than no ladder at all.
    """
    if not os.path.exists(MANUAL):
        return {}, {}
    try:
        raw = json.load(open(MANUAL))
        out, dates = {}, {}
        for k, v in raw.items():
            if k.startswith("_"):
                continue
            raw = v["value"] if isinstance(v, dict) and "value" in v else v
            value, problem = parse_number(str(raw), k)
            if problem:
                log(f"      ! {problem}")
                continue
            out[k] = value
            if isinstance(v, dict) and v.get("asOf"):
                dates[k] = v["asOf"]
        undated = [k for k in out if k not in dates]
        log(f"    manual: {len(out)} typed values, {len(undated)} undated")
        return out, dates
    except Exception as e:
        log(f"    manual.json unreadable: {e}")
        return {}, {}


def manual_freshness(dates):
    """
    Age each figure against its own publication cadence.

    Anything outside MANUAL_CADENCE has a live source — inflation from CBK,
    money market rates from Serrari — so it carries its date but can never be
    stale. It refreshes itself.
    """
    today = datetime.now(timezone.utc).date()
    out = {}
    for k, d in dates.items():
        if k in MANUAL_CADENCE:
            continue
        try:
            age = (today - datetime.fromisoformat(d[:10]).date()).days
        except Exception:
            age = None
        out[k] = {"asOf": d, "ageDays": age, "stale": False, "why": "live source"}
    for k, cadence in MANUAL_CADENCE.items():
        d = dates.get(k)
        if not d:
            out[k] = {"asOf": None, "ageDays": None, "stale": True,
                      "why": "no date recorded"}
            continue
        try:
            age = (today - datetime.fromisoformat(d).date()).days
        except Exception:
            out[k] = {"asOf": d, "ageDays": None, "stale": True,
                      "why": "date unreadable"}
            continue
        out[k] = {"asOf": d, "ageDays": age, "stale": age > cadence,
                  "why": f"{age} days old, expected within {cadence}"}
    return out


# ===========================================================================
# RECONCILIATION
# ===========================================================================
# When a typed figure has gone past its own release cycle, an automatic source
# — even an annual one — is more honest than a number nobody has touched in
# months. The substitution is only ever made in that direction, and the app is
# told, so a lagging annual figure is never dressed up as this month's reading.
def apply_fallbacks(values, prov, fresh, spine):
    used = []
    for key, (code, caveat, relabel) in WB_FALLBACK.items():
        series = spine.get(f"fb_{key}")
        if not series:
            continue
        f = fresh.get(key, {})
        typed_ok = values.get(key) is not None and not f.get("stale", True)
        if typed_ok:
            continue
        year = max(series)
        v = series[year] / 1e9 if key == "reserves" else series[year]
        values[key] = round(v, 3)
        prov[key] = "worldbank"
        fresh[key] = {"asOf": f"{year}-12-31", "ageDays": None, "stale": False,
                      "why": f"fell back to {caveat}"}
        used.append({"id": key, "year": year, "value": round(v, 3),
                     "caveat": caveat, "relabel": relabel})
    return used


def reconcile(by_source):
    """
    Highest-ranked source that holds the number wins. The loser is recorded,
    not discarded. Nothing is averaged: averaging two vintages produces a third
    figure nobody published, which is worse than either.
    """
    values, prov, disagree = {}, {}, []
    ids = {k for d in by_source.values() for k in d if not k.startswith("_")}
    for ind in ids:
        order = PRECEDENCE.get(ind, sorted(by_source))
        have = [(s, by_source[s][ind]) for s in order
                if isinstance(by_source.get(s, {}).get(ind), (int, float))]
        have += [(s, d[ind]) for s, d in by_source.items()
                 if s not in order and isinstance(d.get(ind), (int, float))]
        if not have:
            continue
        win_src, win_val = have[0]
        values[ind], prov[ind] = win_val, win_src
        tol = TOLERANCE.get(ind, TOLERANCE["_default"])
        for s, v in have[1:]:
            gap = abs(v - win_val) / (abs(win_val) or 1)
            if gap > tol:
                disagree.append({"id": ind, "label": REGISTER.get(ind, (ind,))[0],
                                 "kept": win_src, "keptValue": round(win_val, 3),
                                 "other": s, "otherValue": round(v, 3),
                                 "gapPct": round(gap * 100, 1)})
    return values, prov, disagree


def load_state():
    if os.path.exists(STATE):
        try:
            return json.load(open(STATE))
        except (OSError, ValueError) as e:
            log(f"  state file unreadable, starting fresh: {e}")
    return {"lastGood": {}, "seenAt": {}}


def carry_forward(values, prov, state):
    """A source going down must never blank an indicator. Carry the last good
    reading and label its age. A gap in a chart is a lie."""
    today = datetime.now(timezone.utc).date()
    carried = []
    for ind, (label, group, unit, direction, freq) in REGISTER.items():
        if values.get(ind) is not None:
            state["lastGood"][ind] = values[ind]
            state["seenAt"][ind] = today.isoformat()
            continue
        lg = state["lastGood"].get(ind)
        if lg is None:
            continue
        seen = state["seenAt"].get(ind)
        age = (today - datetime.fromisoformat(seen).date()).days if seen else 999
        values[ind], prov[ind] = lg, "carried"
        carried.append({"id": ind, "label": label, "ageDays": age,
                        "stale": age > STALE_DAYS.get(freq, 60)})
    return carried


# ===========================================================================
# LAYER 1 — THE LADDER
# ===========================================================================
# Kenyan withholding tax on interest, resident individuals. These are defaults;
# the app lets you override all three, so the ladder you see is computed there. The tax firms
# (EY, Cliffe Dekker, FNJ) agree on 15% for bills and short bonds, 10% for
# bonds of ten years or more, and full exemption for infrastructure bonds.
# One retail aggregator claims bills are exempt for individuals; no tax
# practice corroborates it, so 15% is used and the claim is surfaced in the
# app as a disagreement rather than silently resolved.
TAX = {"tbill": 0.15, "tbill182": 0.15, "tbill364": 0.15, "bond10": 0.10,
       "infra": 0.00, "mmf": 0.15, "deposit": 0.15, "savings": 0.15,
       "dividend": 0.05, "cash": 0.0}


def build_ladder(v, fresh=None):
    """
    After-tax real return on everything you could hold. Nominal yield is the
    energy, inflation is the entropy, what survives is the bar.

    Every rung carries the age of the rate behind it. Six of the ten come from
    a file you type by hand, so a rung with no date, or a date two months old,
    is marked rather than quietly ranked alongside a rate scraped this morning.
    Nothing here is a recommendation: it is arithmetic on published rates.
    """
    tax, fresh = TAX, fresh or {}
    infl = v.get("inflation")
    if infl is None:
        return []

    rows = [
        ("infra",    "Infrastructure bond",  v.get("infra"),    tax["infra"],    "tax-exempt"),
        ("bond10",   "10-year bond",         v.get("bond10"),   tax["bond10"],   "10% WHT"),
        ("mmf_top",  "Top-quartile MMF",     v.get("mmf_top"),  tax["mmf"],      "15% WHT"),
        ("mmf_avg",  "MMF industry average", v.get("mmf_avg"),  tax["mmf"],      "15% WHT"),
        ("tbill364", "364-day bill",         v.get("tbill364"), tax["tbill364"], "15% WHT"),
        ("tbill182", "182-day bill",         v.get("tbill182"), tax["tbill182"], "15% WHT"),
        ("tbill",    "91-day bill",          v.get("tbill"),    tax["tbill"],    "15% WHT"),
        ("deposit",  "Bank fixed deposit",   v.get("deposit"),  tax["deposit"],  "15% WHT"),
        ("savings",  "Bank savings account", v.get("savings"),  tax["savings"],  "15% WHT"),
        ("cash",     "Cash",                 0.0,               0.0,             "no tax, no yield"),
    ]
    out = []
    for rid, label, gross, t, note in rows:
        if gross is None:
            continue
        net = gross * (1 - t)
        real = net - infl
        f = fresh.get(rid, {})
        out.append({"id": rid, "label": label, "gross": round(gross, 2),
                    "taxPct": round(t * 100), "net": round(net, 2),
                    "real": round(real, 2), "note": note,
                    "doublingYears": round(72 / real, 1) if real > 0.05 else None,
                    "asOf": f.get("asOf"), "ageDays": f.get("ageDays"),
                    "stale": bool(f.get("stale")) if rid != "cash" else False,
                    "typed": rid in MANUAL_CADENCE})
    out.sort(key=lambda r: -r["real"])
    return out


# ===========================================================================
# LAYER 2 — THE CHAIN
# ===========================================================================
# Kenya's monetary transmission, with the lags the CBK's own research puts on
# each link. The point is not precision. It is that a move already visible at
# one end has not yet shown up at the other, and that gap is knowable.
CHAIN = [
    ("cbr",       "Policy rate",      0,  "The MPC decides"),
    ("kesonia",   "Overnight money",  0,  "Follows the policy rate within days"),
    ("tbill",     "91-day bill",      1,  "The market's first opinion on policy"),
    ("lending",   "Lending rate",     5,  "Banks reprice slowly and downward last"),
    ("gdp",       "GDP growth",      11,  "Activity follows the cost of borrowing, at a long remove"),
]


def build_chain(v, hist):
    """
    Walk the chain and mark, at each link, whether it has already moved in
    response to the link before it. A link that has not yet moved is the part
    of the story that has not been priced.

    On a fresh install there is no log to compare against. That is reported as
    'waiting', not as 'has not moved' — an absence of evidence dressed up as a
    signal is the single easiest way to make a dashboard lie.
    """
    out = []
    for ind, label, lag, why in CHAIN:
        cur = v.get(ind)
        if cur is None:
            continue
        past = [h["values"][ind] for h in hist
                if isinstance(h.get("values", {}).get(ind), (int, float))]
        trend, status = None, "waiting"
        if len(past) >= 3:
            trend = round(past[-1] - past[max(0, len(past) - 6)], 2)
            status = "moved" if abs(trend) > 0.05 else "still"
        out.append({"id": ind, "label": label, "lagMonths": lag, "why": why,
                    "value": round(cur, 2), "move": trend, "status": status,
                    "readings": len(past)})
    return out


# ===========================================================================
# LAYER 3 — THE BREAKS
# ===========================================================================
# Each relationship is defined once: how to compute it, a fallback range taken
# from published Kenyan history, and what a reading outside that range means.
# The fallback is a judgement. Once the log holds enough observations the range
# is computed from the data instead, and the app says which it is showing.
BREAK_SPECS = [
    {
        "name": "Bank margin over policy", "unit": "pp", "fallback": (3.5, 5.5),
        "calc": lambda v, s: (v["lending"] - v["cbr"])
            if v.get("lending") is not None and v.get("cbr") is not None else None,
        "why": "Average lending rate less the Central Bank Rate.",
        "hi": "Banks are holding spreads wide while policy eases. Transmission is "
              "incomplete, so more of the cut has yet to reach borrowers — and more "
              "of the fall in lending rates is still to come.",
        "lo": "Spreads are unusually thin. Bank margins are being squeezed.",
    },
    {
        "name": "91-day over policy", "unit": "pp", "fallback": (-1.0, 0.75),
        "calc": lambda v, s: (v["tbill"] - v["cbr"])
            if v.get("tbill") is not None and v.get("cbr") is not None else None,
        "why": "91-day bill less the Central Bank Rate.",
        "hi": "The market is demanding more than policy to fund the state. Either "
              "supply pressure or a view that the easing cycle is finished.",
        "lo": "Bills are trading below policy. The market expects further cuts.",
    },
    {
        "name": "Sovereign spread", "unit": "pp", "fallback": (7.0, 11.0),
        "calc": lambda v, s: (v["bond10"] - v["us10y"])
            if v.get("bond10") is not None and v.get("us10y") is not None else None,
        "why": "Kenya 10-year less the US 10-year.",
        "hi": "Kenya is paying an unusually large premium over the risk-free world. "
              "Foreign money is being paid well to stay, and the state is paying "
              "dearly to borrow.",
        "lo": "The premium is thin by Kenyan standards. Foreign appetite is strong, "
              "which is pleasant while it lasts and reverses quickly when it does not.",
    },
    {
        "name": "Real deposit rate", "unit": "pp", "fallback": (-1.0, 2.0),
        "calc": lambda v, s: (v["deposit"] - v["inflation"])
            if v.get("deposit") is not None and v.get("inflation") is not None else None,
        "why": "Average deposit rate less headline inflation.",
        "hi": "Banks are paying savers well above inflation, which is rare and does "
              "not usually last.",
        "lo": "Bank deposits are losing purchasing power. Money sitting in a bank is "
              "being taxed by inflation.",
    },
    {
        "name": "Market cap to GDP", "unit": "%", "fallback": (15.0, 30.0),
        "calc": lambda v, s: (v["mktcap"] / (list(s["gdp_usd"].values())[-1] / 1e9
                              * v["kes_usd"]) * 100)
            if v.get("mktcap") and v.get("kes_usd") and s.get("gdp_usd") else None,
        "why": "NSE market capitalisation as a share of GDP.",
        "hi": "The market is large against the economy behind it. Re-ratings from "
              "here have historically needed earnings to arrive.",
        "lo": "The market is small against the economy. Historically where the good "
              "entry points have been.",
    },
    {
        "name": "Overnight against policy", "unit": "pp", "fallback": (-0.5, 0.5),
        "calc": lambda v, s: (v["kesonia"] - v["cbr"])
            if v.get("kesonia") is not None and v.get("cbr") is not None else None,
        "why": "KESONIA less the Central Bank Rate.",
        "hi": "Overnight money is trading above policy. Liquidity is tight.",
        "lo": "Overnight money is below policy. The system is flush.",
    },
]

DERIVE_MIN = 24          # observations before a computed range is trustworthy


def percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def build_breaks(v, spine, hist):
    """
    Relationships that normally hold, and where they sit now. A ratio inside its
    usual range tells you nothing. One outside it is either a mispricing or a
    regime change, and both are worth knowing before everyone else.

    The range is computed from this system's own logged history once there are
    enough observations — the 10th to 90th percentile of what has actually been
    seen. Until then it falls back to a range read off published Kenyan history,
    and says so. An app whose headline claim is "this is mispriced" owes you the
    provenance of the yardstick.
    """
    out = []
    for spec in BREAK_SPECS:
        try:
            value = spec["calc"](v, spine)
        except Exception:
            value = None
        if value is None:
            continue

        # A historical row missing an input simply has no value for this
        # relationship. Expected as the log fills in, not an error.
        past = []
        for h in hist:
            try:
                x = spec["calc"](h.get("values", {}), spine)
            except (KeyError, TypeError, ZeroDivisionError):
                continue
            if x is not None:
                past.append(x)

        if len(past) >= DERIVE_MIN:
            sp = sorted(past)
            lo, hi = percentile(sp, 0.10), percentile(sp, 0.90)
            basis, n = "derived", len(past)
        else:
            lo, hi = spec["fallback"]
            basis, n = "judgement", len(past)

        if value > hi:
            state, reading = "high", spec["hi"]
        elif value < lo:
            state, reading = "low", spec["lo"]
        else:
            state, reading = "normal", "Inside its usual range."

        out.append({"name": spec["name"], "value": round(value, 2),
                    "unit": spec["unit"], "normalLo": round(lo, 2),
                    "normalHi": round(hi, 2), "state": state, "reading": reading,
                    "why": spec["why"], "basis": basis, "n": n,
                    "basisNote": (f"Range is the 10th to 90th percentile of {n} "
                                  f"readings this system has logged.")
                                 if basis == "derived" else
                                 (f"Range read off published Kenyan history, not yet "
                                  f"computed. {n} of {DERIVE_MIN} readings logged.")})
    return out


def build_call(ladder, chain, breaks):
    """
    One paragraph tying the three layers together. The thing to read first.

    There is deliberately no single score. A composite that weights the currency
    the same as debt service is not measuring anything; it just feels like it is.
    """
    L = []
    if ladder:
        top = ladder[0]
        pos = [r for r in ladder if r["real"] > 0]
        L.append(f"Real yields are {'positive' if len(pos) > len(ladder)/2 else 'thin'}: "
                 f"{len(pos)} of {len(ladder)} instruments beat inflation after tax. "
                 f"{top['label']} leads at {top['real']:+.2f}% real.")
        losing = [r for r in ladder if r["real"] < 0]
        if losing:
            L.append(f"{len(losing)} lose purchasing power, worst being "
                     f"{losing[-1]['label'].lower()} at {losing[-1]['real']:+.2f}%.")
    still = [c for c in chain if c["status"] == "still"]
    waiting = [c for c in chain if c["status"] == "waiting"]
    if still:
        L.append("Holding still in the chain: " +
                 ", ".join(c["label"].lower() for c in still) +
                 " — that is the part not yet priced.")
    elif waiting:
        L.append(f"The chain needs {3 - max((c['readings'] for c in waiting), default=0)} "
                 f"more readings before it can show movement.")
    off = [b for b in breaks if b["state"] != "normal"]
    if off:
        L.append("Outside their usual range: " +
                 ", ".join(f"{b['name'].lower()} at {b['value']}{b['unit']}"
                           for b in off[:3]) + ".")
    return " ".join(L)


# ===========================================================================
# SCORING
# ===========================================================================
def read_log(limit=400):
    if not os.path.exists(LOG):
        return []
    rows, skipped = [], 0
    with open(LOG) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    skipped += 1
    if skipped:
        log(f"  history: skipped {skipped} malformed lines")
    return rows[-limit:]


def distinct_levels(seq):
    """Collapse runs of identical readings.

    History is kept one row per collection run, so how often the collector runs
    decides how many points a sparkline has. At twice a month, twenty-four
    points of inflation was two years of monthly prints. Run it daily and the
    same twenty-four points become three and a half weeks of a figure that only
    moves monthly - a dead flat line about a series that moves all the time.

    Collapsing repeats makes the line mean "the levels this has taken" rather
    than "the times we happened to look", which is both more useful and immune
    to the schedule.
    """
    out = []
    for v in seq:
        if not out or abs(out[-1] - v) > 1e-9:
            out.append(v)
    return out


def score(values, prov, hist, carried):
    stale = {c["id"] for c in carried if c["stale"]}
    ages = {c["id"]: c["ageDays"] for c in carried}
    out = []
    for ind, (label, group, unit, direction, freq) in REGISTER.items():
        v = values.get(ind)
        if v is None:
            continue
        past = [h["values"][ind] for h in hist
                if isinstance(h.get("values", {}).get(ind), (int, float))]
        prior = past[-1] if past else None
        delta = (v - prior) if prior is not None else None
        z = None
        if len(past) >= 6:
            mu, sd = st.mean(past), st.pstdev(past)
            if sd > 0:
                z = round((v - mu) / sd, 2)
        state = "steady"
        if delta is not None and prior and direction:
            move = delta / abs(prior)
            if abs(move) > 0.01:
                state = "good" if (move > 0) == (direction > 0) else "stress"
        out.append({"id": ind, "label": label, "group": group, "unit": unit,
                    "value": round(v, 4), "prior": prior,
                    "delta": None if delta is None else round(delta, 4),
                    "z": z, "state": state, "freq": freq, "dir": direction,
                    "source": prov.get(ind, "?"), "stale": ind in stale,
                    "ageDays": ages.get(ind, 0),
                    "anomaly": bool(z is not None and abs(z) >= Z_ALERT),
                    # prior stays the previous *run*, so "unchanged" is still
                    # sayable; the line shows the levels, so it stays readable
                    # however often this runs.
                    "hist": [round(x, 4)
                             for x in distinct_levels(past + [v])[-24:]]})
    return out


def briefing(sig, ladder, breaks, call, asof):
    g = {s["id"]: s for s in sig}
    f = lambda i: f"{g[i]['value']:g}{g[i]['unit']}" if i in g else "—"
    L = [f"KENYA PULSE — {asof}", "",
         f"Policy    CBR {f('cbr')}, KESONIA {f('kesonia')}, 91-day {f('tbill')}",
         f"Prices    inflation {f('inflation')}",
         f"Banking   lending {f('lending')}, deposit {f('deposit')}, NPLs {f('npl')}",
         f"External  KES/USD {f('kes_usd')}, reserves {f('reserves')}",
         f"Markets   NASI {f('nasi')}, cap {f('mktcap')}",
         f"Fiscal    debt {f('debt_gdp')} of GDP",
         f"Global    Fed {f('fed_funds')}, US 10yr {f('us10y')}, SSA {f('ssa_gdp')}", ""]
    if ladder:
        L.append("Best real return after tax: " +
                 ", ".join(f"{r['label']} {r['real']:+.2f}%" for r in ladder[:3]))
        stale = [r for r in ladder if r.get("stale")]
        if stale:
            L.append("Rates needing a refresh: " +
                     ", ".join(r["label"] for r in stale[:4]))
    off = [b for b in breaks if b["state"] != "normal"]
    if off:
        L.append("Off their range: " +
                 ", ".join(f"{b['name']} {b['value']}{b['unit']}" for b in off[:3]))
    L += ["", call]
    return "\n".join(L)


# ===========================================================================
# HOUSEKEEPING
# ===========================================================================
def compact_log():
    """Two years at full resolution, the rest gzipped by year. Measured at about
    48 KB a year raw and 9 KB gzipped, so this is tidiness rather than need."""
    if not os.path.exists(LOG):
        log("compact: no log yet"); return
    rows = read_log(limit=10 ** 7)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=730)).date().isoformat()
    keep = [r for r in rows if r.get("asOf", "") >= cutoff]
    old = [r for r in rows if r.get("asOf", "") < cutoff]
    if not old:
        log(f"compact: nothing older than {cutoff}, {len(keep)} rows held"); return
    os.makedirs(ARCHIVE, exist_ok=True)
    byyear = {}
    for r in old:
        byyear.setdefault(r["asOf"][:4], []).append(r)
    for yr, rs in byyear.items():
        with gzip.open(os.path.join(ARCHIVE, f"{yr}.jsonl.gz"), "at") as f:
            for r in rs:
                f.write(json.dumps(r) + "\n")
        log(f"compact: archived {len(rs)} rows to {yr}.jsonl.gz")
    shutil.copy(LOG, LOG + ".bak")
    with open(LOG, "w") as f:
        for r in keep:
            f.write(json.dumps(r) + "\n")
    log(f"compact: kept {len(keep)}, archived {len(old)}")


# What is still typed by hand, who publishes it, and when it lands. Anything not
# on this list is fetched automatically and needs nothing from you.
RELEASES = {
    "pmi":      ("Stanbic PMI",           "S&P Global", "first working day"),
    "npl":      ("Non-performing loans",  "CBK",      "monthly bulletin"),
    "reserves": ("FX reserves",           "CBK",      "weekly"),
    "cover":    ("Import cover",          "CBK",      "weekly"),
    "tbill182": ("182-day bill",          "CBK",      "weekly auction"),
    "tbill364": ("364-day bill",          "CBK",      "monthly auction"),
    "bond10":   ("10-year bond",          "CBK",      "monthly"),
    "infra":    ("Infrastructure bond",   "CBK",      "when issued"),
    "debt":     ("Public debt stock",     "Treasury", "mid-month"),
    "debt_gdp": ("Debt to GDP",           "Treasury", "mid-month"),
    "gdp":      ("Quarterly GDP",         "KNBS",     "~10 weeks after quarter end"),
    "cab":      ("Current account",       "CBK",      "quarterly"),
    "debtserv": ("Debt service to revenue", "Treasury", "annual"),
}


def remind():
    """
    A reminder worth reading names what is actually overdue, so it can be acted
    on in one sitting. A generic monthly nudge gets ignored by the third month.

    Money market rates and inflation are no longer on this list — both are
    fetched now.
    """
    _, man_dates = src_manual()
    sheet_vals, sheet_dates, _ = src_sheet()
    man_dates.update(sheet_dates)
    fresh = manual_freshness(man_dates)

    overdue, undated, fine = [], [], 0
    for key, (label, who, when) in RELEASES.items():
        f = fresh.get(key, {})
        if f.get("asOf") is None:
            undated.append(f"{label} — no date recorded")
        elif f.get("stale"):
            overdue.append(f"{label} — {f['ageDays']} days old ({who}, {when})")
        else:
            fine += 1

    where = (f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit"
             if SHEET_ID else "manual.json on the VM")

    if not overdue and not undated:
        msg = (f"Kenya Pulse — everything current.\n{fine} typed figures all within "
               f"their release cycle. Nothing to do.")
    else:
        lines = ["Kenya Pulse — time to update the sheet.", ""]
        if overdue:
            lines += ["Overdue:"] + [f"  · {x}" for x in overdue] + [""]
        if undated:
            lines += ["Undated, so treated as stale:"] + [f"  · {x}" for x in undated] + [""]
        lines += [f"{fine} others are current.", "", where]
        msg = "\n".join(lines)

    print(msg)
    notify(msg)
    return len(overdue) + len(undated)


def freshness(by_source, man_dates):
    """How old each reading really is.

    Not when it was fetched - when it was published. A bill auction from
    six weeks ago is six weeks old however many times it is downloaded, and
    that difference is the whole point: a source can answer, parse cleanly,
    and still be handing back a figure nobody has refreshed. Both the live
    run and --sources read this, so they cannot disagree.
    """
    _today = datetime.now(timezone.utc).date().isoformat()
    fresh = manual_freshness(man_dates)
    # A rate fetched this morning is current whatever the typed lane thinks.
    # Without this the MMF rungs inherit a stale date from the typed file and
    # get marked OLD despite being the freshest figures in the run.
    for _k in ("mmf_top", "mmf_avg"):
        if isinstance(by_source.get("serrari", {}).get(_k), (int, float)):
            fresh[_k] = {"asOf": _today, "ageDays": 0, "stale": False,
                         "why": "fetched live"}
    for _k in ("bond10", "infra"):
        if isinstance(by_source.get("sbonds", {}).get(_k), (int, float)):
            fresh[_k] = {"asOf": _today, "ageDays": 0, "stale": False,
                         "why": "fetched live"}
    # Bills carry the auction date, which is the reading's real age. The date
    # must come from whichever source will actually supply the rate, so this
    # walks the same precedence the reconciler will: the first source holding
    # a value decides the date. Dating a CBK figure by Serrari's stale auction
    # would hide precisely the fault this exists to expose - and hard-coding
    # the order the other way round left the 91-day with no date at all once
    # the auction panel overtook the homepage, which is the same blind spot
    # that let the 182-day sit frozen for six weeks.
    for _k in ("tbill", "tbill182", "tbill364"):
        for _src in PRECEDENCE.get(_k, []):
            if not isinstance(by_source.get(_src, {}).get(_k), (int, float)):
                continue
            _auc = by_source.get(_src, {}).get("_asof")
            if not _auc:
                # This source has the rate but publishes no date for it - the
                # homepage prints a bare number. Say nothing rather than
                # inventing a date; --sources shows the blank.
                break
            _age = (datetime.now(timezone.utc).date()
                    - datetime.fromisoformat(_auc).date()).days
            fresh[_k] = {"asOf": _auc, "ageDays": _age,
                         "stale": _age > MANUAL_CADENCE.get(_k, 45),
                         "why": f"last auction ({_src})"}
            break
    # Trading Economics reports the period it belongs to, so use that date
    # rather than today — a July PMI is a July reading whenever it was fetched.
    for _k, _d in by_source.get("_te_dates", {}).items():
        if isinstance(by_source.get("te", {}).get(_k), (int, float)):
            _age = (datetime.now(timezone.utc).date()
                    - datetime.fromisoformat(_d).date()).days
            fresh[_k] = {"asOf": _d, "ageDays": _age,
                         "stale": _age > MANUAL_CADENCE.get(_k, 60),
                         "why": "fetched live"}

    return fresh


def tables_report(url):
    """Print every table on a page: its headers, its first rows, its size.

    Written after a scraper matched the wrong table on CBK's bills page and
    reported a 2016 rate as current. Guessing at markup from a distance is how
    that happens, and asking someone to paste HTML is a poor substitute for
    looking. This is the looking, and it is repeatable.
    """
    soup = BeautifulSoup(get(url).text, "lxml")
    tables = soup.find_all("table")
    print(f"\n  {url}")
    print(f"  {len(tables)} table(s)\n")
    if not tables:
        text = soup.get_text(" ", strip=True)
        print("  No tables. The page may build them in the browser, in which")
        print("  case there is nothing here to scrape. First 400 characters:\n")
        print("    " + text[:400])
        return 0
    for n, t in enumerate(tables):
        rows = t.find_all("tr")
        print(f"  ── table {n}: {len(rows)} rows"
              + (f", caption {t.caption.get_text(' ', strip=True)!r}" if t.caption else ""))
        for r in rows[:4]:
            cells = [c.get_text(" ", strip=True) for c in r.find_all(["th", "td"])]
            if not cells:
                continue
            print("     | " + " | ".join(c[:22] for c in cells[:9])
                  + (" | ..." if len(cells) > 9 else ""))
        if len(rows) > 4:
            print(f"     ... {len(rows) - 4} more rows")
        print()
    # links worth knowing about: a page that offers a spreadsheet is easier to
    # read than one that hides its numbers in markup
    files = [(a.get_text(" ", strip=True)[:44], a["href"])
             for a in soup.find_all("a", href=True)
             if re.search(r"\.(csv|xlsx?|xls)(\?|$)", a["href"], re.I)]
    if files:
        print("  downloadable data on this page:")
        for label, href in files[:10]:
            print(f"    {label or '(no text)'} -> {href}")
    return 0


def sources_report():
    """What every source actually returned, not merely whether it answered.

    --health asks whether a site is up. That is the wrong question: a site can
    answer perfectly while its markup has moved and the scraper quietly returns
    nothing, and the app then carries the last good figure forward for weeks
    wearing a fresh date. This runs the real extractors and prints what came
    back, so a silently broken parse is visible in one pass.
    """
    by_source, _ = gather()
    man_vals, man_dates = src_manual()
    sheet_vals, sheet_dates, _ = src_sheet()
    man_vals.update(sheet_vals)
    man_dates.update(sheet_dates)
    man_dates.update(by_source.get("serrari", {}).get("_asOf", {}))
    by_source["manual"] = man_vals
    fresh = freshness(by_source, man_dates)

    print(f"\n  {'SOURCE':12} {'PARSED':>6}  KEYS")
    print("  " + "-" * 68)
    for name in sorted(k for k in by_source if not k.startswith("_")):
        got = {k: v for k, v in by_source[name].items()
               if not k.startswith("_") and isinstance(v, (int, float))}
        keys = ", ".join(f"{k}={v:g}" for k, v in sorted(got.items())[:6])
        if len(got) > 6:
            keys += f", +{len(got) - 6} more"
        flag = "" if got else "   <- returned nothing"
        print(f"  {name:12} {len(got):>6}  {keys or '(none)'}{flag}")

    values, prov, _ = reconcile(by_source)
    live = [n for n in sorted(by_source)
            if not n.startswith("_") and n != "manual"
            and any(not k.startswith("_") and isinstance(v, (int, float))
                    for k, v in by_source[n].items())]
    dead = [n for n in sorted(by_source)
            if not n.startswith("_") and n != "manual" and n not in live]
    print(f"\n  connection: {len(live)} of {len(live) + len(dead)} live sources answered"
          + (f"; SILENT: {', '.join(dead)}" if dead else "; none silent"))

    print(f"\n  {'INDICATOR':12} {'VALUE':>12}  {'FROM':9} {'AS OF':11} {'AGE':>5}  EXPECTED")
    print("  " + "-" * 78)
    missing, offlist, stale_at_source, undated = [], [], [], []
    fell_to_annual = []
    for ind, (label, group, unit, direction, freq) in REGISTER.items():
        want = PRECEDENCE.get(ind, ["any"])
        got_from = prov.get(ind)
        v = values.get(ind)
        f = fresh.get(ind) or {}
        asof = f.get("asOf") or "-"
        age = f.get("ageDays")
        age_s = "-" if age is None else str(age)
        if v is None:
            # A real run applies the World Bank annual fallbacks after this
            # point, so a key with one is not actually missing from the app -
            # it arrives relabelled and caveated. Saying MISSING flatly sent
            # someone hunting for a figure that was already there.
            if ind in WB_FALLBACK:
                print(f"  {ind:12} {'-':>12}  {'-':9} {'-':11} {'-':>5}  "
                      f"{'/'.join(want)}   <- none live; annual fallback fills it")
                fell_to_annual.append(ind)
            else:
                missing.append(ind)
                print(f"  {ind:12} {'-':>12}  {'-':9} {'-':11} {'-':>5}  "
                      f"{'/'.join(want)}   <- MISSING")
            continue
        # A figure that arrived from a lower-ranked source than it should have
        # is the quiet failure: it is present, it is just not from the place
        # that keeps it fresh. "Lower-ranked", not "typed" - manual is the
        # first choice for several of these and is not a fallback there.
        stale_src = bool(want) and want[0] != "any" and got_from != want[0]
        if stale_src:
            offlist.append(ind)
        # The third failure mode, and the one that hides. The site answered, the
        # scrape parsed, a number came back - and nobody upstream has published
        # a new one for weeks. Neither reachability nor a parse check sees this.
        # Three different problems, kept apart. A figure with no date at all was
        # typed and never dated - that is a housekeeping job. A figure with a
        # date older than its own cycle means the publisher has stopped, which
        # no amount of collecting will fix.
        no_date = bool(f.get("stale")) and age is None and not stale_src
        # Independent, not exclusive. Today's 182-day is both: the first-choice
        # source gave nothing AND the one that answered is weeks behind. Showing
        # only the first of those hides half the problem.
        old_at_source = bool(f.get("stale")) and age is not None
        if no_date:
            undated.append(ind)
        if old_at_source:
            stale_at_source.append(f"{ind} ({age}d)")
        flags = []
        if stale_src:
            flags.append("fell back")
        if old_at_source:
            flags.append("SOURCE IS STALE")
        if no_date:
            flags.append("no date")
        note = ("   <- " + ", ".join(flags)) if flags else ""
        print(f"  {ind:12} {v:>12g}  {got_from or '?':9} {asof:11} {age_s:>5}  "
              f"{'/'.join(want)}{note}")

    filled = [k for k in REGISTER if k in values]
    print(f"\n  {len(filled)} of {len(REGISTER)} indicators have a figure.")
    extra = sorted(set(values) - set(REGISTER))
    if extra:
        print(f"  collected but not registered: {', '.join(extra)}")
    if missing:
        print(f"  missing entirely: {', '.join(missing)}")
    if fell_to_annual:
        print(f"  filled by a World Bank annual series, relabelled and caveated"
              f" in the app: {', '.join(fell_to_annual)}")
    if offlist:
        print(f"  came from a fallback, not their live source: {', '.join(offlist)}")
    if stale_at_source:
        print(f"  past its own publication cycle: {', '.join(stale_at_source)}")
        print("  These are old by the standard of how often that figure is published,")
        print("  so collecting more often will not move them. Either the publisher has")
        print("  stopped, or the scraper is reading a row that no longer updates.")
        print("  An annual or quarterly figure being months old is normal and is not")
        print("  listed here; the thresholds allow for each series' publication lag.")
    if undated:
        print(f"  typed but carrying no date, so age cannot be judged: {', '.join(undated)}")
    if not missing and not offlist and not stale_at_source and not undated:
        print("  every indicator came from the source it is supposed to come from,")
        print("  and none of them is older than its own publication cycle.")
    return 0 if not missing else 1


def health_report():
    checks = [
        ("CBK key rates",  "https://www.centralbank.go.ke/", False),
        ("NSE statistics", "https://www.nse.co.ke/dataservices/market-statistics/", False),
        ("FRED", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF&cosd=2026-01-01", True),
        ("IMF DataMapper", "https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/KEN", True),
        ("World Bank", "https://api.worldbank.org/v2/country/KEN/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=2", True),
        ("Currency fallback", "https://open.er-api.com/v6/latest/USD", True),
        ("Serrari MMF table", "https://serrarigroup.com/ke/mmf", False),
        ("Trading Economics", "https://tradingeconomics.com/kenya/manufacturing-pmi", False),
        ("Serrari bonds", "https://serrarigroup.com/ke/bonds", False),
        ("CBK T-bills", CBK_BILLS, False),
        ("Serrari bills", "https://serrarigroup.com/ke/tbills", False),
    ] + ([("Input sheet",
           f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv", True)]
         if SHEET_ID else [])
    print(f"\n  {'SOURCE':22} {'STATUS':11} NOTE")
    print("  " + "-" * 58)
    ok = 0
    for name, url, plain in checks:
        t = time.time()
        try:
            r = get(url, tries=1, timeout=25, plain=plain)
            print(f"  {name:22} {'reachable':11} {len(r.content)//1024} KB "
                  f"in {time.time()-t:.1f}s")
            ok += 1
        except Exception as e:
            print(f"  {name:22} {'DOWN':11} {e}")
    print(f"\n  {ok} of {len(checks)} reachable. A source being down does not break "
          f"the app:\n  the last good reading is carried forward and labelled with its age.")
    return ok


def watchdog(values, state):
    """
    A dead man's switch. If every reading is identical to the last run for days
    on end, something upstream has quietly stopped and the app is showing old
    figures wearing today's date. Silence is the failure mode nobody notices.
    """
    today = datetime.now(timezone.utc).date()
    sig = json.dumps({k: values[k] for k in sorted(values)}, sort_keys=True)
    prev = state.get("lastSig")
    if prev != sig:
        state["lastSig"] = sig
        state["lastChange"] = today.isoformat()
        return None
    since = state.get("lastChange")
    if not since:
        state["lastChange"] = today.isoformat()
        return None
    days = (today - datetime.fromisoformat(since).date()).days
    return days if days >= 8 else None


SHEET_URL = os.environ.get("KP_SHEET_URL", "").strip()


def notify(text):
    if DRY or not (TG_TOKEN and TG_CHAT):
        log("  telegram skipped"); return
    try:
        requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                      json={"chat_id": TG_CHAT, "text": text,
                            "disable_web_page_preview": True}, timeout=15)
        log("  telegram sent")
    except Exception as e:
        log(f"  telegram FAILED: {e}")


# ===========================================================================
def gather():
    """
    Every network call, in one place. Returns the raw per-source readings and
    the annual spine, and interprets nothing. Keeping I/O in one function is
    what makes the rest of the pipeline testable without a network.
    """
    by_source, spine = {}, {}

    log("rates, markets, currency")
    by_source["cbk"] = src_cbk()
    by_source["nse"] = src_nse()
    by_source["fred"] = src_fred()
    by_source["serrari"] = src_serrari()
    by_source["sbonds"] = src_serrari_bonds()
    by_source["cbkbills"] = src_cbk_bills()
    by_source["sbills"] = src_serrari_bills()
    te_vals, te_dates = src_te()
    by_source["te"] = te_vals
    by_source["_te_dates"] = te_dates
    if "kes_usd" not in by_source["cbk"]:
        by_source["fx"] = src_fx()

    if not FAST:
        log("forecasts and long history")
        im_now, im_spine = src_imf()
        wb_now, wb_spine = src_worldbank()
        by_source["imf"], by_source["worldbank"] = im_now, wb_now
        spine = {**wb_spine, **{f"imf_{k}": v for k, v in im_spine.items()},
                 "_pulled": datetime.now(timezone.utc).date().isoformat()}
    elif os.path.exists(SPINE):
        spine = json.load(open(SPINE))

    return by_source, spine


def main():
    if REMIND:
        remind(); return
    if COMPACT:
        compact_log(); return
    if HEALTH:
        health_report(); return
    if SOURCES:
        sources_report(); return
    if TABLES:
        i = sys.argv.index("--tables")
        if i + 1 >= len(sys.argv):
            print("usage: kenya_pulse.py --tables <url>"); return
        tables_report(sys.argv[i + 1]); return

    t0 = time.time()
    log(f"Kenya Pulse{' (fast)' if FAST else ''}")
    by_source, spine = gather()

    log("typed figures")
    man_vals, man_dates = src_manual()
    sheet_vals, sheet_dates, sheet_problems = src_sheet()
    # The sheet wins where it has a value; the file remains as a fallback so a
    # Google outage cannot blank the ladder.
    man_vals.update(sheet_vals)
    man_dates.update(sheet_dates)
    man_dates.update(by_source.get("serrari", {}).get("_asOf", {}))
    by_source["manual"] = man_vals
    fresh = freshness(by_source, man_dates)

    values, prov, disagree = reconcile(by_source)
    state = load_state()
    carried = carry_forward(values, prov, state)
    hist = read_log()
    fallbacks = apply_fallbacks(values, prov, fresh, spine) if spine else []
    if fallbacks:
        log("    fell back to annual data for "
            + ", ".join(f["id"] for f in fallbacks))
    signals = score(values, prov, hist, carried)
    # a substituted measure gets a substituted name
    _fb = {f["id"]: f for f in fallbacks}
    for sig in signals:
        f = _fb.get(sig["id"])
        if not f:
            continue
        sig["fallback"] = f["caveat"]
        if f["relabel"]:
            sig["label"] = f["relabel"]
            sig["band"] = None

    ladder = build_ladder(values, fresh)
    chain = build_chain(values, hist)
    breaks = build_breaks(values, spine, hist)
    call = build_call(ladder, chain, breaks)
    frozen = watchdog(values, state)
    asof = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    payload = {"asOf": asof,
               "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "frozenDays": frozen,
               "inputProblems": sheet_problems,
               "bestMmf": by_source.get("serrari", {}).get("_best"),
               "fallbacks": fallbacks,
               "staleRates": [r["label"] for r in ladder if r.get("stale")],
               "signals": signals, "ladder": ladder, "chain": chain,
               "breaks": breaks, "call": call,
               "disagreements": disagree, "carried": carried,
               "sourcesLive": sorted(k for k, d in by_source.items()
                                     if any(not x.startswith("_") for x in d)),
               "cbkDates": by_source.get("cbk", {}).get("_dates", {}),
               "briefing": briefing(signals, ladder, breaks, call, asof),
               "runSeconds": round(time.time() - t0, 1)}

    if DRY:
        print(f"\n{'='*64}\n{payload['briefing']}\n{'='*64}")
        print(f"\nLADDER ({len(ladder)} instruments, best real return first)")
        for r in ladder:
            print(f"  {r['label']:24} gross {r['gross']:>6.2f}%  net {r['net']:>6.2f}%  "
                  f"real {r['real']:>+6.2f}%")
        print("\nCHAIN")
        for c in chain:
            mv = "—" if c["move"] is None else f"{c['move']:+.2f}"
            print(f"  +{c['lagMonths']:>2}m {c['label']:20} {c['value']:>7.2f}  "
                  f"6-run move {mv:>7}  [{c['status']}]")
        print("\nBREAKS")
        for b in breaks:
            print(f"  {b['name']:26} {b['value']:>7.2f}{b['unit']:<3} "
                  f"usual {b['normalLo']}–{b['normalHi']} ({b['basis']}, n={b['n']})"
                  f"  [{b['state'].upper()}]")
        derived = [b for b in breaks if b["basis"] == "derived"]
        if sheet_problems:
            print("\n  SHEET PROBLEMS")
            for p in sheet_problems:
                print(f"    {p}")
        print(f"\n{len(signals)} indicators · {len(disagree)} disagreements · "
              f"{len(carried)} carried · {len(derived)}/{len(breaks)} ranges derived "
              f"· {payload['runSeconds']}s")
        stale = [r for r in ladder if r.get("stale")]
        if stale:
            print("  STALE RATES (refresh manual.json):")
            for r in stale:
                age = f"{r['ageDays']}d old" if r["ageDays"] is not None else "undated"
                print(f"    {r['label']:24} {age}")
        if frozen:
            print(f"  ⚠ readings unchanged for {frozen} days — check the collector")
        for d in disagree:
            print(f"  DISAGREE {d['id']}: {d['kept']}={d['keptValue']} over "
                  f"{d['other']}={d['otherValue']} ({d['gapPct']}%)")
        return

    os.makedirs(PUBLIC, exist_ok=True)
    json.dump(payload, open(OUT, "w"), separators=(",", ":"))
    if spine:
        json.dump(spine, open(SPINE, "w"), separators=(",", ":"))
    json.dump(state, open(STATE, "w"))
    with open(LOG, "a") as f:
        f.write(json.dumps({"asOf": asof, "run": "fast" if FAST else "full",
                            "values": {k: round(v, 4) for k, v in values.items()},
                            "src": prov}, separators=(",", ":")) + "\n")

    log(f"wrote {OUT} ({os.path.getsize(OUT)/1024:.1f} KB) · {len(signals)} indicators "
        f"· {len(ladder)} instruments · {len([b for b in breaks if b['state']!='normal'])} "
        f"breaks · {payload['runSeconds']}s")

    alerts = []
    if sheet_problems:
        alerts.append("Problems in the input sheet: " + "; ".join(sheet_problems))
    if frozen:
        alerts.append(f"⚠ Readings have not changed in {frozen} days. The collector may "
                      f"have stopped, or a source has gone quiet.")
    stale = [r for r in ladder if r.get("stale")]
    if stale:
        alerts.append("Rates needing a refresh in manual.json: " +
                      ", ".join(r["label"] for r in stale))
    if alerts:
        notify("\n".join(alerts) + "\n\n" + payload["briefing"])
    elif not FAST or any(s["anomaly"] for s in signals):
        notify(payload["briefing"])


if __name__ == "__main__":
    main()
