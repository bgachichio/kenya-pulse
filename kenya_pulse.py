#!/usr/bin/env python3
"""
KENYA PULSE — collector v3

Pulls Kenyan and global macro data, reconciles sources that disagree, computes
the three signal layers, and writes one JSON the app renders.

    python3 kenya_pulse.py            full sweep, about 3 minutes
    python3 kenya_pulse.py --fast     rates, markets, currency only, ~15 seconds
    python3 kenya_pulse.py --dry      print, write nothing, send nothing
    python3 kenya_pulse.py --health   source reachability, no writes
    python3 kenya_pulse.py --compact  roll the log up

Dependencies:  pip3 install --user requests beautifulsoup4 lxml

The three layers, computed here rather than in the browser so the app stays a
renderer and this file stays the single place logic can be wrong:

  LADDER    after-tax real return on every instrument, ranked
  CHAIN     the transmission from policy rate to GDP, with lags
  BREAKS    long-running relationships that have come apart

Author: Brian Gachichio · gachichio.org
"""

import csv, gzip, io, json, os, re, shutil, statistics as st, sys, time
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
DRY     = "--dry"     in sys.argv
HEALTH  = "--health"  in sys.argv
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
    "core":      ("Core inflation",               "Prices",   "%",      -1, "monthly"),

    "lending":   ("Average lending rate",         "Banking",  "%",      -1, "monthly"),
    "savings":   ("Average savings rate",         "Banking",  "%",      +1, "monthly"),
    "deposit":   ("Average deposit rate",         "Banking",  "%",      +1, "monthly"),
    "credit":    ("Private sector credit growth", "Banking",  "%",      +1, "monthly"),
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
    "inflation": ["manual", "cbk"], "core": ["manual"],
    "cbr": ["cbk"], "kesonia": ["cbk"], "repo": ["cbk"], "discount": ["cbk"],
    "tbill": ["cbk"], "tbill182": ["manual"], "tbill364": ["manual"], "bond10": ["manual"],
    "lending": ["cbk", "manual"], "savings": ["cbk", "manual"], "deposit": ["cbk", "manual"],
    "credit": ["manual"], "npl": ["manual"], "pmi": ["manual"],
    "kes_usd": ["cbk", "fx"], "kes_eur": ["cbk", "fx"], "kes_gbp": ["cbk", "fx"],
    "reserves": ["manual"], "cover": ["manual"],
    "cab": ["manual", "imf"], "gdp": ["manual", "imf"],
    "nasi": ["nse"], "nse20": ["nse"], "nse25": ["nse"],
    "bank_idx": ["nse"], "mktcap": ["nse"],
    "debt": ["manual"], "debt_gdp": ["manual", "imf"], "debtserv": ["manual"],
    "fed_funds": ["fred"], "us10y": ["fred"],
    "world_gdp": ["imf"], "ssa_gdp": ["imf"],
}

TOLERANCE = {"gdp": 0.08, "cab": 0.15, "debt_gdp": 0.03, "kes_usd": 0.01,
             "inflation": 0.05, "_default": 0.05}

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
    for key, code in IMF_KENYA.items():
        try:
            d = get(f"https://www.imf.org/external/datamapper/api/v1/{code}/KEN",
                    plain=True).json()
            s = d.get("values", {}).get(code, {}).get("KEN", {})
            s = {int(y): v for y, v in s.items() if v is not None}
            if s:
                spine[key] = dict(sorted(s.items()))
        except Exception as e:
            log(f"    imf {key}: {e}")

    for key, region in IMF_WORLD.items():
        try:
            d = get("https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/"
                    + region, plain=True).json()
            s = d.get("values", {}).get("NGDP_RPCH", {}).get(region, {})
            s = {int(y): v for y, v in s.items() if v is not None}
            if s:
                spine[f"{key}_gdp"] = dict(sorted(s.items()))
        except Exception as e:
            log(f"    imf {region}: {e}")

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
    for key, code in WB_CODES.items():
        try:
            rows = get(f"https://api.worldbank.org/v2/country/KEN/indicator/{code}"
                       f"?format=json&per_page=90&date=2002:{datetime.now().year}",
                       plain=True).json()[1] or []
            s = {int(r["date"]): r["value"] for r in rows if r["value"] is not None}
            if s:
                spine[key] = dict(sorted(s.items()))
        except Exception as e:
            log(f"    worldbank {key}: {e}")
    if "gdp_growth" in spine:
        out["gdp"] = list(spine["gdp_growth"].values())[-1]
    log(f"    worldbank: {len(spine)} series")
    return out, spine


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


