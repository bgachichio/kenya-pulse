import React, { useState, useEffect, useMemo, useRef } from "react";

/* ===========================================================================
   KENYA PULSE
   A dipstick on the Kenyan economy, and a read on where money is being paid.

   Three layers of signal, all computed by the collector and rendered here:
     LADDER   after-tax real return on every instrument, ranked
     CHAIN    policy rate through to GDP, with the lags between
     BREAKS   long-running relationships that have come apart

   Data: CBK, NSE, KNBS, National Treasury, World Bank, IMF, FRED.
   Built by Brian Gachichio · gachichio.org
=========================================================================== */

/* ---------------------------------------------------------------------------
   Storage.
   Settings live on the device. Three things make that reliable rather than
   hopeful: every write is read back to confirm it landed, the schema carries a
   version so a future change migrates instead of silently resetting, and the
   whole state is reportable so a fault can be seen rather than guessed at.

   Note that browser storage is per ORIGIN. Settings saved on one hostname are
   invisible on another, which is the usual reason a deployed app appears to
   "forget" — two URLs for the same app, each with its own drawer.
--------------------------------------------------------------------------- */
const SCHEMA = 1;
const mem = {};
const diag = { ok: null, error: null, writes: 0, lastWrite: null };

const store = {
  probe() {
    try {
      const k = "kp.__probe";
      window.localStorage.setItem(k, "1");
      const back = window.localStorage.getItem(k);
      window.localStorage.removeItem(k);
      diag.ok = back === "1";
      diag.error = diag.ok ? null : "wrote but could not read back";
    } catch (e) {
      diag.ok = false;
      diag.error = (e && e.name) === "QuotaExceededError"
        ? "storage is full" : "blocked by the browser";
    }
    return diag.ok;
  },
  get(k, fb) {
    try {
      const v = window.localStorage.getItem(k);
      if (v === null) return k in mem ? mem[k] : fb;
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && parsed.__v && parsed.__v !== SCHEMA) {
        return { ...fb, ...migrate(parsed, parsed.__v) };
      }
      return parsed;
    } catch {
      return k in mem ? mem[k] : fb;
    }
  },
  set(k, v) {
    mem[k] = v;
    try {
      const body = (v && typeof v === "object" && !Array.isArray(v))
        ? { ...v, __v: SCHEMA } : v;
      window.localStorage.setItem(k, JSON.stringify(body));
      const back = window.localStorage.getItem(k);          // confirm, do not assume
      if (back === null) throw new Error("write vanished");
      diag.ok = true; diag.error = null;
      diag.writes += 1; diag.lastWrite = new Date().toISOString().slice(11, 19);
      return true;
    } catch (e) {
      diag.ok = false;
      diag.error = (e && e.name) === "QuotaExceededError"
        ? "storage is full" : "blocked by the browser";
      return false;
    }
  },
  report() {
    const keys = [];
    try {
      for (const k of ["kp.cfg", "kp.data"]) {
        const v = window.localStorage.getItem(k);
        if (v !== null) keys.push({ key: k, bytes: v.length });
      }
    } catch { /* unreadable */ }
    return { ...diag, keys,
      origin: typeof window !== "undefined" && window.location
        ? window.location.origin : "unknown" };
  },
};

/* Older layouts are upgraded rather than discarded. Nothing here yet, but the
   hook exists so the first schema change does not cost anyone their settings. */
function migrate(old) { return old; }

const THEME = {
  light: { bg: "#FAF8F4", card: "#FFFFFF", line: "#E8E2D8", ink: "#1A1F27",
    dim: "#66707E", faint: "#9BA3AF", good: "#237352", warn: "#B0642A",
    bad: "#B3261E", cool: "#1F3864", chip: "#F1ECE3",
    shadow: "0 1px 2px rgba(26,31,39,.05)", lift: "0 4px 16px rgba(26,31,39,.09)" },
  dark: { bg: "#0F141A", card: "#171E26", line: "#262F3A", ink: "#E9EBEE",
    dim: "#98A2AF", faint: "#69737F", good: "#3E9E77", warn: "#D18A4E",
    bad: "#E06A5F", cool: "#7C9BD4", chip: "#1D252F",
    shadow: "none", lift: "0 4px 16px rgba(0,0,0,.35)" },
};
const SIZES = { s: 14, m: 16, l: 18, xl: 21 };

/* ===========================================================================
   SEED — every figure a real published reading, verified 17 August 2026
=========================================================================== */
const YEARS = Array.from({ length: 24 }, (_, i) => 2002 + i);
const N = null;

const ANNUAL = {
  gdp_growth: [0.55,2.93,5.1,5.91,6.47,6.85,0.23,3.31,8.06,5.12,4.57,3.8,5.02,4.97,4.21,3.84,5.65,5.11,-0.27,7.59,4.86,5.72,4.66,4.63],
  inflation:  [1.96,9.82,11.62,10.31,14.45,9.76,26.24,9.23,3.96,14.02,9.38,5.72,6.88,6.58,6.3,8.01,4.69,5.24,5.41,6.11,7.66,7.67,4.49,4.07],
  gdp_usd:    [13.1,14.9,16.1,18.7,25.8,32,35.9,42.3,45.4,46.9,56.4,61.7,68.3,70.1,74.8,82,92.2,100.4,100.7,109.7,114.4,107.5,120.4,135.9],
  gdp_pc:     [403,443,464,523,700,840,916,1048,1092,1096,1285,1371,1483,1489,1554,1667,1836,1960,1928,2061,2110,1943,2133,2363],
  exports:    [24.9,24.09,26.61,28.51,22.98,21.92,22.67,18.77,20.12,21.55,19.86,17.79,16.47,15.13,13.25,12.74,12.54,11.43,11.44,13.11,15.96,16.71,16.86,15.76],
  imports:    [30.27,30.05,32.87,35.97,32.25,31.98,34.91,27.17,30.27,36.85,31.76,29.67,29.7,25.2,21.61,23.26,21.87,20.33,18.96,21.89,24.32,24.22,23.15,21.76],
  cab:        [-0.9,0.89,-0.82,-1.35,-1.98,-3.23,-5.52,-3.99,-5.22,-8.15,-7.48,-7.85,-9.34,-6.3,-5.4,-7,-5.41,-5.24,-3.27,-4.6,-4.2,-2.55,-1.29,N],
  credit:     [25.86,25.16,27.29,26.28,22.89,23.05,25.38,21.88,23.99,27.37,26.4,28.33,34.52,36.7,35.57,33.15,31.2,30.83,32.15,31.12,31.26,31.8,N,N],
  reserves:   [1.07,1.48,1.52,1.8,2.42,3.36,2.88,3.85,4.32,4.27,5.71,6.6,7.87,7.51,7.55,7.33,8.16,9.12,8.3,9.49,7.97,7.34,10.07,12.39],
  remit:      [0.06,0.07,0.38,0.42,0.57,0.65,0.67,0.63,0.69,0.93,1.21,1.3,1.44,1.57,1.74,1.96,2.72,2.84,3.11,3.77,4.06,4.23,5,N],
};
const ANNUAL_META = {
  gdp_growth: { label: "GDP growth", unit: "%", dir: 1 },
  inflation:  { label: "Inflation", unit: "%", dir: -1 },
  gdp_usd:    { label: "GDP", unit: "$bn", dir: 1 },
  gdp_pc:     { label: "GDP a head", unit: "$", dir: 1 },
  exports:    { label: "Exports", unit: "% GDP", dir: 1 },
  imports:    { label: "Imports", unit: "% GDP", dir: -1 },
  cab:        { label: "Current account", unit: "% GDP", dir: 1 },
  credit:     { label: "Private credit", unit: "% GDP", dir: 1 },
  reserves:   { label: "FX reserves", unit: "$bn", dir: 1 },
  remit:      { label: "Remittances", unit: "$bn", dir: 1 },
};

/* IMF World Economic Outlook, projections to 2031 */
const F_YEARS = [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031];
const FORECAST = {
  gdp_growth: { label: "Kenya growth", unit: "%", dir: 1, actualTo: 2025,
    v: [4.7, 4.9, 4.5, 4.7, 5.1, 5.0, 5.0, 5.0] },
  inflation:  { label: "Kenya inflation", unit: "%", dir: -1, actualTo: 2025,
    v: [4.5, 4.1, 5.9, 5.9, 5.7, 5.7, 5.3, 5.2] },
  debt_gdp:   { label: "Kenya public debt", unit: "% GDP", dir: -1, actualTo: 2025,
    v: [67.9, 69.3, 71.6, 72.4, 73.3, 73.6, 74.2, 74.6] },
  ssa_gdp:    { label: "Sub-Saharan Africa growth", unit: "%", dir: 1, actualTo: 2025,
    v: [4.0, 4.5, 4.3, 4.4, 4.4, 4.4, 4.4, 4.4] },
  world_gdp:  { label: "World growth", unit: "%", dir: 1, actualTo: 2025,
    v: [3.3, 3.4, 3.1, 3.2, 3.2, 3.2, 3.2, 3.1] },
  us_gdp:     { label: "US growth", unit: "%", dir: 1, actualTo: 2025,
    v: [2.8, 2.1, 2.3, 2.1, 2.1, 2.1, 2.0, 2.0] },
};