def src_manual():
    """
    What only exists inside a PDF or behind a paywall: the Stanbic PMI, the
    longer bills, the 10-year bond, NPLs, reserves, the debt stock, quarterly
    GDP and your own money market rate. About a minute a month.
    """
    if not os.path.exists(MANUAL):
        return {}
    try:
        raw = json.load(open(MANUAL))
        out = {k: (v["value"] if isinstance(v, dict) and "value" in v else v)
               for k, v in raw.items() if not k.startswith("_")}
        log(f"    manual: {len(out)} typed values")
        return out
    except Exception as e:
        log(f"    manual.json unreadable: {e}")
        return {}


# ===========================================================================
# RECONCILIATION
# ===========================================================================
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
        except Exception:
            pass
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
# Kenyan withholding tax on interest, resident individuals. The tax firms
# (EY, Cliffe Dekker, FNJ) agree on 15% for bills and short bonds, 10% for
# bonds of ten years or more, and full exemption for infrastructure bonds.
# One retail aggregator claims bills are exempt for individuals; no tax
# practice corroborates it, so 15% is used and the claim is surfaced in the
# app as a disagreement rather than silently resolved.
TAX = {"tbill": 0.15, "tbill182": 0.15, "tbill364": 0.15, "bond10": 0.10,
       "infra": 0.00, "mmf": 0.15, "deposit": 0.15, "savings": 0.15,
       "dividend": 0.05, "cash": 0.0}


def build_ladder(v, tax_overrides=None):
    """
    After-tax real return on everything you could hold. Nominal yield is the
    energy, inflation is the entropy, what survives is the real return. Nothing
    here is a recommendation: it is arithmetic on published rates.
    """
    tax = dict(TAX)
    tax.update(tax_overrides or {})
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
        out.append({"id": rid, "label": label, "gross": round(gross, 2),
                    "taxPct": round(t * 100), "net": round(net, 2),
                    "real": round(real, 2), "note": note,
                    "doublingYears": round(72 / real, 1) if real > 0.05 else None})
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
    ("credit",    "Credit growth",    8,  "Borrowers respond once loans are cheaper"),
    ("gdp",       "GDP growth",      11,  "Activity follows the credit it runs on"),
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
def build_breaks(v, spine):
    """
    Relationships that normally hold, and where they sit now. A ratio inside its
    usual range tells you nothing. One outside it is either a mispricing or a
    regime change, and both are worth knowing before everyone else.

    `normal` ranges come from the 2002-onward record in the annual spine where
    one exists, and from published Kenyan history where it does not.
    """
    B = []

    def add(name, value, normal, unit, reading_hi, reading_lo, why):
        if value is None:
            return
        lo, hi = normal
        if value > hi:
            state, reading = "high", reading_hi
        elif value < lo:
            state, reading = "low", reading_lo
        else:
            state, reading = "normal", "Inside its usual range."
        B.append({"name": name, "value": round(value, 2), "unit": unit,
                  "normalLo": lo, "normalHi": hi, "state": state,
                  "reading": reading, "why": why})

    # Bank margin: what banks charge over what the policy rate costs them
    if v.get("lending") and v.get("cbr"):
        add("Bank margin over policy", v["lending"] - v["cbr"], (3.5, 5.5), "pp",
            "Banks are holding spreads wide while policy eases. Transmission is "
            "incomplete, so more of the cut has yet to reach borrowers.",
            "Spreads are unusually thin. Bank margins are being squeezed.",
            "Average lending rate less the Central Bank Rate.")

    # Front of the curve against policy
    if v.get("tbill") and v.get("cbr"):
        add("91-day over policy", v["tbill"] - v["cbr"], (-1.0, 0.75), "pp",
            "The market is demanding more than policy to fund the state. Either "
            "supply pressure or a view that the easing cycle is finished.",
            "Bills are trading below policy. The market expects further cuts.",
            "91-day bill less the Central Bank Rate.")

    # Sovereign spread against the risk-free world
    if v.get("bond10") and v.get("us10y"):
        add("Sovereign spread", v["bond10"] - v["us10y"], (7.0, 11.0), "pp",
            "Kenya is paying an unusually large premium over the risk-free world. "
            "Foreign money is being paid well to stay, and the state is paying "
            "dearly to borrow.",
            "The premium is thin by Kenyan standards. Foreign appetite is strong, "
            "which is pleasant while it lasts and reverses quickly when it does not.",
            "Kenya 10-year less the US 10-year.")

    # Real return on holding money in a bank
    if v.get("deposit") is not None and v.get("inflation") is not None:
        add("Real deposit rate", v["deposit"] - v["inflation"], (-1.0, 2.0), "pp",
            "Banks are paying savers well above inflation, which is rare and does "
            "not usually last.",
            "Bank deposits are losing purchasing power. Money sitting in a bank is "
            "being taxed by inflation.",
            "Average deposit rate less headline inflation.")

    # Credit intensity: how much borrowing each point of growth needs
    if v.get("credit") and v.get("gdp") and v.get("gdp") > 0:
        add("Credit intensity", v["credit"] / v["gdp"], (1.2, 2.5), "x",
            "Credit is growing far faster than the activity it funds. Watch asset "
            "quality on the way down.",
            "Growth is running ahead of the credit funding it, which usually means "
            "the recovery is not yet being financed.",
            "Private credit growth divided by GDP growth.")

    # Market against the economy behind it
    if v.get("mktcap") and v.get("kes_usd") and spine.get("gdp_usd"):
        gdp_kes_bn = list(spine["gdp_usd"].values())[-1] / 1e9 * v["kes_usd"]
        add("Market cap to GDP", v["mktcap"] / gdp_kes_bn * 100, (15.0, 30.0), "%",
            "The market is large against the economy behind it. Re-ratings from "
            "here have historically needed earnings to arrive.",
            "The market is small against the economy. Historically where the good "
            "entry points have been.",
            "NSE market capitalisation as a share of GDP.")

    # Where the money market sits against the policy corridor
    if v.get("kesonia") and v.get("cbr"):
        add("Overnight against policy", v["kesonia"] - v["cbr"], (-0.5, 0.5), "pp",
            "Overnight money is trading above policy. Liquidity is tight.",
            "Overnight money is below policy. The system is flush.",
            "KESONIA less the Central Bank Rate.")

    return B


def build_call(v, ladder, chain, breaks):
    """One paragraph tying the three layers together. The thing to read first."""
    L = []
    if ladder:
        top, cash = ladder[0], ladder[-1]
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
    rows = []
    with open(LOG) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    return rows[-limit:]


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
                    "hist": [round(x, 4) for x in past[-24:]] + [round(v, 4)]})
    return out


def briefing(sig, ladder, breaks, call, asof, pulse, verdict):
    g = {s["id"]: s for s in sig}
    f = lambda i: f"{g[i]['value']:g}{g[i]['unit']}" if i in g else "—"
    L = [f"KENYA PULSE — {asof}", f"Score {pulse}/100 · {verdict}", "",
         f"Policy    CBR {f('cbr')}, KESONIA {f('kesonia')}, 91-day {f('tbill')}",
         f"Prices    inflation {f('inflation')}",
         f"Banking   lending {f('lending')}, deposit {f('deposit')}, credit {f('credit')}",
         f"External  KES/USD {f('kes_usd')}, reserves {f('reserves')}",
         f"Markets   NASI {f('nasi')}, cap {f('mktcap')}",
         f"Fiscal    debt {f('debt_gdp')} of GDP",
         f"Global    Fed {f('fed_funds')}, US 10yr {f('us10y')}, SSA {f('ssa_gdp')}", ""]
    if ladder:
        L.append("Best real return: " +
                 ", ".join(f"{r['label']} {r['real']:+.2f}%" for r in ladder[:3]))
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