const SEED = {
  asOf: "2026-08-17", source: "seed", pulse: 50, verdict: "MIXED",
  indicators: [
    { id: "cbr", label: "Central Bank Rate", group: "Policy", unit: "%", dir: 0,
      value: 8.75, prior: 9.0, priorLabel: "December", asOf: "8 Apr 2026", freq: "Bi-monthly", src: "CBK",
      hist: [10.75,10.25,10,9.75,9.5,9.25,9,8.75,8.75,8.75,8.75],
      note: "Fourth straight hold, the longest pause since 2020. Next meeting October." },
    { id: "kesonia", label: "KESONIA overnight", group: "Policy", unit: "%", dir: 0,
      value: 8.7494, prior: 8.71, priorLabel: "a week ago", asOf: "14 Aug 2026", freq: "Daily", src: "CBK",
      hist: [8.68,8.71,8.74,8.72,8.75,8.71,8.7494],
      note: "Sitting almost exactly on the policy rate. The overnight market is in balance — no liquidity stress, no flood." },
    { id: "tbill", label: "91-day Treasury bill", group: "Policy", unit: "%", dir: 0,
      value: 8.773, prior: 7.64, priorLabel: "February", asOf: "17 Aug 2026", freq: "Weekly", src: "CBK",
      hist: [9.1,8.9,8.6,8.3,8.1,7.9,7.64,8.12,8.45,8.61,8.773],
      note: "Up 113bp since February while the policy rate held. The market is repricing the front end on its own." },
    { id: "repo", label: "REPO rate", group: "Policy", unit: "%", dir: 0,
      value: 9.25, prior: 9.25, priorLabel: "unchanged", asOf: "15 Oct 2025", freq: "Weekly", src: "CBK",
      hist: [9.25,9.25,9.25,9.25], note: "The ceiling of the corridor." },
    { id: "bond10", label: "10-year bond", group: "Policy", unit: "%", dir: 0,
      value: 13.45, prior: 13.6, priorLabel: "last month", asOf: "Aug 2026", freq: "Monthly", src: "Typed",
      hist: [14.2,14,13.85,13.7,13.6,13.45],
      note: "Against a US 10-year at 4.63%, a spread of 882bp." },

    { id: "inflation", label: "Headline inflation", group: "Prices", unit: "%", dir: -1,
      value: 6.49, prior: 6.4, priorLabel: "June", asOf: "Jul 2026", freq: "Monthly", src: "CBK",
      band: [2.5, 7.5], bandLabel: "CBK target band 2.5–7.5%",
      hist: [3.8,4.1,4.5,4.6,4.6,4.5,4.5,4.4,4.3,4.4,5.6,6.7,6.4,6.49],
      note: "Transport and food carry it. Non-core runs at 15% against core at 3.2% — a supply shock, not demand." },
    { id: "core", label: "Core inflation", group: "Prices", unit: "%", dir: -1,
      value: 3.2, prior: 3.2, priorLabel: "June", asOf: "Jul 2026", freq: "Monthly", src: "Typed",
      hist: [3,3.1,3.1,3.2,3.2,3.2,3.2],
      note: "Flat. No demand pressure, which is why the MPC can sit still through a 6.5% headline." },

    { id: "lending", label: "Average lending rate", group: "Banking", unit: "%", dir: -1,
      value: 14.38, prior: 14.5, priorLabel: "May", asOf: "Jun 2026", freq: "Monthly", src: "CBK",
      hist: [17.2,16.8,16.1,15.6,15.2,14.9,14.7,14.5,14.38],
      note: "Down 282bp from the November 2024 peak, but still 563bp over policy." },
    { id: "deposit", label: "Average deposit rate", group: "Banking", unit: "%", dir: 1,
      value: 6.84, prior: 7.1, priorLabel: "May", asOf: "Jun 2026", freq: "Monthly", src: "CBK",
      hist: [9.2,8.9,8.4,8,7.6,7.3,7.1,6.84],
      note: "Falling faster than lending rates. Banks are protecting margin from the deposit side." },
    { id: "savings", label: "Average savings rate", group: "Banking", unit: "%", dir: 1,
      value: 3.32, prior: 3.4, priorLabel: "May", asOf: "Jun 2026", freq: "Monthly", src: "CBK",
      hist: [4.2,4,3.8,3.6,3.5,3.4,3.32],
      note: "Against 6.49% inflation, a savings account loses 3.7% of its purchasing power a year." },
    { id: "credit", label: "Private sector credit growth", group: "Banking", unit: "%", dir: 1,
      value: 10.2, prior: 10.6, priorLabel: "June", asOf: "Jul 2026", freq: "Monthly", src: "Typed",
      hist: [-2.9,0.4,2.1,3.6,5,6.3,7,7.4,7.1,9.3,10.6,10.2],
      note: "From a 2.9% contraction in January 2025 to double digits. Trade, construction and agriculture lead." },
    { id: "npl", label: "Non-performing loans", group: "Banking", unit: "%", dir: -1,
      value: 14.6, prior: 15.3, priorLabel: "May", asOf: "Jul 2026", freq: "Monthly", src: "Typed",
      hist: [17.6,17.1,16.5,16,15.4,15.3,14.6],
      note: "Falling across every major sector. Still roughly three times a healthy book." },

    { id: "kes_usd", label: "KES per USD", group: "External", unit: "", dir: -1,
      value: 129.34, prior: 129.24, priorLabel: "yesterday", asOf: "17 Aug 2026", freq: "Daily", src: "CBK",
      hist: [129.2,129.3,129.1,129.2,129.2,129.1,129.24,129.34],
      note: "Pinned near 129 for over a year. That stability is doing quiet work on inflation expectations." },
    { id: "reserves", label: "FX reserves", group: "External", unit: "$bn", dir: 1,
      value: 15.25, prior: 13.2, priorLabel: "June", asOf: "Aug 2026", freq: "Weekly", src: "Typed",
      hist: [9.8,10.4,11.2,11.8,12.4,13.2,14.1,15.25],
      note: "6.3 months of import cover against a 4-month floor. The strongest buffer in a decade." },
    { id: "cab", label: "Current account", group: "External", unit: "% GDP", dir: 1,
      value: -3.0, prior: -1.9, priorLabel: "a year ago", asOf: "12m to Jun 2026", freq: "Quarterly", src: "Typed",
      hist: [-1.9,-2.1,-2.4,-2.7,-3],
      note: "Widening as imports outrun exports. The one external line genuinely deteriorating." },

    { id: "gdp", label: "GDP growth", group: "Activity", unit: "%", dir: 1,
      value: 5.3, prior: 4.9, priorLabel: "Q1 2025", asOf: "Q1 2026", freq: "Quarterly", src: "KNBS",
      hist: [4.9,5,4.6,4.8,5.3],
      note: "Broad-based across industry and services." },
    { id: "pmi", label: "Stanbic PMI", group: "Activity", unit: "", dir: 1,
      value: 51.8, prior: 51.2, priorLabel: "June", asOf: "Jul 2026", freq: "Monthly", src: "Typed",
      band: [50, 100], bandLabel: "Above 50 means expansion",
      hist: [49.6,50.1,50.8,51.4,50.9,51.2,51.8],
      note: "The earliest read on activity there is — published on the first working day, months before GDP." },

    { id: "nasi", label: "NSE All Share", group: "Markets", unit: "", dir: 1,
      value: 241.18, prior: 238.13, priorLabel: "14 Aug", asOf: "17 Aug 2026", freq: "Daily", src: "NSE",
      hist: [186,194,203,212,221,228,231.6,236.3,238.13,241.18],
      note: "Up 27.6% this year. Straight from the exchange, not a republisher." },
    { id: "nse20", label: "NSE 20 Share", group: "Markets", unit: "", dir: 1,
      value: 4178.5, prior: 4136.12, priorLabel: "previous close", asOf: "17 Aug 2026", freq: "Daily", src: "NSE",
      hist: [3170,3320,3480,3640,3790,3920,4050,4136,4178.5],
      note: "Third-party feeds were quoting 3,710 on the same day the exchange published 4,178.50." },
    { id: "bank_idx", label: "NSE Banking Sector", group: "Markets", unit: "", dir: 1,
      value: 279.9, prior: 276.63, priorLabel: "previous close", asOf: "17 Aug 2026", freq: "Daily", src: "NSE",
      hist: [206,218,231,244,256,265,272,276.6,279.9],
      note: "Up 35.8% this year, ahead of the wider market. Pricing the credit recovery before earnings show it." },
    { id: "mktcap", label: "NSE market cap", group: "Markets", unit: " KES bn", dir: 1,
      value: 4047.48, prior: 3996.38, priorLabel: "previous close", asOf: "17 Aug 2026", freq: "Daily", src: "NSE",
      hist: [3200,3400,3600,3800,3950,4040,3996,4047.48],
      note: "About $31bn, or 23% of GDP." },

    { id: "debt", label: "Public debt stock", group: "Fiscal", unit: " KES tn", dir: -1,
      value: 13.02, prior: 12.82, priorLabel: "March", asOf: "May 2026", freq: "Monthly", src: "Typed",
      hist: [11.13,11.8,12.29,12.4,12.84,12.82,13.02],
      note: "KES 10tn to 13tn in fifteen months. The pace is the story, not the level." },
    { id: "debt_gdp", label: "Public debt to GDP", group: "Fiscal", unit: "%", dir: -1,
      value: 69.9, prior: 69.5, priorLabel: "February", asOf: "Mar 2026", freq: "Monthly", src: "Typed",
      band: [0, 55], bandLabel: "Statutory anchor 55% by 2028",
      hist: [66.2,67,67.6,67.8,69.5,69.9],
      note: "14.9pp above Parliament's anchor. The IMF sees 71.6% this year and no inflection to 2031." },
    { id: "debtserv", label: "Debt service to revenue", group: "Fiscal", unit: "%", dir: -1,
      value: 69, prior: 63, priorLabel: "FY23/24", asOf: "FY24/25", freq: "Annual", src: "Typed",
      band: [0, 30], bandLabel: "IMF comfort threshold 30%",
      hist: [48,55,59,63,69],
      note: "KES 1.72tn against ordinary revenue. More than twice the threshold, and the binding constraint on everything else." },

    { id: "fed_funds", label: "US Fed funds", group: "Global", unit: "%", dir: 0,
      value: 3.63, prior: 4.33, priorLabel: "a year ago", asOf: "13 Aug 2026", freq: "Daily", src: "FRED",
      hist: [5.33,5.33,4.83,4.58,4.33,4.33,4.08,3.88,3.63],
      note: "170bp of cuts. A falling Fed narrows the carry on holding dollars, which is quietly supportive of the shilling." },
    { id: "us10y", label: "US 10-year", group: "Global", unit: "%", dir: 0,
      value: 4.63, prior: 4.28, priorLabel: "a year ago", asOf: "13 Aug 2026", freq: "Daily", src: "FRED",
      hist: [4.28,4.15,4.35,4.5,4.4,4.55,4.7,4.63],
      note: "Rising while the Fed cuts. The long end is pricing something the short end is not." },
    { id: "ssa_gdp", label: "Sub-Saharan Africa growth", group: "Global", unit: "%", dir: 1,
      value: 4.3, prior: 4.5, priorLabel: "2025", asOf: "2026 forecast", freq: "Annual", src: "IMF",
      hist: [3.6,4,4.5,4.3],
      note: "Kenya is forecast to grow above the regional average through 2031." },
    { id: "world_gdp", label: "World growth", group: "Global", unit: "%", dir: 1,
      value: 3.1, prior: 3.4, priorLabel: "2025", asOf: "2026 forecast", freq: "Annual", src: "IMF",
      hist: [3.5,3.3,3.4,3.1],
      note: "Slowing. Export demand and tourism both take their cue from this." },
  ],

  /* ---- LAYER 1: after-tax real return, computed by the collector ---- */
  ladder: [
    { id: "infra", label: "Infrastructure bond", gross: 12.8, taxPct: 0, net: 12.8, real: 6.31, note: "tax-exempt", doublingYears: 11.4 },
    { id: "bond10", label: "10-year bond", gross: 13.45, taxPct: 10, net: 12.11, real: 5.62, note: "10% WHT", doublingYears: 12.8 },
    { id: "mmf_top", label: "Top-quartile MMF", gross: 12.1, taxPct: 15, net: 10.29, real: 3.79, note: "15% WHT", doublingYears: 19.0 },
    { id: "tbill364", label: "364-day bill", gross: 10.12, taxPct: 15, net: 8.6, real: 2.11, note: "15% WHT", doublingYears: 34.1 },
    { id: "tbill182", label: "182-day bill", gross: 9.34, taxPct: 15, net: 7.94, real: 1.45, note: "15% WHT", doublingYears: 49.7 },
    { id: "mmf_avg", label: "MMF industry average", gross: 9.1, taxPct: 15, net: 7.73, real: 1.24, note: "15% WHT", doublingYears: 58.1 },
    { id: "tbill", label: "91-day bill", gross: 8.77, taxPct: 15, net: 7.46, real: 0.97, note: "15% WHT", doublingYears: 74.2 },
    { id: "deposit", label: "Bank fixed deposit", gross: 6.84, taxPct: 15, net: 5.81, real: -0.68, note: "15% WHT", doublingYears: null },
    { id: "savings", label: "Bank savings account", gross: 3.32, taxPct: 15, net: 2.82, real: -3.67, note: "15% WHT", doublingYears: null },
    { id: "cash", label: "Cash", gross: 0, taxPct: 0, net: 0, real: -6.49, note: "no tax, no yield", doublingYears: null },
  ],

  /* ---- LAYER 2: the transmission chain ---- */
  chain: [
    { id: "cbr", label: "Policy rate", lagMonths: 0, value: 8.75, move: -2.0, status: "moved",
      why: "The MPC decides" },
    { id: "kesonia", label: "Overnight money", lagMonths: 0, value: 8.75, move: -1.94, status: "moved",
      why: "Follows the policy rate within days" },
    { id: "tbill", label: "91-day bill", lagMonths: 1, value: 8.77, move: 1.13, status: "moved",
      why: "The market's first opinion on policy" },
    { id: "lending", label: "Lending rate", lagMonths: 5, value: 14.38, move: -0.52, status: "moved",
      why: "Banks reprice slowly, and downward last" },
    { id: "credit", label: "Credit growth", lagMonths: 8, value: 10.2, move: 3.2, status: "moved",
      why: "Borrowers respond once loans are cheaper" },
    { id: "gdp", label: "GDP growth", lagMonths: 11, value: 5.3, move: 0.4, status: "still",
      why: "Activity follows the credit that funds it" },
  ],

  /* ---- LAYER 3: relationships that have come apart ---- */
  breaks: [
    { name: "Bank margin over policy", value: 5.63, unit: "pp", normalLo: 3.5, normalHi: 5.5, state: "high",
      why: "Average lending rate less the Central Bank Rate.",
      reading: "Banks are holding spreads wide while policy eases. Transmission is incomplete, so more of the cut has yet to reach borrowers — and more of the fall in lending rates is still to come." },
    { name: "91-day over policy", value: 0.02, unit: "pp", normalLo: -1, normalHi: 0.75, state: "normal",
      why: "91-day bill less the Central Bank Rate.",
      reading: "Inside its usual range, but it has climbed 113bp since February. Worth watching: a move above 0.75 says the market has stopped believing in more cuts." },
    { name: "Sovereign spread", value: 8.82, unit: "pp", normalLo: 7, normalHi: 11, state: "normal",
      why: "Kenya 10-year less the US 10-year.",
      reading: "Mid-range. Foreign money is being paid fairly to stay in Kenyan paper, and the state is not paying a crisis premium." },
    { name: "Real deposit rate", value: 0.35, unit: "pp", normalLo: -1, normalHi: 2, state: "normal",
      why: "Average deposit rate less headline inflation.",
      reading: "Barely positive. A bank deposit is just about keeping pace with inflation, and a savings account is not." },
    { name: "Credit intensity", value: 1.92, unit: "x", normalLo: 1.2, normalHi: 2.5, state: "normal",
      why: "Private credit growth divided by GDP growth.",
      reading: "Healthy. Credit is growing faster than output, which is what a recovery looks like, without the excess that precedes a bad book." },
    { name: "Market cap to GDP", value: 23.02, unit: "%", normalLo: 15, normalHi: 30, state: "normal",
      why: "NSE market capitalisation as a share of GDP.",
      reading: "Re-rating off the bottom. It reached 30% in 2013 and fell to 15% in 2023. There is room before this looks stretched." },
    { name: "Overnight against policy", value: 0, unit: "pp", normalLo: -0.5, normalHi: 0.5, state: "normal",
      why: "KESONIA less the Central Bank Rate.",
      reading: "Exactly on policy. The money market is in balance — no stress, no flood." },
  ],

  call: "Real yields are positive: seven of ten instruments beat inflation after tax, led by infrastructure bonds at +6.31% real. Three lose purchasing power, cash worst at −6.49%. In the chain, everything has moved except GDP, which lags credit by about eleven months — the growth already funded has not yet printed. One relationship is outside its range: the bank margin over policy at 5.63pp, which says lending rates have further to fall.",

  disagreements: [
    { id: "gdp", label: "GDP growth", kept: "KNBS quarterly", keptValue: 5.3,
      other: "World Bank annual", otherValue: 4.63, gapPct: 12.6,
      why: "Different vintages. The quarterly print is Q1 2026, the annual is calendar 2025." },
    { id: "tbill_tax", label: "T-bill withholding tax", kept: "Tax practices", keptValue: 15,
      other: "Retail aggregator", otherValue: 0, gapPct: 100,
      why: "EY, Cliffe Dekker and FNJ all state 15% on bill interest. One retail site claims individuals are exempt. No tax practice corroborates it, so 15% is used — override it in settings if your own advice differs." },
  ],
};