def health_report():
    checks = [
        ("CBK key rates",  "https://www.centralbank.go.ke/", False),
        ("NSE statistics", "https://www.nse.co.ke/dataservices/market-statistics/", False),
        ("FRED", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF&cosd=2026-01-01", True),
        ("IMF DataMapper", "https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/KEN", True),
        ("World Bank", "https://api.worldbank.org/v2/country/KEN/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=2", True),
        ("Currency fallback", "https://open.er-api.com/v6/latest/USD", True),
    ]
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
def main():
    if COMPACT:
        compact_log(); return
    if HEALTH:
        health_report(); return

    t0 = time.time()
    log(f"Kenya Pulse v3{' (fast)' if FAST else ''}")
    by_source, spine = {}, {}

    log("rates, markets, currency")
    by_source["cbk"] = src_cbk()
    by_source["nse"] = src_nse()
    by_source["fred"] = src_fred()
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

    log("manual entries")
    by_source["manual"] = src_manual()

    values, prov, disagree = reconcile(by_source)
    state = load_state()
    carried = carry_forward(values, prov, state)
    hist = read_log()
    signals = score(values, prov, hist, carried)

    ladder = build_ladder(values)
    chain = build_chain(values, hist)
    breaks = build_breaks(values, spine)
    call = build_call(values, ladder, chain, breaks)

    scored = [s for s in signals if s["dir"] != 0]
    pulse = round(100 * sum(1 if s["state"] == "good" else 0.5 if s["state"] == "steady"
                            else 0 for s in scored) / max(len(scored), 1))
    verdict = "EXPANDING" if pulse >= 65 else "MIXED" if pulse >= 45 else "UNDER STRAIN"
    asof = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    payload = {"asOf": asof, "pulse": pulse, "verdict": verdict,
               "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "signals": signals, "ladder": ladder, "chain": chain,
               "breaks": breaks, "call": call,
               "disagreements": disagree, "carried": carried,
               "sourcesLive": sorted(k for k, d in by_source.items()
                                     if any(not x.startswith("_") for x in d)),
               "cbkDates": by_source.get("cbk", {}).get("_dates", {}),
               "briefing": briefing(signals, ladder, breaks, call, asof, pulse, verdict),
               "runSeconds": round(time.time() - t0, 1)}

    if DRY:
        print(f"\n{'='*64}\n{payload['briefing']}\n{'='*64}")
        print(f"\nLADDER ({len(ladder)} instruments, best real return first)")
        for r in ladder:
            print(f"  {r['label']:24} gross {r['gross']:>6.2f}%  net {r['net']:>6.2f}%  "
                  f"real {r['real']:>+6.2f}%")
        print(f"\nCHAIN")
        for c in chain:
            mv = "—" if c["move"] is None else f"{c['move']:+.2f}"
            print(f"  +{c['lagMonths']:>2}m {c['label']:20} {c['value']:>7.2f}  "
                  f"6-run move {mv:>7}  [{c['status']}]")
        print(f"\nBREAKS")
        for b in breaks:
            print(f"  {b['name']:26} {b['value']:>7.2f}{b['unit']:<3} "
                  f"normal {b['normalLo']}–{b['normalHi']}  [{b['state'].upper()}]")
        print(f"\n{len(signals)} indicators · {len(disagree)} disagreements · "
              f"{len(carried)} carried · {payload['runSeconds']}s")
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

    if not FAST or any(s["anomaly"] for s in signals):
        notify(payload["briefing"])


if __name__ == "__main__":
    main()