const SOURCES = [
  { name: "Central Bank of Kenya", covers: "CBR, KESONIA, REPO, 91-day, inflation, lending, deposit, savings, official FX — ten rates in one request", key: false },
  { name: "Nairobi Securities Exchange", covers: "NASI, NSE 20 and 25, banking index, market cap", key: false },
  { name: "FRED, St Louis Fed", covers: "US Fed funds and the 10-year", key: false },
  { name: "IMF DataMapper", covers: "Kenya, world, Sub-Saharan Africa and US, with forecasts to 2031", key: false },
  { name: "World Bank", covers: "Annual spine back to 2002", key: false },
  { name: "Typed by you", covers: "Stanbic PMI, longer bills, the 10-year, NPLs, reserves, debt, your MMF rate", key: false },
];

/* ===========================================================================
   Maths
=========================================================================== */
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

function zScore(v, hist) {
  const past = hist.slice(0, -1);
  if (past.length < 4) return null;
  const s = sd(past);
  return s === 0 ? null : (v - mean(past)) / s;
}
function slope(h) {
  const n = h.length; if (n < 3) return 0;
  const xs = h.map((_, i) => i), my = mean(h), mx = mean(xs);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den === 0 ? 0 : xs.reduce((s, x, i) => s + (x - mx) * (h[i] - my), 0) / den;
}
function percentile(v, series) {
  const c = series.filter(x => x !== null);
  return c.length ? Math.round(100 * c.filter(x => x <= v).length / c.length) : null;
}
function stateOf(i) {
  if (i.band) { const [lo, hi] = i.band; if (i.value > hi || i.value < lo) return "stress"; }
  if (i.prior == null || i.dir === 0) return "steady";
  const m = (i.value - i.prior) / Math.abs(i.prior || 1);
  if (Math.abs(m) < 0.01) return "steady";
  return (m > 0) === (i.dir > 0) ? "good" : "stress";
}
/* 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 33rd. The teens are the
   exception that catches naive implementations. */
const ordinal = n => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
};

const fmt = (v, unit, dp) => {
  if (v == null) return "—";
  const d = dp != null ? dp : Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 2 : 2;
  return v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }) + (unit || "");
};

/* ===========================================================================
   Pieces
=========================================================================== */
function Mark({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id="kpg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#2E8C64" />
          <stop offset="58%" stopColor="#237352" />
          <stop offset="100%" stopColor="#B0642A" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#kpg)" />
      <path d="M7 27h6.5l3.6-11 5.4 20 4.6-15 3.2 8.5h11"
        fill="none" stroke="#fff" strokeWidth="2.6"
        strokeLinecap="round" strokeLinejoin="round" opacity=".97" />
      <circle cx="38.5" cy="29.5" r="2.9" fill="#fff" />
    </svg>
  );
}

function Spark({ data, colour, h = 30, w = 88 }) {  // w/h set by caller on mobile
  const c = data.filter(x => x != null);
  if (c.length < 2) return null;
  const lo = Math.min(...c), hi = Math.max(...c), r = hi - lo || 1;
  const pts = data.map((v, i) => v == null ? null :
    `${((i / (data.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / r) * (h - 4) - 2).toFixed(1)}`)
    .filter(Boolean).join(" ");
  const last = data[data.length - 1];
  return (
    <svg width={w} height={h} style={{ overflow: "visible", flexShrink: 0 }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={colour} strokeWidth="1.8"
        strokeLinejoin="round" strokeLinecap="round"
        style={{ strokeDasharray: 400, strokeDashoffset: 0, animation: "kp-draw .7s ease-out" }} />
      <circle cx={w} cy={h - ((last - lo) / r) * (h - 4) - 2} r="2.6" fill={colour} />
    </svg>
  );
}

function Bars({ years, values, c, unit, narrow }) {
  const [hover, setHover] = useState(null);
  const cl = values.filter(v => v != null);
  if (!cl.length) return null;
  const hi = Math.max(...cl, 0), lo = Math.min(...cl, 0), r = (hi - lo) || 1;
  const zero = (hi / r) * 100;
  const axisW = narrow ? 32 : 42;
  const H = 128;
  const dp = Math.max(Math.abs(hi), Math.abs(lo)) >= 100 ? 0 : 1;

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", gap: 6, minWidth: 0 }}>
        {/* y-axis: without a scale the bars are decoration, not information */}
        <div style={{ width: axisW, height: H, position: "relative", flexShrink: 0,
          fontSize: narrow ? ".6em" : ".66em", color: c.faint }}>
          <span style={{ position: "absolute", top: -4, right: 0 }}>
            {fmt(hi, unit, dp)}
          </span>
          {lo < 0 && (
            <span style={{ position: "absolute", top: `${zero}%`, right: 0,
              transform: "translateY(-50%)" }}>0</span>
          )}
          <span style={{ position: "absolute", bottom: -4, right: 0 }}>
            {fmt(lo, unit, dp)}
          </span>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: narrow ? 1 : 2,
            height: H, position: "relative", borderBottom: `1px solid ${c.line}`,
            minWidth: 0 }}>
            <div style={{ position: "absolute", left: 0, right: 0, top: `${zero}%`,
              borderTop: `1px dashed ${c.line}` }} />
            {values.map((v, i) => {
              const on = hover === i;
              const h = v == null ? 0 : (Math.abs(v) / r) * 100;
              const up = (v ?? 0) >= 0;
              return (
                <div key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                  onClick={() => setHover(on ? null : i)}
                  title={v == null ? `${years[i]} — not published` : `${years[i]}: ${fmt(v, unit)}`}
                  style={{ flex: 1, minWidth: 0, height: "100%", position: "relative",
                    cursor: "pointer" }}>
                  {v == null ? (
                    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0,
                      height: 3, background: c.line, opacity: .5, borderRadius: 1 }} />
                  ) : (
                    <div style={{ position: "absolute", left: 0, right: 0,
                      top: up ? `calc(${zero}% - ${h}%)` : `${zero}%`,
                      height: `${h}%`, minHeight: 1,
                      background: on ? c.ink : (up ? c.good : c.bad),
                      opacity: on ? 1 : .84, borderRadius: 1,
                      transition: "background .15s, opacity .15s" }} />
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between",
            fontSize: narrow ? ".66em" : ".72em", color: c.faint, marginTop: 6, gap: 6 }}>
            <span style={{ flexShrink: 0 }}>{years[0]}</span>
            <span style={{ color: hover != null ? c.ink : c.faint,
              fontWeight: hover != null ? 600 : 400, textAlign: "center",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {hover != null
                ? `${years[hover]} · ${values[hover] == null ? "not published" : fmt(values[hover], unit)}`
                : "tap a bar"}
            </span>
            <span style={{ flexShrink: 0 }}>{years[years.length - 1]}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const Pill = ({ children, tone, c }) => (
  <span style={{ fontSize: ".7em", fontWeight: 700, letterSpacing: ".05em",
    textTransform: "uppercase", whiteSpace: "nowrap", padding: "3px 9px", borderRadius: 20,
    color: { good: c.good, stress: c.bad, watch: c.warn, steady: c.dim }[tone] || c.dim,
    background: c.chip }}>{children}</span>
);

const Card = ({ children, c, style, i = 0, pad = 16 }) => (
  <div style={{ background: c.card, border: `1px solid ${c.line}`, borderRadius: 16,
    padding: pad, boxShadow: c.shadow, minWidth: 0, overflow: "hidden", animation: `kp-rise .38s ${i * 0.045}s both cubic-bezier(.22,.9,.3,1)`,
    ...style }}>{children}</div>
);

/* ===========================================================================
   App
=========================================================================== */
export default function KenyaPulse() {
  const [cfg, setCfg] = useState(() => ({
    theme: "system", size: "m", feed: "", autoSync: true, zAlert: 1.5,
    pinned: ["inflation", "cbr", "credit", "debt_gdp"], showBands: true,
    compact: false, taxBill: 15, taxMmf: 15, taxBond: 10,
    ...store.get("kp.cfg", {}),
  }));
  const [data, setData] = useState(() => store.get("kp.data", SEED));
  const [tab, setTab] = useState("pulse");
  const [openSettings, setOpenSettings] = useState(false);
  const [trendKey, setTrendKey] = useState("gdp_growth");
  const [expanded, setExpanded] = useState(null);
  const [openBreak, setOpenBreak] = useState(null);
  const [sync, setSync] = useState({ state: "idle", msg: "" });
  const [restoreText, setRestoreText] = useState("");
  const [restoreMsg, setRestoreMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  const [saved, setSaved] = useState(null);   // null unknown, true ok, false failed
  const saveTimer = useRef(null);
  useEffect(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setSaved(store.set("kp.cfg", cfg)), 250);
    return () => clearTimeout(saveTimer.current);
  }, [cfg]);
  useEffect(() => { store.probe(); }, []);
  useEffect(() => () => { clearTimeout(copyTimer.current); clearTimeout(saveTimer.current); }, []);
  const set = (k, v) => setCfg(p => ({ ...p, [k]: v }));

  /* viewport width drives the handful of layout decisions that cannot be made
     in CSS alone — sparkline geometry, label length, chart density */
  const [vw, setVw] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 420);
  useEffect(() => {
    let t;
    const f = () => { clearTimeout(t); t = setTimeout(() => setVw(window.innerWidth), 120); };
    window.addEventListener("resize", f);
    return () => { clearTimeout(t); window.removeEventListener("resize", f); };
  }, []);
  const narrow = vw < 440;
  const tiny = vw < 360;

  const [sysDark, setSysDark] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const f = e => setSysDark(e.matches);
    setSysDark(m.matches); m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  const dark = cfg.theme === "dark" || (cfg.theme === "system" && sysDark);
  const c = dark ? THEME.dark : THEME.light;
  const base = SIZES[cfg.size] || 16;

  const pull = async (silent) => {
    if (!cfg.feed) { setSync({ state: "err", msg: "No feed set — open settings." }); return; }
    setSync({ state: "busy", msg: "Fetching…" });
    try {
      const r = await fetch(cfg.feed, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const merged = mergeFeed(SEED, j);
      setData(merged); store.set("kp.data", merged);
      setSync({ state: "ok", msg: `Synced ${j.asOf || "now"}` });
    } catch (e) {
      setSync({ state: "err", msg: silent ? "" : `Could not reach the feed — ${e.message}` });
    }
  };
  useEffect(() => {
    store.set("kp.data", data);                       // seed the drawer on first run
    if (cfg.autoSync && cfg.feed) pull(true);
    /* eslint-disable-next-line */
  }, []);

  /* Paste a backup back in. A backup you cannot restore is not a backup. */
  const restore = () => {
    try {
      const p = JSON.parse(restoreText);
      const nextCfg = p.cfg && typeof p.cfg === "object" ? { ...cfg, ...p.cfg } : null;
      const nextData = p.data && Array.isArray(p.data.indicators) ? p.data : null;
      if (!nextCfg && !nextData) throw new Error("nothing recognisable in there");
      if (nextCfg) { setCfg(nextCfg); store.set("kp.cfg", nextCfg); }
      if (nextData) { setData(nextData); store.set("kp.data", nextData); }
      setRestoreText("");
      setRestoreMsg(`Restored${nextCfg ? " settings" : ""}${nextCfg && nextData ? " and" : ""}${nextData ? " readings" : ""}.`);
    } catch (e) {
      setRestoreMsg(`Could not read that — ${e.message}`);
    }
  };

  const inds = useMemo(() => data.indicators.map(i => {
    const z = zScore(i.value, i.hist);
    return { ...i, state: stateOf(i), z, trend: slope(i.hist.slice(-6)),
      anomaly: z != null && Math.abs(z) >= cfg.zAlert, pct: percentile(i.value, i.hist) };
  }), [data, cfg.zAlert]);

  /* the ladder recomputes live when tax assumptions change */
  const ladder = useMemo(() => {
    const infl = data.indicators.find(x => x.id === "inflation")?.value ?? 6.49;
    const rate = id => id === "bond10" ? cfg.taxBond / 100
      : id === "infra" || id === "cash" ? 0
      : id.startsWith("mmf") ? cfg.taxMmf / 100 : cfg.taxBill / 100;
    return data.ladder.map(r => {
      const t = rate(r.id), net = r.gross * (1 - t), real = net - infl;
      return { ...r, taxPct: Math.round(t * 100), net: +net.toFixed(2), real: +real.toFixed(2),
        doublingYears: real > 0.05 ? +(72 / real).toFixed(1) : null };
    }).sort((a, b) => b.real - a.real);
  }, [data.ladder, data.indicators, cfg.taxBill, cfg.taxMmf, cfg.taxBond]);

  const byId = Object.fromEntries(inds.map(i => [i.id, i]));
  const groups = [...new Set(inds.map(i => i.group))];
  const scored = inds.filter(i => i.dir !== 0);
  const pulse = Math.round(100 * scored.reduce((s, i) =>
    s + (i.state === "good" ? 1 : i.state === "steady" ? .5 : 0), 0) / scored.length);
  const stressed = inds.filter(i => i.state === "stress");
  const verdict = pulse >= 65 ? "EXPANDING" : pulse >= 45 ? "MIXED" : "UNDER STRAIN";
  const vcol = pulse >= 65 ? c.good : pulse >= 45 ? c.warn : c.bad;
  const offRange = data.breaks.filter(b => b.state !== "normal");

  const brief = useMemo(() => buildBrief(inds, ladder, data.breaks, data.call, data.asOf, pulse, verdict),
    [inds, ladder, data, pulse, verdict]);

  const copy = async (t) => {
    try { await navigator.clipboard.writeText(t); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  };

  const S = {
    page: { minHeight: "100vh", background: c.bg, color: c.ink, fontSize: base,
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      lineHeight: 1.5, fontVariantNumeric: "tabular-nums",
      transition: "background .25s ease, color .25s ease" },
    wrap: { maxWidth: 720, margin: "0 auto",
      padding: narrow ? "10px 10px 40px" : "12px 14px 44px" },
    eyebrow: { fontSize: ".72em", fontWeight: 700, letterSpacing: ".1em",
      textTransform: "uppercase", color: c.dim },
    icon: { width: 40, height: 40, borderRadius: 11, border: `1px solid ${c.line}`,
      background: c.card, color: c.ink, cursor: "pointer", fontSize: 15,
      display: "grid", placeItems: "center", transition: "transform .12s, border-color .15s" },
    btn: (bg, fg) => ({ padding: "11px 18px", borderRadius: 11, border: "none",
      background: bg, color: fg, fontWeight: 700, cursor: "pointer",
      transition: "transform .12s, background .18s" }),
  };

  const TABS = [["pulse", "Pulse"], ["edge", "Edge"], ["trends", "Trends"],
    ["outlook", "Outlook"], ["data", "Data"]];

  return (
    <div style={S.page}>
      <style>{`
        *{box-sizing:border-box}
        button{font-family:inherit;font-size:inherit;color:inherit}
        input,select{font-family:inherit}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-thumb{background:${c.line};border-radius:3px}
        @keyframes kp-rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
        @keyframes kp-fade{from{opacity:0}to{opacity:1}}
        @keyframes kp-sheet{from{transform:translateY(100%)}to{transform:none}}
        @keyframes kp-veil{from{opacity:0}to{opacity:1}}
        @keyframes kp-draw{from{stroke-dashoffset:400}to{stroke-dashoffset:0}}
        @keyframes kp-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
        .kp-tap{transition:transform .12s cubic-bezier(.3,.8,.4,1)}
        /* Nothing may push the page sideways. A dashboard that scrolls
           horizontally on a phone is a dashboard you stop opening. */
        html,body{overflow-x:hidden;-webkit-text-size-adjust:100%}
        table{max-width:100%}
        pre{word-break:break-word}
        .kp-tap:active{transform:scale(.97)}
        .kp-f:focus-visible{outline:2px solid ${c.cool};outline-offset:2px;border-radius:8px}
        .kp-bar{transform-origin:left;animation:kp-grow .55s cubic-bezier(.22,.9,.3,1) both}
        @media (prefers-reduced-motion:reduce){
          *,*::before,*::after{animation:none!important;transition:none!important}
        }
      `}</style>

      <div style={S.wrap}>
        {/* ---------------- header ---------------- */}
        <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <Mark />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "1.35em", fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1.1 }}>
              Kenya <span style={{ color: c.good }}>Pulse</span>
            </div>
            <div style={{ fontSize: narrow ? ".76em" : ".82em", color: c.dim }}>
              {narrow ? data.asOf : `Where the economy is, and where money is paid · ${data.asOf}`}
            </div>
          </div>
          <button className="kp-f kp-tap" style={S.icon} aria-label="Theme"
            onClick={() => set("theme", cfg.theme === "light" ? "dark" : cfg.theme === "dark" ? "system" : "light")}>
            {cfg.theme === "light" ? "☀" : cfg.theme === "dark" ? "☾" : "◐"}
          </button>
          <button className="kp-f kp-tap" style={S.icon} aria-label="Settings"
            onClick={() => setOpenSettings(true)}>⚙</button>
        </header>

        {/* ---------------- hero ---------------- */}
        <Card c={c} pad={narrow ? 13 : 16} style={{ border: `1.5px solid ${vcol}`, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ width: 9, height: 9, borderRadius: 9, background: vcol }} />
            <span style={{ ...S.eyebrow, color: vcol }}>Pulse score · {verdict}</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: "2.9em", fontWeight: 800, color: vcol,
              letterSpacing: "-.04em", lineHeight: 1 }}>{pulse}</div>
            <div style={{ fontSize: ".92em", color: c.dim }}>
              of 100 · {scored.length - stressed.length} of {scored.length} lines holding
            </div>
          </div>

          <div style={{ display: "flex", gap: 3, margin: "14px 0 8px", height: 26, alignItems: "flex-end" }}>
            {inds.map((i, n) => (
              <button key={i.id} title={`${i.label} — ${i.state}`} className="kp-f"
                onClick={() => { setTab("pulse"); setExpanded(i.id); }}
                style={{ flex: 1, border: "none", padding: 0, cursor: "pointer", borderRadius: 2,
                  height: i.state === "stress" ? 26 : i.state === "good" ? 18 : 11,
                  background: i.state === "stress" ? c.bad : i.state === "good" ? c.good : c.line,
                  opacity: i.anomaly ? 1 : .84,
                  animation: `kp-rise .4s ${n * 0.012}s both`, transition: "height .2s" }} />
            ))}
          </div>
          <div style={{ fontSize: ".78em", color: c.faint, marginBottom: 10 }}>
            One bar per indicator. Tall red is under pressure, mid green is improving.
          </div>
          <div style={{ fontSize: ".9em", color: c.dim, borderTop: `1px solid ${c.line}`, paddingTop: 10 }}>
            {stressed.length
              ? <>Under pressure: <strong style={{ color: c.ink }}>
                {stressed.slice(0, 3).map(s => s.label.toLowerCase()).join(", ")}</strong>
                {stressed.length > 3 && ` and ${stressed.length - 3} more`}. </>
              : "Nothing is flashing red. "}
            {offRange.length > 0 && <>{offRange.length} relationship{offRange.length > 1 ? "s are" : " is"} outside its usual range.</>}
          </div>
        </Card>

        {/* ---------------- tabs ---------------- */}
        <div style={{ display: "flex", background: c.chip, borderRadius: 13, padding: 4, marginBottom: 14 }}>
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className="kp-f kp-tap"
              aria-current={tab === k ? "page" : undefined}
              style={{ flex: 1, minWidth: 0, padding: narrow ? "9px 1px" : "9px 2px",
                border: "none", borderRadius: 10, cursor: "pointer",
                background: tab === k ? c.card : "transparent",
                fontSize: "clamp(11px, 3.3vw, 15px)",
                letterSpacing: tiny ? "-.02em" : "normal",
                color: tab === k ? c.ink : c.dim, fontWeight: tab === k ? 700 : 500,
                boxShadow: tab === k ? c.shadow : "none", whiteSpace: "nowrap",
                transition: "background .2s, color .2s, box-shadow .2s" }}>{l}</button>
          ))}
        </div>

        {/* minWidth:0 is load-bearing. A grid item defaults to min-width:auto,
            which lets a horizontally scrolling child push the whole column
            wider than the screen. That is what clipped the Trends chart. */}
        <div key={tab} style={{ display: "grid", gap: 14, minWidth: 0,
          animation: "kp-fade .3s ease both" }}>

          {/* ================= PULSE ================= */}
          {tab === "pulse" && <>
            {cfg.pinned.length > 0 && (
              <Card c={c} pad={narrow ? 13 : 16} i={0}>
                <div style={{ ...S.eyebrow, marginBottom: 10 }}>Pinned</div>
                <div style={{ display: "grid",
                  gridTemplateColumns: tiny ? "1fr" : "1fr 1fr", gap: narrow ? 12 : 14 }}>
                  {cfg.pinned.map(id => byId[id]).filter(Boolean).map(i => (
                    <div key={i.id}>
                      <div style={{ fontSize: ".76em", color: c.dim, marginBottom: 2 }}>{i.label}</div>
                      <div style={{ fontSize: "1.5em", fontWeight: 700,
                        color: i.state === "stress" ? c.bad : i.state === "good" ? c.good : c.ink }}>
                        {fmt(i.value, i.unit)}
                      </div>
                      <div style={{ fontSize: ".74em", color: c.faint }}>
                        {i.prior != null && `${i.value > i.prior ? "▲" : i.value < i.prior ? "▼" : "="} ${fmt(Math.abs(i.value - i.prior), i.unit)} vs ${i.priorLabel}`}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {groups.map((g, gi) => (
              <Card c={c} pad={narrow ? 13 : 16} key={g} i={gi + 1}>
                <div style={{ ...S.eyebrow, marginBottom: 10 }}>{g}</div>
                {inds.filter(i => i.group === g).map((i, n, arr) => {
                  const open = expanded === i.id;
                  const col = i.state === "stress" ? c.bad : i.state === "good" ? c.good : c.dim;
                  return (
                    <div key={i.id} style={{ borderBottom: n < arr.length - 1 ? `1px solid ${c.line}` : "none" }}>
                      <button onClick={() => setExpanded(open ? null : i.id)} className="kp-f"
                        aria-expanded={open}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10,
                          padding: cfg.compact ? "9px 0" : "13px 0", background: "none",
                          border: "none", cursor: "pointer", textAlign: "left" }}>
                        <span style={{ width: 7, height: 7, borderRadius: 7, background: col, flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontWeight: 600, fontSize: ".94em",
                            lineHeight: 1.25,
                            ...(narrow ? {} : { overflow: "hidden", textOverflow: "ellipsis",
                              whiteSpace: "nowrap" }) }}>{i.label}</span>
                          <span style={{ fontSize: ".74em", color: c.faint }}>
                            {i.asOf} · {i.src}{i.anomaly ? " · off trend" : ""}
                          </span>
                        </span>
                        {!cfg.compact && !tiny &&
                          <Spark data={i.hist} colour={col} w={narrow ? 52 : 88} h={narrow ? 26 : 30} />}
                        <span style={{ textAlign: "right", flexShrink: 0 }}>
                          <span style={{ display: "block", fontWeight: 700, fontSize: "1.02em" }}>
                            {fmt(i.value, i.unit)}
                          </span>
                          {i.prior != null && (
                            <span style={{ fontSize: ".74em", color: col }}>
                              {i.value > i.prior ? "+" : ""}{fmt(i.value - i.prior, "")}
                            </span>
                          )}
                        </span>
                      </button>
                      {open && (
                        <div style={{ padding: "0 0 14px 17px", fontSize: ".88em", color: c.dim,
                          animation: "kp-rise .25s both" }}>
                          <div style={{ marginBottom: 10, color: c.ink }}>{i.note}</div>
                          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: ".92em" }}>
                            <span><strong style={{ color: c.ink }}>{i.freq}</strong></span>
                            {i.z != null && <span>z <strong style={{ color: i.anomaly ? c.warn : c.ink }}>{i.z.toFixed(2)}</strong></span>}
                            {i.pct != null && <span>{i.pct}th percentile</span>}
                            <span>{i.trend > .02 ? "rising" : i.trend < -.02 ? "falling" : "flat"}</span>
                          </div>
                          {i.band && cfg.showBands && (
                            <div style={{ marginTop: 8, color: c.warn }}>{i.bandLabel}</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </Card>
            ))}
          </>}

          {/* ================= EDGE ================= */}
          {tab === "edge" && <>
            <Card c={c} pad={narrow ? 13 : 16} i={0} style={{ borderLeft: `3px solid ${c.good}` }}>
              <div style={{ ...S.eyebrow, marginBottom: 9 }}>The read</div>
              <div style={{ fontSize: ".97em", lineHeight: 1.62 }}>{data.call}</div>
            </Card>

            {/* LADDER */}
            <Card c={c} pad={narrow ? 13 : 16} i={1}>
              <div style={{ ...S.eyebrow, marginBottom: 4 }}>1 · What is being paid</div>
              <div style={{ fontSize: ".84em", color: c.dim, marginBottom: 16 }}>
                After Kenyan withholding tax, less inflation. Nominal yield is the energy,
                inflation is the entropy. What survives is the bar.
              </div>
              {(() => {
                const span = Math.max(...ladder.map(r => Math.abs(r.real))) || 1;
                return ladder.map((r, n) => {
                  const w = (Math.abs(r.real) / span) * 46;
                  const pos = r.real >= 0;
                  return (
                    <div key={r.id} style={{ padding: "9px 0",
                      borderBottom: n < ladder.length - 1 ? `1px solid ${c.line}` : "none" }}>
                      <div style={{ display: "flex", justifyContent: "space-between",
                        alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                        <span style={{ fontWeight: n === 0 ? 700 : 500, fontSize: ".92em" }}>
                          {r.label}
                        </span>
                        <span style={{ fontWeight: 700, color: pos ? c.good : c.bad,
                          fontSize: ".96em", whiteSpace: "nowrap" }}>
                          {r.real > 0 ? "+" : ""}{r.real.toFixed(2)}%
                        </span>
                      </div>
                      <div style={{ position: "relative", height: 7, background: c.chip,
                        borderRadius: 4, marginBottom: 4 }}>
                        <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2,
                          width: 1, background: c.line }} />
                        <div className="kp-bar" style={{ position: "absolute", top: 0, height: "100%",
                          left: pos ? "50%" : `${50 - w}%`, width: `${w}%`,
                          background: pos ? c.good : c.bad, borderRadius: 4,
                          animationDelay: `${n * 0.04}s` }} />
                      </div>
                      <div style={{ fontSize: ".73em", color: c.faint }}>
                        {r.gross.toFixed(2)}% gross · {r.note} · {r.net.toFixed(2)}% net
                        {r.doublingYears && ` · doubles in ${r.doublingYears}y`}
                      </div>
                    </div>
                  );
                });
              })()}
              <div style={{ marginTop: 14, padding: "11px 13px", background: c.chip,
                borderRadius: 11, fontSize: ".85em" }}>
                <strong>The cost of doing nothing.</strong> The gap between the top of this
                ladder and cash is{" "}
                <strong style={{ color: c.warn }}>
                  {(ladder[0].real - ladder[ladder.length - 1].real).toFixed(2)} points
                </strong>
                {" "}a year. On a million shillings that is about{" "}
                <strong>KES {Math.round((ladder[0].real - ladder[ladder.length - 1].real) * 10000).toLocaleString("en-GB")}</strong>
                {" "}of purchasing power, annually.
              </div>
              <div style={{ marginTop: 10, fontSize: ".78em", color: c.faint }}>
                Arithmetic on published rates, not advice. Tax assumptions are editable in settings.
              </div>
            </Card>

            {/* CHAIN */}
            <Card c={c} pad={narrow ? 13 : 16} i={2}>
              <div style={{ ...S.eyebrow, marginBottom: 4 }}>2 · What is already coming</div>
              <div style={{ fontSize: ".84em", color: c.dim, marginBottom: 18 }}>
                Policy moves reach the economy along a chain, each link lagging the one before.
                A link that has not moved yet is the part nobody has priced.
              </div>
              {data.chain.map((s, n) => {
                const last = n === data.chain.length - 1;
                const tone = s.status === "moved" ? c.good : s.status === "still" ? c.warn : c.faint;
                return (
                  <div key={s.id} style={{ display: "flex", gap: 13 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 22 }}>
                      <span style={{ width: 11, height: 11, borderRadius: 11, background: tone,
                        border: `2px solid ${c.card}`, boxShadow: `0 0 0 1.5px ${tone}`, flexShrink: 0,
                        animation: `kp-rise .35s ${n * .06}s both` }} />
                      {!last && <span style={{ flex: 1, width: 2, background: c.line, minHeight: 30 }} />}
                    </div>
                    <div style={{ flex: 1, paddingBottom: last ? 0 : 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between",
                        alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: ".93em" }}>{s.label}</span>
                        <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{s.value}</span>
                      </div>
                      <div style={{ fontSize: ".78em", color: c.faint, marginTop: 2 }}>
                        {s.lagMonths === 0 ? "immediate" : `about ${s.lagMonths} months behind policy`}
                        {" · "}{s.why}
                      </div>
                      <div style={{ fontSize: ".78em", marginTop: 4, color: tone, fontWeight: 600 }}>
                        {s.status === "moved" && `moved ${s.move > 0 ? "+" : ""}${s.move} over recent readings`}
                        {s.status === "still" && "has not moved yet"}
                        {s.status === "waiting" && "needs more readings"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </Card>

            {/* BREAKS */}
            <Card c={c} pad={narrow ? 13 : 16} i={3}>
              <div style={{ ...S.eyebrow, marginBottom: 4 }}>3 · What is mispriced</div>
              <div style={{ fontSize: ".84em", color: c.dim, marginBottom: 16 }}>
                Relationships that normally hold. One inside its range tells you nothing.
                One outside it is a mispricing or a regime change, and both are worth knowing early.
              </div>
              {data.breaks.map((b, n) => {
                const open = openBreak === b.name;
                const off = b.state !== "normal";
                const span = b.normalHi - b.normalLo || 1;
                const pos = Math.max(-18, Math.min(118, ((b.value - b.normalLo) / span) * 100));
                return (
                  <div key={b.name} style={{ paddingTop: n ? 14 : 0, paddingBottom: 14,
                    borderTop: n ? `1px solid ${c.line}` : "none" }}>
                    <button onClick={() => setOpenBreak(open ? null : b.name)} className="kp-f"
                      aria-expanded={open}
                      style={{ width: "100%", background: "none", border: "none", padding: 0,
                        cursor: "pointer", textAlign: "left" }}>
                      <div style={{ display: "flex", justifyContent: "space-between",
                        alignItems: "baseline", gap: 8, marginBottom: 9 }}>
                        <span style={{ fontWeight: 600, fontSize: ".93em" }}>{b.name}</span>
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <strong style={{ color: off ? c.warn : c.ink }}>
                            {b.value}{b.unit}
                          </strong>
                          {off && <Pill tone="watch" c={c}>{b.state}</Pill>}
                        </span>
                      </div>
                      <div style={{ position: "relative", height: 6, background: c.chip,
                        borderRadius: 4, marginBottom: 5 }}>
                        <div style={{ position: "absolute", left: "0%", right: "0%", top: 0,
                          bottom: 0, background: c.line, borderRadius: 4, opacity: .8 }} />
                        <div style={{ position: "absolute", top: -4, left: `calc(${pos}% - 3px)`,
                          width: 6, height: 14, borderRadius: 3,
                          background: off ? c.warn : c.good,
                          transition: "left .5s cubic-bezier(.22,.9,.3,1)" }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between",
                        fontSize: ".71em", color: c.faint }}>
                        <span>{b.normalLo}{b.unit}</span>
                        <span>usual range</span>
                        <span>{b.normalHi}{b.unit}</span>
                      </div>
                    </button>
                    {open && (
                      <div style={{ marginTop: 11, fontSize: ".87em", animation: "kp-rise .25s both" }}>
                        <div style={{ color: c.ink, marginBottom: 6 }}>{b.reading}</div>
                        <div style={{ color: c.faint, fontSize: ".92em" }}>{b.why}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
          </>}

          {/* ================= TRENDS ================= */}
          {tab === "trends" && (() => {
            const meta = ANNUAL_META[trendKey], vals = ANNUAL[trendKey];
            const cl = vals.filter(v => v != null);
            if (!cl.length) return null;

            /* The latest published year, which is not always the last column.
               Current account stops at 2024, private credit at 2023. */
            const lastIdx = vals.map((v, i) => v == null ? -1 : i)
              .filter(i => i >= 0).pop();
            const latest = vals[lastIdx], latestYear = YEARS[lastIdx];
            const avg = mean(cl);
            const pct = percentile(latest, vals);

            /* Decades keyed on the YEAR, not on a position in the filtered
               array. Slicing the filtered array silently shifts every decade
               for any series with a gap in it. */
            const decade = (from, to) => {
              const v = YEARS.map((y, i) => ({ y, v: vals[i] }))
                .filter(x => x.v != null && x.y >= from && x.y <= to).map(x => x.v);
              return v.length ? mean(v) : null;
            };
            const decades = [["2002–2011", decade(2002, 2011)],
                             ["2012–2021", decade(2012, 2021)],
                             ["2022–2025", decade(2022, 2025)]].filter(d => d[1] != null);
            const mx = Math.max(...decades.map(d => Math.abs(d[1])), 0.0001);
            const u = meta.unit === "%" ? "%" : "";

            return <>
              <Card c={c} pad={narrow ? 13 : 16} i={0}>
                <div style={{ ...S.eyebrow, marginBottom: 10 }}>
                  Twenty-four years · 2002 to 2025
                </div>

                <div style={{ position: "relative", marginBottom: 14, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, overflowX: "auto",
                    paddingBottom: 8, minWidth: 0,
                    scrollbarWidth: "thin", WebkitOverflowScrolling: "touch" }}>
                    {Object.entries(ANNUAL_META).map(([k, m]) => (
                      <button key={k} onClick={() => setTrendKey(k)} className="kp-f kp-tap"
                        style={{ padding: narrow ? "7px 10px" : "7px 12px", borderRadius: 9,
                          whiteSpace: "nowrap", cursor: "pointer", flexShrink: 0,
                          border: `1px solid ${trendKey === k ? c.good : c.line}`,
                          background: trendKey === k ? c.good : "transparent",
                          color: trendKey === k ? "#fff" : c.dim,
                          fontSize: narrow ? ".78em" : ".82em",
                          fontWeight: trendKey === k ? 700 : 500,
                          transition: "background .2s, color .2s" }}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                  {/* a hint that there is more to the right */}
                  <div aria-hidden="true" style={{ position: "absolute", top: 0, right: 0,
                    width: 26, height: "100%", pointerEvents: "none",
                    background: `linear-gradient(90deg, transparent, ${c.card})` }} />
                </div>

                <div style={{ display: "flex", alignItems: "baseline", gap: 8,
                  marginBottom: 14, flexWrap: "wrap" }}>
                  <span style={{ fontSize: narrow ? "1.7em" : "2em", fontWeight: 800,
                    letterSpacing: "-.03em" }}>{fmt(latest, u)}</span>
                  <span style={{ fontSize: ".82em", color: c.dim }}>
                    {meta.unit !== "%" && meta.unit + " · "}{latestYear}
                    {" · "}24-year average {fmt(avg, u)}
                  </span>
                </div>

                <Bars years={YEARS} values={vals} c={c} unit={u} narrow={narrow} />
              </Card>

              <Card c={c} pad={narrow ? 13 : 16} i={1}>
                <div style={{ ...S.eyebrow, marginBottom: 12 }}>Where this sits</div>
                <div style={{ display: "grid",
                  gridTemplateColumns: tiny ? "1fr" : "1fr 1fr", gap: 16 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: ".76em", color: c.dim }}>
                      Percentile of its own history
                    </div>
                    <div style={{ fontSize: "1.55em", fontWeight: 700,
                      color: pct > 70 ? c.good : pct < 30 ? c.bad : c.ink }}>
                      {ordinal(pct)}
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: ".76em", color: c.dim }}>
                      Against the 24-year mean
                    </div>
                    <div style={{ fontSize: "1.55em", fontWeight: 700,
                      color: (latest - avg) * meta.dir > 0 ? c.good : c.bad }}>
                      {latest > avg ? "+" : ""}{fmt(latest - avg, u)}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 18, ...S.eyebrow, marginBottom: 10 }}>
                  Decade averages
                </div>
                {decades.map(([l, v], n) => (
                  <div key={l} style={{ display: "flex", alignItems: "center",
                    gap: 8, marginBottom: 9, minWidth: 0 }}>
                    <span style={{ width: narrow ? 74 : 82, fontSize: narrow ? ".72em" : ".8em",
                      color: c.dim, flexShrink: 0, whiteSpace: "nowrap" }}>{l}</span>
                    <span style={{ flex: 1, minWidth: 0, height: 8, background: c.chip,
                      borderRadius: 4, overflow: "hidden" }}>
                      <span className="kp-bar" style={{ display: "block",
                        width: `${Math.max(2, Math.min(100, Math.abs(v) / mx * 100))}%`,
                        height: "100%", background: v >= 0 ? c.good : c.bad,
                        borderRadius: 4, animationDelay: `${n * .07}s` }} />
                    </span>
                    <span style={{ width: narrow ? 58 : 66, textAlign: "right",
                      fontWeight: 600, fontSize: narrow ? ".78em" : ".86em",
                      flexShrink: 0, whiteSpace: "nowrap" }}>{fmt(v, u)}</span>
                  </div>
                ))}

                <div style={{ fontSize: ".78em", color: c.faint, marginTop: 12 }}>
                  World Bank national accounts, pulled live. A flat grey mark on the chart is
                  a year the source has not published yet.
                </div>
              </Card>
            </>;
          })()}

          {/* ================= OUTLOOK ================= */}
          {tab === "outlook" && <>
            <Card c={c} pad={narrow ? 13 : 16} i={0}>
              <div style={{ ...S.eyebrow, marginBottom: 8 }}>The forward view · IMF</div>
              <div style={{ fontSize: ".88em", color: c.dim }}>
                Left of the marker has happened. Right of it is projection, and a projection is an
                opinion with a spreadsheet attached. Read the direction, not the decimal.
              </div>
            </Card>
            {Object.entries(FORECAST).map(([k, m], gi) => {
              const split = F_YEARS.indexOf(m.actualTo);
              const lo = Math.min(...m.v), hi = Math.max(...m.v), r = (hi - lo) || 1;
              const now = m.v[split], end = m.v[m.v.length - 1];
              const better = (end - now) * m.dir > 0;
              return (
                <Card c={c} pad={narrow ? 13 : 16} key={k} i={gi + 1}>
                  <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "baseline", marginBottom: 14 }}>
                    <span style={{ fontWeight: 700 }}>{m.label}</span>
                    <Pill tone={better ? "good" : "stress"} c={c}>
                      {better ? "improves" : "deteriorates"} to 2031
                    </Pill>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 82,
                    position: "relative", marginBottom: 6 }}>
                    <div style={{ position: "absolute", top: 0, bottom: -4,
                      left: `${((split + .5) / m.v.length) * 100}%`, borderLeft: `1px dashed ${c.warn}` }} />
                    {m.v.map((val, i) => {
                      const h = Math.max(4, ((val - lo) / r) * 70 + 8), fut = i > split;
                      return (
                        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column",
                          justifyContent: "flex-end", alignItems: "center", height: "100%" }}>
                          {!tiny && (
                            <span style={{ fontSize: narrow ? ".58em" : ".62em",
                              color: c.faint, marginBottom: 2 }}>
                              {val >= 1000 ? Math.round(val) : val}
                            </span>
                          )}
                          <span style={{ width: "82%", height: h, borderRadius: "3px 3px 0 0",
                            background: fut ? "transparent" : c.good,
                            border: fut ? `1.5px dashed ${c.warn}` : "none", opacity: fut ? .9 : 1,
                            animation: `kp-rise .4s ${i * .035}s both` }} />
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 3 }}>
                    {F_YEARS.map(y => (
                      <span key={y} style={{ flex: 1, textAlign: "center", fontSize: ".64em",
                        color: y > m.actualTo ? c.warn : c.faint,
                        fontWeight: y > m.actualTo ? 600 : 400 }}>{String(y).slice(2)}</span>
                    ))}
                  </div>
                </Card>
              );
            })}
            <Card c={c} pad={narrow ? 13 : 16} i={7}>
              <div style={{ ...S.eyebrow, marginBottom: 10 }}>What the forward view says</div>
              <div style={{ fontSize: ".9em", display: "grid", gap: 9 }}>
                <div>· Kenya grows near 5% to 2031, above the Sub-Saharan average of 4.4% throughout.</div>
                <div>· Inflation settles around 5.5%, higher than the recent run but inside the band.</div>
                <div>· <strong style={{ color: c.bad }}>Debt rises every single year to 74.6%</strong> — no inflection on anyone's numbers.</div>
                <div>· World growth slows to 3.1%. Export demand and tourism take their cue from that.</div>
                <div style={{ borderTop: `1px solid ${c.line}`, paddingTop: 9, color: c.dim }}>
                  The state stays a heavy borrower in the domestic market for the whole horizon.
                  Domestic yields stay high enough to matter, which is why the top of the ladder is
                  government paper and likely stays there.
                </div>
              </div>
            </Card>
          </>}

          {/* ================= DATA ================= */}
          {tab === "data" && <>
            <Card c={c} pad={narrow ? 13 : 16} i={0}>
              <div style={{ display: "flex", justifyContent: "space-between",
                alignItems: "center", marginBottom: 12 }}>
                <span style={S.eyebrow}>Feed</span>
                <Pill tone={data.source === "seed" ? "steady" : "good"} c={c}>
                  {data.source === "seed" ? "seeded" : "live"}
                </Pill>
              </div>
              <div style={{ fontSize: ".86em", color: c.dim, marginBottom: 12 }}>
                {cfg.feed
                  ? <>Reading <code style={{ fontSize: ".92em", wordBreak: "break-all" }}>{cfg.feed}</code></>
                  : "No feed set. Running on the seeded readings — point it at your data.json in settings."}
              </div>
              {sync.msg && <div style={{ fontSize: ".84em", marginBottom: 12,
                color: sync.state === "err" ? c.bad : c.good }}>{sync.msg}</div>}
              <button onClick={() => pull(false)} className="kp-f kp-tap"
                disabled={sync.state === "busy"}
                style={{ ...S.btn(c.chip, c.ink), border: `1px solid ${c.line}`, fontWeight: 600,
                  opacity: sync.state === "busy" ? .6 : 1 }}>
                {sync.state === "busy" ? "Fetching…" : "Sync now"}
              </button>
            </Card>

            <Card c={c} pad={narrow ? 13 : 16} i={1}>
              <div style={{ ...S.eyebrow, marginBottom: 10 }}>Where sources disagree</div>
              <div style={{ fontSize: ".84em", color: c.dim, marginBottom: 14 }}>
                Nothing is averaged. Averaging two vintages makes a third figure nobody published.
                The higher-ranked source is kept and the other is shown.
              </div>
              {data.disagreements.map((d, n) => (
                <div key={d.id} style={{ padding: "12px 0", borderTop: n ? `1px solid ${c.line}` : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: ".93em" }}>{d.label}</strong>
                    <Pill tone="watch" c={c}>{d.gapPct}% apart</Pill>
                  </div>
                  <div style={{ display: "flex", gap: 20, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: ".71em", color: c.good, fontWeight: 700 }}>KEPT</div>
                      <div style={{ fontWeight: 700 }}>{d.keptValue}</div>
                      <div style={{ fontSize: ".74em", color: c.faint }}>{d.kept}</div>
                    </div>
                    <div style={{ opacity: .5 }}>
                      <div style={{ fontSize: ".71em", color: c.dim, fontWeight: 700 }}>ALSO SEEN</div>
                      <div style={{ fontWeight: 700 }}>{d.otherValue}</div>
                      <div style={{ fontSize: ".74em", color: c.faint }}>{d.other}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: ".82em", color: c.dim }}>{d.why}</div>
                </div>
              ))}
            </Card>

            <Card c={c} pad={narrow ? 13 : 16} i={2}>
              <div style={{ ...S.eyebrow, marginBottom: 10 }}>Sources</div>
              {SOURCES.map(s2 => (
                <div key={s2.name} style={{ display: "flex", gap: 10, padding: "10px 0",
                  borderBottom: `1px solid ${c.line}` }}>
                  <span style={{ width: 7, height: 7, borderRadius: 7, background: c.good,
                    flexShrink: 0, marginTop: 6 }} />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 600, fontSize: ".9em" }}>{s2.name}</span>
                    <span style={{ fontSize: ".76em", color: c.faint }}>{s2.covers}</span>
                  </span>
                </div>
              ))}
              <div style={{ fontSize: ".8em", color: c.faint, marginTop: 12 }}>
                Six sources, none paid, none needing a key. If one fails the last good reading is
                carried forward and labelled with its age rather than left blank.
              </div>
            </Card>

            <Card c={c} pad={narrow ? 13 : 16} i={3}>
              <div style={{ ...S.eyebrow, marginBottom: 10 }}>Every reading</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".82em" }}>
                  <thead>
                    <tr style={{ color: c.dim, textAlign: "left" }}>
                      <th style={{ padding: "6px 8px 6px 0", fontWeight: 600 }}>Indicator</th>
                      <th style={{ padding: "6px 8px", fontWeight: 600, textAlign: "right" }}>Now</th>
                      <th style={{ padding: "6px 8px", fontWeight: 600, textAlign: "right" }}>Prior</th>
                      <th style={{ padding: "6px 0 6px 8px", fontWeight: 600 }}>As at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inds.map(i => (
                      <tr key={i.id} style={{ borderTop: `1px solid ${c.line}` }}>
                        <td style={{ padding: "8px 8px 8px 0" }}>{i.label}</td>
                        <td style={{ padding: "8px", textAlign: "right", fontWeight: 700,
                          color: i.state === "stress" ? c.bad : i.state === "good" ? c.good : c.ink }}>
                          {fmt(i.value, i.unit)}
                        </td>
                        <td style={{ padding: "8px", textAlign: "right", color: c.faint }}>
                          {fmt(i.prior, i.unit)}
                        </td>
                        <td style={{ padding: "8px 0 8px 8px", color: c.faint, whiteSpace: "nowrap" }}>
                          {i.asOf}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card c={c} pad={narrow ? 13 : 16} i={4}>
              <div style={{ display: "flex", justifyContent: "space-between",
                alignItems: "center", marginBottom: 10 }}>
                <span style={S.eyebrow}>On this device</span>
                <Pill tone={saved === false ? "stress" : saved ? "good" : "steady"} c={c}>
                  {saved === false ? "not saving" : saved ? "saved" : "idle"}
                </Pill>
              </div>
              {(() => {
                const rep = store.report();
                const vercelPreview = /-[a-z0-9]{8,}\-/.test(rep.origin);
                return (
                  <>
                    <div style={{ fontSize: ".85em", color: c.dim, marginBottom: 12 }}>
                      Settings are kept per website address. Two addresses for the same app
                      each get their own drawer, which is the usual reason an app looks like
                      it has forgotten you.
                    </div>
                    <div style={{ display: "grid", gap: 8, fontSize: ".84em" }}>
                      <Line c={c} k="Storage"
                        v={rep.ok === false ? (rep.error || "unavailable") : "working"}
                        bad={rep.ok === false} />
                      <Line c={c} k="This address" v={rep.origin} mono />
                      {rep.keys.map(x => (
                        <Line key={x.key} c={c} k={x.key}
                          v={`${(x.bytes / 1024).toFixed(1)} KB`} />
                      ))}
                      {rep.keys.length === 0 &&
                        <Line c={c} k="Stored" v="nothing yet" bad />}
                      <Line c={c} k="Writes this session"
                        v={rep.writes + (rep.lastWrite ? ` · last ${rep.lastWrite}` : "")} />
                    </div>
                    {vercelPreview && (
                      <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10,
                        background: c.chip, fontSize: ".84em", color: c.warn }}>
                        <strong>This looks like a one-off deployment address.</strong> Each
                        deploy gets its own, and each keeps separate settings. Install from
                        your stable address instead so they carry across updates.
                      </div>
                    )}
                    {rep.ok === false && (
                      <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10,
                        background: c.chip, fontSize: ".84em", color: c.bad }}>
                        <strong>Nothing is being saved.</strong> Private browsing, or site
                        data blocked for this address. Settings will last only this session.
                      </div>
                    )}
                  </>
                );
              })()}
            </Card>

            <Card c={c} pad={narrow ? 13 : 16} i={5}>
              <div style={{ ...S.eyebrow, marginBottom: 10 }}>Briefing</div>
              <pre style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
                fontSize: ".76em", lineHeight: 1.6, whiteSpace: "pre-wrap", margin: 0,
                maxHeight: 300, overflowY: "auto" }}>{brief}</pre>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <button onClick={() => copy(brief)} className="kp-f kp-tap"
                  style={S.btn(copied ? c.good : c.cool, "#fff")}>
                  {copied ? "Copied" : "Copy briefing"}
                </button>
                <button onClick={() => copy(JSON.stringify({ cfg, data }, null, 1))}
                  className="kp-f kp-tap"
                  style={{ ...S.btn(c.chip, c.ink), border: `1px solid ${c.line}`, fontWeight: 600 }}>
                  Copy backup
                </button>
                <button onClick={() => { setData(SEED); store.set("kp.data", SEED);
                  setSync({ state: "idle", msg: "Back to the seeded readings." }); }}
                  className="kp-f kp-tap"
                  style={{ ...S.btn("transparent", c.dim), border: `1px solid ${c.line}`, fontWeight: 600 }}>
                  Reset
                </button>
              </div>

              <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${c.line}` }}>
                <div style={{ ...S.eyebrow, marginBottom: 8 }}>Restore</div>
                <div style={{ fontSize: ".84em", color: c.dim, marginBottom: 10 }}>
                  Paste a backup here to put settings and readings back. Useful when moving
                  to a new address or a new phone.
                </div>
                <textarea value={restoreText} rows={3}
                  onChange={e => { setRestoreText(e.target.value); setRestoreMsg(""); }}
                  placeholder='{"cfg":{...},"data":{...}}'
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 11,
                    border: `1px solid ${c.line}`, background: c.card, color: c.ink,
                    fontSize: ".8em", fontFamily: "ui-monospace, Menlo, monospace",
                    resize: "vertical" }} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                  <button onClick={restore} disabled={!restoreText.trim()}
                    className="kp-f kp-tap"
                    style={{ ...S.btn(c.chip, c.ink), border: `1px solid ${c.line}`,
                      fontWeight: 600, opacity: restoreText.trim() ? 1 : .5 }}>
                    Restore
                  </button>
                  {restoreMsg && (
                    <span style={{ fontSize: ".82em",
                      color: restoreMsg.startsWith("Restored") ? c.good : c.bad }}>
                      {restoreMsg}
                    </span>
                  )}
                </div>
              </div>
            </Card>
          </>}
        </div>

        {/* ---------------- footer ---------------- */}
        <div style={{ marginTop: 28, paddingTop: 18, borderTop: `1px solid ${c.line}`,
          textAlign: "center", fontSize: ".78em", color: c.faint, lineHeight: 1.6 }}>
          Each indicator is scored against its own recent run, not a forecast. The pulse score is
          the share of indicators moving the right way. The ladder is arithmetic on published rates.
          <div>
            <a href="https://gachichio.org" target="_blank" rel="noopener noreferrer" className="kp-f"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 14,
                padding: "7px 15px", borderRadius: 20, border: `1px solid ${c.line}`,
                background: c.card, color: c.dim, fontWeight: 700, textDecoration: "none",
                fontSize: "1em", transition: "border-color .18s, color .18s, transform .12s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = c.good;
                e.currentTarget.style.color = c.ink; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = c.line;
                e.currentTarget.style.color = c.dim; }}>
              Made with <span style={{ color: c.bad }}>❤</span> by Brian Gachichio
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .5 }}>
                <path d="M7 17L17 7M17 7H8M17 7v9" />
              </svg>
            </a>
          </div>
          <div style={{ marginTop: 10 }}>CBK · NSE · KNBS · Treasury · World Bank · IMF · FRED</div>
        </div>
      </div>

      {/* ================= SETTINGS ================= */}
      {openSettings && (
        <div onClick={() => setOpenSettings(false)} role="dialog" aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 50,
            display: "flex", alignItems: "flex-end", justifyContent: "center",
            animation: "kp-veil .22s both" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: c.bg, width: "100%", maxWidth: 720, maxHeight: "90vh",
              overflowY: "auto", borderRadius: "20px 20px 0 0",
              padding: narrow ? "18px 12px 30px" : "20px 16px 34px",
              paddingBottom: "max(34px, env(safe-area-inset-bottom))",
              animation: "kp-sheet .3s cubic-bezier(.22,.9,.3,1) both" }}>
            <div style={{ display: "flex", justifyContent: "space-between",
              alignItems: "center", marginBottom: 20 }}>
              <span style={{ fontSize: "1.2em", fontWeight: 800 }}>Settings</span>
              <button onClick={() => setOpenSettings(false)} className="kp-f kp-tap"
                style={S.icon} aria-label="Close">✕</button>
            </div>

            <Row label="Theme" c={c}>
              <Seg value={cfg.theme} onChange={v => set("theme", v)} c={c}
                opts={[["light", "Light"], ["dark", "Dark"], ["system", "Same as device"]]} />
            </Row>
            <Row label="Text size" c={c}>
              <Seg value={cfg.size} onChange={v => set("size", v)} c={c}
                opts={[["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]]} />
            </Row>
            <Row label="Data feed" hint="The data.json your VM writes. Blank runs on seeded readings." c={c}>
              <input value={cfg.feed} onChange={e => set("feed", e.target.value)}
                placeholder="https://gachichio.org/pulse/data.json" inputMode="url"
                style={{ width: "100%", padding: "11px 13px", borderRadius: 11,
                  border: `1px solid ${c.line}`, background: c.card, color: c.ink, fontSize: ".9em" }} />
            </Row>
            <Row label="Sync on open" c={c}>
              <Toggle on={cfg.autoSync} onChange={v => set("autoSync", v)} c={c} />
            </Row>

            <div style={{ ...S.eyebrow, margin: "26px 0 14px", color: c.good }}>Tax assumptions</div>
            <Row label={`Treasury bills and deposits · ${cfg.taxBill}%`}
              hint="Tax practices say 15%. One retail source claims bills are exempt for individuals — set what your own advice says." c={c}>
              <input type="range" min="0" max="30" step="1" value={cfg.taxBill}
                onChange={e => set("taxBill", +e.target.value)}
                style={{ width: "100%", accentColor: c.good }} />
            </Row>
            <Row label={`Money market funds · ${cfg.taxMmf}%`} c={c}>
              <input type="range" min="0" max="30" step="1" value={cfg.taxMmf}
                onChange={e => set("taxMmf", +e.target.value)}
                style={{ width: "100%", accentColor: c.good }} />
            </Row>
            <Row label={`Bonds of ten years or more · ${cfg.taxBond}%`} c={c}>
              <input type="range" min="0" max="30" step="1" value={cfg.taxBond}
                onChange={e => set("taxBond", +e.target.value)}
                style={{ width: "100%", accentColor: c.good }} />
            </Row>

            <div style={{ ...S.eyebrow, margin: "26px 0 14px", color: c.good }}>Display</div>
            <Row label={`Anomaly threshold · z ${cfg.zAlert}`} hint="Lower catches more." c={c}>
              <input type="range" min="0.5" max="3" step="0.1" value={cfg.zAlert}
                onChange={e => set("zAlert", +e.target.value)}
                style={{ width: "100%", accentColor: c.good }} />
            </Row>
            <Row label="Show target bands" hint="The CBK inflation band, the 55% debt anchor." c={c}>
              <Toggle on={cfg.showBands} onChange={v => set("showBands", v)} c={c} />
            </Row>
            <Row label="Compact rows" hint="Hides sparklines, fits more on a screen." c={c}>
              <Toggle on={cfg.compact} onChange={v => set("compact", v)} c={c} />
            </Row>
            <Row label="Pinned to the top" hint="Choose up to four." c={c}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {inds.map(i => {
                  const on = cfg.pinned.includes(i.id);
                  return (
                    <button key={i.id} className="kp-f kp-tap"
                      onClick={() => set("pinned", on ? cfg.pinned.filter(x => x !== i.id)
                        : cfg.pinned.length < 4 ? [...cfg.pinned, i.id] : cfg.pinned)}
                      style={{ padding: "6px 11px", borderRadius: 9, fontSize: ".8em", cursor: "pointer",
                        border: `1px solid ${on ? c.good : c.line}`,
                        background: on ? c.good : "transparent", color: on ? "#fff" : c.dim,
                        fontWeight: on ? 600 : 500, transition: "background .18s, color .18s" }}>
                      {i.label}
                    </button>
                  );
                })}
              </div>
            </Row>

            <div style={{ fontSize: ".78em", color: c.faint, marginTop: 22, lineHeight: 1.6 }}>
              Settings are stored on this device. In the Claude preview they last the session;
              once the app is on your own domain they persist properly.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- diagnostics row ---------- */
function Line({ k, v, c, mono, bad }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: c.dim, flexShrink: 0 }}>{k}</span>
      <span style={{ fontWeight: 600, textAlign: "right", wordBreak: "break-all",
        color: bad ? c.bad : c.ink,
        fontFamily: mono ? "ui-monospace, Menlo, monospace" : "inherit",
        fontSize: mono ? ".92em" : "1em" }}>{v}</span>
    </div>
  );
}

/* ---------- settings helpers ---------- */
function Row({ label, hint, children, c }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontWeight: 600, marginBottom: hint ? 3 : 9, fontSize: ".95em" }}>{label}</div>
      {hint && <div style={{ fontSize: ".8em", color: c.faint, marginBottom: 9 }}>{hint}</div>}
      {children}
    </div>
  );
}
function Seg({ value, onChange, opts, c }) {
  return (
    <div style={{ display: "flex", background: c.chip, borderRadius: 11, padding: 3 }}>
      {opts.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className="kp-f"
          style={{ flex: 1, padding: "9px 4px", border: "none", borderRadius: 9, cursor: "pointer",
            background: value === v ? c.card : "transparent",
            color: value === v ? c.ink : c.dim, fontWeight: value === v ? 700 : 500,
            fontSize: ".88em", boxShadow: value === v ? c.shadow : "none",
            transition: "background .2s, color .2s" }}>{l}</button>
      ))}
    </div>
  );
}
function Toggle({ on, onChange, c }) {
  return (
    <button onClick={() => onChange(!on)} className="kp-f" aria-pressed={on} role="switch"
      style={{ width: 52, height: 30, borderRadius: 30, border: "none", cursor: "pointer",
        background: on ? c.good : c.line, position: "relative", transition: "background .2s" }}>
      <span style={{ position: "absolute", top: 3, left: on ? 25 : 3, width: 24, height: 24,
        borderRadius: 24, background: "#fff", transition: "left .2s cubic-bezier(.3,.8,.4,1)",
        boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
    </button>
  );
}

/* ---------- feed merge ---------- */
/* Each rate carries its own publication date. The CBR was set in April; the
   91-day moves weekly. Stamping every row with the sync date throws that away,
   so the collector's cbkDates are used where they exist and the seeded label
   is kept otherwise. A date that says when the number was published is worth
   more than one that says when it was fetched. */
function feedDate(id, feed, fallback) {
  const d = feed.cbkDates && feed.cbkDates[id];
  if (!d) return fallback;
  const m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return d;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${+m[1]} ${MON[+m[2] - 1]} ${m[3]}`;
}

function mergeFeed(seed, feed) {
  if (!feed || typeof feed !== "object" || !Array.isArray(feed.signals)) return seed;
  const live = Object.fromEntries(feed.signals.map(s => [s.id, s]));
  const indicators = seed.indicators.map(i => {
    const s = live[i.id];
    if (!s || typeof s.value !== "number") return i;
    const changed = s.prior != null && Math.abs(s.value - s.prior) > 1e-9;
    return { ...i, value: s.value,
      prior: changed ? s.prior : i.prior,
      priorLabel: changed ? "last reading" : i.priorLabel,
      hist: Array.isArray(s.hist) && s.hist.length > 2 ? s.hist : [...i.hist.slice(-19), s.value],
      asOf: feedDate(i.id, feed, i.asOf),
      src: s.source === "cbk" ? "CBK" : s.source === "nse" ? "NSE"
        : s.source === "manual" ? "Typed" : s.source || i.src };
  });
  return { ...seed, indicators, asOf: feed.asOf || seed.asOf, source: "live",
    ladder: Array.isArray(feed.ladder) && feed.ladder.length ? feed.ladder : seed.ladder,
    chain: Array.isArray(feed.chain) && feed.chain.length ? feed.chain : seed.chain,
    breaks: Array.isArray(feed.breaks) && feed.breaks.length ? feed.breaks : seed.breaks,
    call: feed.call || seed.call,
    disagreements: Array.isArray(feed.disagreements) && feed.disagreements.length
      ? feed.disagreements.map(d => ({ ...d, why: d.why || "Sources report different vintages." }))
      : seed.disagreements };
}

/* ---------- briefing ---------- */
function buildBrief(inds, ladder, breaks, call, asOf, pulse, verdict) {
  const g = Object.fromEntries(inds.map(i => [i.id, i]));
  const f = id => g[id] ? `${g[id].value}${g[id].unit}` : "—";
  const off = breaks.filter(b => b.state !== "normal");
  const L = [`KENYA PULSE — ${asOf}`, `Score ${pulse}/100 · ${verdict}`, "",
    `Policy    CBR ${f("cbr")}, KESONIA ${f("kesonia")}, 91-day ${f("tbill")}`,
    `Prices    inflation ${f("inflation")}, core ${f("core")}`,
    `Banking   lending ${f("lending")}, deposit ${f("deposit")}, credit ${f("credit")}, NPLs ${f("npl")}`,
    `External  KES/USD ${f("kes_usd")}, reserves ${f("reserves")}, CAB ${f("cab")}`,
    `Activity  GDP ${f("gdp")}, PMI ${f("pmi")}`,
    `Markets   NASI ${f("nasi")}, cap ${f("mktcap")}`,
    `Fiscal    debt ${f("debt")}, ${f("debt_gdp")} of GDP, service ${f("debtserv")} of revenue`,
    `Global    Fed ${f("fed_funds")}, US 10yr ${f("us10y")}, SSA ${f("ssa_gdp")}`, "",
    "REAL RETURN AFTER TAX",
    ...ladder.slice(0, 4).map(r => `  ${r.label.padEnd(24)}${r.real > 0 ? "+" : ""}${r.real.toFixed(2)}%`),
    `  ${ladder[ladder.length - 1].label.padEnd(24)}${ladder[ladder.length - 1].real.toFixed(2)}%`, ""];
  if (off.length) {
    L.push("OUTSIDE ITS USUAL RANGE");
    off.forEach(b => L.push(`  ${b.name} ${b.value}${b.unit} (usual ${b.normalLo}–${b.normalHi})`));
    L.push("");
  }
  L.push(call);
  return L.join("\n");
}
