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
   "forget" - two URLs for the same app, each with its own drawer.
--------------------------------------------------------------------------- */
/* The feed is fixed. It is one file on one server and it is not going to move,
   so making it a setting only invited people to break it. */
const FEED = "https://gachichio.org/pulse/data.json";

/* Deep links. #edge, #trends/inflation, #pulse/cbr — so a finding can be shared,
   not just the app. The hash is rewritten as you move, and read on arrival. */
const TAB_IDS = ["pulse", "edge", "trends", "outlook", "data"];

function readHash() {
  try {
    const raw = (window.location.hash || "").replace(/^#\/?/, "");
    if (!raw) return {};
    const [tab, id] = raw.split("/");
    return { tab: TAB_IDS.includes(tab) ? tab : null, id: id ? decodeURIComponent(id) : null };
  } catch { return {}; }
}

function writeHash(tab, id) {
  try {
    const h = "#" + tab + (id ? "/" + encodeURIComponent(id) : "");
    if (window.location.hash !== h) window.history.replaceState(null, "", h);
  } catch { /* not fatal */ }
}

function linkTo(tab, id) {
  try {
    const { origin, pathname } = window.location;
    return `${origin}${pathname}#${tab}${id ? "/" + encodeURIComponent(id) : ""}`;
  } catch { return ""; }
}

/* ---------------------------------------------------------------------------
   Push.
   The daily briefing is sent by the collector's VM, so it arrives whether the
   app is open, backgrounded or closed. All this side does is hand over an
   address to reach, a time, and the days that time applies to.

   What leaves the device: the push endpoint the browser mints, the two keys
   that encrypt to it, the chosen time and days, and the timezone name so the
   server can work out when local morning is. No account, no identity.
--------------------------------------------------------------------------- */
const PUSH_API = "https://gachichio.org/pulse/push";

/* VAPID keys arrive base64url; the subscribe call wants bytes. */
function keyBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}

/* Three answers, because they need three different sentences on screen.
   iOS carries the whole push stack, but only once the app is on the home
   screen - in a Safari tab PushManager simply is not there. */
function pushCapability() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) return "unsupported";
  if (!("PushManager" in window)) {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent || "");
    const installed = window.navigator.standalone === true
      || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    return ios && !installed ? "install-first" : "unsupported";
  }
  return "ok";
}

const tzName = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Nairobi"; }
  catch { return "Africa/Nairobi"; }
};

async function pushSubscribe({ time, days }) {
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const kr = await fetch(`${PUSH_API}/key`, { cache: "no-store" });
      if (!kr.ok) throw new Error(`key ${kr.status}`);
      const { key } = await kr.json();
      if (!key) throw new Error("no key");
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: keyBytes(key),
      });
    }
    const r = await fetch(`${PUSH_API}/subscribe`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), time, days, tz: tzName() }),
    });
    if (!r.ok) throw new Error(`subscribe ${r.status}`);
    return { ok: true, msg: "" };
  } catch (e) {
    return { ok: false, msg: `Could not schedule it - ${e.message}. Try again once you are online.` };
  }
}

/* When the next one will actually arrive. Without this the app is silent
   about a schedule it has already accepted, and a briefing set for a time
   that has just passed looks like a broken feature rather than one waiting
   for tomorrow. */
function nextBriefing(time, days, from) {
  if (!days || !days.length) return null;
  const [h, m] = String(time || "08:00").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (days.includes(d.getDay()) && d > from) return d;
  }
  return null;
}

function whenPhrase(next, from) {
  if (!next) return "No days selected - nothing will be sent.";
  const clock = next.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(next).setHours(0, 0, 0, 0)
    - new Date(from).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return `Next briefing today at ${clock}.`;
  if (days === 1) return `Next briefing tomorrow at ${clock}.`;
  return `Next briefing ${next.toLocaleDateString("en-GB", { weekday: "long" })} at ${clock}.`;
}

async function pushUnsubscribe() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    /* Tell the server first: a subscription it still holds would keep firing
       at a device that has stopped listening. */
    await fetch(`${PUSH_API}/unsubscribe`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => { /* dropped below regardless */ });
    await sub.unsubscribe();
  } catch { /* nothing left to do on this device */ }
}

const SCHEMA = 1;
const mem = {};
const diag = { ok: null, error: null };

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
        return { ...fb, ...migrate(parsed) };
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
      return true;
    } catch (e) {
      diag.ok = false;
      diag.error = (e && e.name) === "QuotaExceededError"
        ? "storage is full" : "blocked by the browser";
      return false;
    }
  },
  /* Only whether saving works. The panel that listed sizes and origins was
     removed; keeping the code that fed it was keeping a shape, not a use. */
  report() { return { ok: diag.ok, error: diag.error }; },
};

/* design.md 12 names ui.theme and ui.fontScale, and the script in index.html
   reads them before the first stylesheet. They are therefore the truth for
   those two settings - if React seeded them from its own store instead, the
   two could drift and the pre-paint theme would be wrong. */
function uiPref(key, allowed, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch { return fallback; }
}

/* Older layouts are upgraded rather than discarded. Nothing here yet, but the
   hook exists so the first schema change does not cost anyone their settings. */
function migrate(old) { return old; }

/* Colour, shape and type all resolve to tokens declared in index.css. No hex
   value lives in this file: light and dark are two sets of the same names, and
   the class on <html> chooses which set is live. design.md 4.4.

   Documented exception, design.md 18. The rule reserves green for action and
   caps it at three appearances per screen. Here colour IS the data - a rung
   that beats inflation is green, one that loses to it is red, across thirty
   indicators at once. Reading the ladder in one glance is the product. The
   rule assumes an app where green means "act here"; this is a dashboard where
   green means "this one is winning". Kept deliberately, named here. */
const C = {
  bg: "var(--md-surface)",
  card: "var(--md-surface-container-low)",
  line: "var(--md-outline-variant)",
  ink: "var(--md-on-surface)",
  dim: "var(--md-on-surface-variant)",
  faint: "var(--md-outline)",
  good: "var(--md-primary)",
  warn: "var(--md-tertiary)",
  bad: "var(--md-error)",
  cool: "var(--md-primary)",
  chip: "var(--md-surface-container)",
  shadow: "var(--md-elevation-1)",
  seg: "var(--md-surface-container)",
  segOn: "var(--md-surface-container-lowest)",
  segShadow: "var(--md-elevation-1)",
};

/* design.md 6.1. Narrative is mono at tracking 0em; everything the user
   clicks or reads at length is Inter. Every size is rem, so the font-size
   toggle moves the whole system from one variable. */
const MONO = "var(--font-narrative)";
const T = {
  displaySm:  { fontSize: "2.25rem",   lineHeight: "2.75rem", fontWeight: 400, fontFamily: MONO, letterSpacing: "0em" },
  headlineLg: { fontSize: "2rem",      lineHeight: "2.5rem",  fontWeight: 400, fontFamily: MONO, letterSpacing: "0em" },
  headlineSm: { fontSize: "1.5rem",    lineHeight: "2rem",    fontWeight: 400, fontFamily: MONO, letterSpacing: "0em" },
  titleLg:    { fontSize: "1.375rem",  lineHeight: "1.75rem", fontWeight: 600, letterSpacing: "-0.011em" },
  titleMd:    { fontSize: "1rem",      lineHeight: "1.5rem",  fontWeight: 500, letterSpacing: "-0.006em" },
  titleSm:    { fontSize: "0.875rem",  lineHeight: "1.25rem", fontWeight: 500, letterSpacing: "0" },
  bodyLg:     { fontSize: "1rem",      lineHeight: "1.5rem",  fontWeight: 400, letterSpacing: "0" },
  bodyMd:     { fontSize: "0.875rem",  lineHeight: "1.375rem", fontWeight: 400, letterSpacing: "0" },
  bodySm:     { fontSize: "0.75rem",   lineHeight: "1.125rem", fontWeight: 400, letterSpacing: "0.004em" },
  labelLg:    { fontSize: "0.875rem",  lineHeight: "1.25rem", fontWeight: 500, letterSpacing: "0.006em" },
  labelMd:    { fontSize: "0.75rem",   lineHeight: "1rem",    fontWeight: 500, letterSpacing: "0.012em" },
  labelSm:    { fontSize: "0.6875rem", lineHeight: "1rem",    fontWeight: 500, letterSpacing: "0.016em" },
};

/* design.md 12.2 */
const SCALES = [["compact", "S"], ["default", "M"], ["large", "L"], ["xlarge", "XL"]];


/* ===========================================================================
   SEED - every figure a real published reading, verified 17 August 2026
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
  asOf: "2026-08-17", source: "seed",
  indicators: [
    { id: "cbr", label: "Central Bank Rate", group: "Policy", unit: "%", dir: 0,
      value: 8.75, prior: 9.0, priorLabel: "December", asOf: "8 Apr 2026", src: "CBK",
      hist: [10.75,10.25,10,9.75,9.5,9.25,9,8.75,8.75,8.75,8.75],
      what: "The rate the Central Bank charges banks to borrow overnight.",
      why: "It is the anchor every other rate in the country is priced off. When it falls, loans eventually get cheaper and savings eventually pay less \u2014 eventually being the operative word.",
      note: "Fourth straight hold, the longest pause since 2020. Next meeting October." },
    { id: "kesonia", label: "KESONIA overnight", group: "Policy", unit: "%", dir: 0,
      value: 8.7494, prior: 8.71, priorLabel: "a week ago", asOf: "14 Aug 2026", src: "CBK",
      hist: [8.68,8.71,8.74,8.72,8.75,8.71,8.7494],
      what: "What banks actually charge each other for overnight money, averaged across the market.",
      why: "It shows whether the policy rate is real. Sitting on the policy rate means the money market is calm; drifting above it means cash is tight somewhere.",
      note: "Sitting almost exactly on the policy rate. The overnight market is in balance - no liquidity stress, no flood." },
    { id: "tbill", label: "91-day Treasury bill", group: "Policy", unit: "%", dir: 0,
      value: 8.773, prior: 7.64, priorLabel: "February", asOf: "17 Aug 2026", src: "CBK",
      hist: [9.1,8.9,8.6,8.3,8.1,7.9,7.64,8.12,8.45,8.61,8.773],
      what: "The return on lending money to the government for three months.",
      why: "The closest thing to a risk-free rate in Kenya, and the yardstick every other investment should beat. It also shows what the market thinks of the government's borrowing.",
      note: "Up 113bp since February while the policy rate held. The market is repricing the front end on its own." },
    { id: "tbill182", label: "182-day Treasury bill", group: "Policy", unit: "%", dir: 0,
      value: 8.97, prior: 9.34, priorLabel: "previous auction", asOf: "Jul 2026", src: "Serrari",
      what: "The return on lending to the government for six months.",
      why: "The middle of the short curve. Sitting above the 91-day means the market wants paying to lend for longer.",
      hist: [9.4,9.3,9.2,9.1,9.0,8.97],
      note: "From the most recent auction." },

    { id: "tbill364", label: "364-day Treasury bill", group: "Policy", unit: "%", dir: 0,
      value: 9.04, prior: 10.12, priorLabel: "previous auction", asOf: "Jul 2026", src: "Serrari",
      what: "The return on lending to the government for a year.",
      why: "The longest bill. The gap between this and the 91-day shows what the market thinks rates will do over the next year.",
      hist: [10.1,9.9,9.7,9.4,9.2,9.04],
      note: "Only 7bp above the 182-day - the short curve is almost flat." },

    { id: "discount", label: "Discount window", group: "Policy", unit: "%", dir: 0,
      value: 9.25, prior: 9.25, priorLabel: "unchanged", asOf: "8 Apr 2026", src: "CBK",
      what: "What the Central Bank charges a bank that needs emergency cash.",
      why: "The ceiling of the corridor. A bank paying this rate has run out of cheaper options.",
      hist: [9.25,9.25,9.25,9.25], note: "Held with the policy rate." },

    { id: "repo", label: "REPO rate", group: "Policy", unit: "%", dir: 0,
      value: 9.25, prior: 9.25, priorLabel: "unchanged", asOf: "15 Oct 2025", src: "CBK",
      hist: [9.25,9.25,9.25,9.25], what: "The rate at which the Central Bank lends to banks against collateral.",
      why: "It caps how expensive overnight money can get. Think of it as the ceiling of a corridor with the policy rate in the middle.",
      note: "The ceiling of the corridor." },
    { id: "bond10", label: "10-year bond", group: "Policy", unit: "%", dir: 0,
      value: 13.45, prior: 13.6, priorLabel: "last month", asOf: "Aug 2026", src: "Typed",
      hist: [14.2,14,13.85,13.7,13.6,13.45],
      what: "The return on lending to the government for ten years.",
      why: "Long money prices long risk. Compared against the US ten-year it shows what the world charges Kenya for the privilege of borrowing.",
      note: "Against a US 10-year at 4.63%, a spread of 882bp." },

    { id: "inflation", label: "Headline inflation", group: "Prices", unit: "%", dir: -1,
      value: 6.49, prior: 6.4, priorLabel: "June", asOf: "Jul 2026", src: "CBK",
      band: [2.5, 7.5], bandLabel: "CBK target band 2.5–7.5%",
      what: "How much more the same shopping basket costs than a year ago.",
      why: "It is the rate at which money loses its purchasing power. Every return you earn has to beat this before you have gained anything at all.",
      hist: [3.8,4.1,4.5,4.6,4.6,4.5,4.5,4.4,4.3,4.4,5.6,6.7,6.4,6.49],
      note: "Transport and food carry it. Non-core runs well above core - a supply shock, not demand." },

    { id: "lending", label: "Average lending rate", group: "Banking", unit: "%", dir: -1,
      value: 14.38, prior: 14.5, priorLabel: "May", asOf: "Jun 2026", src: "CBK",
      hist: [17.2,16.8,16.1,15.6,15.2,14.9,14.7,14.5,14.38],
      what: "The average rate banks charge borrowers.",
      why: "What credit actually costs. The distance between this and the policy rate is the bank's margin, and it tells you how much of any rate cut has reached real borrowers.",
      note: "Down 282bp from the November 2024 peak, but still 563bp over policy." },
    { id: "deposit", label: "Average deposit rate", group: "Banking", unit: "%", dir: 1,
      value: 6.84, prior: 7.1, priorLabel: "May", asOf: "Jun 2026", src: "CBK",
      hist: [9.2,8.9,8.4,8,7.6,7.3,7.1,6.84],
      what: "The average rate banks pay on fixed deposits.",
      why: "What your money earns for sitting in a bank. Compare it to inflation: below, and the bank is charging you for the privilege.",
      note: "Falling faster than lending rates. Banks are protecting margin from the deposit side." },
    { id: "savings", label: "Average savings rate", group: "Banking", unit: "%", dir: 1,
      value: 3.32, prior: 3.4, priorLabel: "May", asOf: "Jun 2026", src: "CBK",
      what: "The average rate banks pay on ordinary savings accounts.",
      why: "Almost always far below inflation, which makes an ordinary savings account the most expensive safe place to keep money.",
      hist: [4.2,4,3.8,3.6,3.5,3.4,3.32],
      note: "Against 6.49% inflation, a savings account loses about 3.7% of its purchasing power a year." },

    { id: "npl", label: "Non-performing loans", group: "Banking", unit: "%", dir: -1,
      value: 14.6, prior: 15.3, priorLabel: "May", asOf: "Jul 2026", src: "Typed",
      hist: [17.6,17.1,16.5,16,15.4,15.3,14.6],
      what: "The share of loans where borrowers have stopped paying.",
      why: "The health of the banking system in one number. Rising means either banks lent badly or borrowers are struggling, and both eventually tighten credit for everyone.",
      note: "Falling across every major sector. Still roughly three times a healthy book." },

    { id: "kes_usd", label: "KES per USD", group: "External", unit: "", dir: -1,
      value: 129.34, prior: 129.24, priorLabel: "yesterday", asOf: "17 Aug 2026", src: "CBK",
      hist: [129.2,129.3,129.1,129.2,129.2,129.1,129.24,129.34],
      what: "How many shillings it takes to buy one dollar.",
      why: "Kenya imports fuel, machinery and medicine in dollars. A weaker shilling makes all of it dearer, and that shows up in inflation two or three months later.",
      note: "Pinned near 129 for over a year. That stability is doing quiet work on inflation expectations." },
    { id: "kes_eur", label: "KES per EUR", group: "External", unit: "", dir: -1,
      value: 149.6, prior: 149.2, priorLabel: "yesterday", asOf: "17 Aug 2026", src: "CBK",
      what: "How many shillings it takes to buy one euro.",
      why: "Europe is a major market for Kenyan tea, flowers and vegetables. A stronger euro is good for exporters and bad for anyone importing from the bloc.",
      hist: [148.1,148.6,149.0,148.8,149.2,149.6], note: "Official CBK indicative rate." },

    { id: "kes_gbp", label: "KES per GBP", group: "External", unit: "", dir: -1,
      value: 175.11, prior: 174.8, priorLabel: "yesterday", asOf: "17 Aug 2026", src: "CBK",
      what: "How many shillings it takes to buy one pound.",
      why: "Matters for UK trade, tuition and the large Kenyan community in Britain sending money home.",
      hist: [173.4,174.0,174.5,174.2,174.8,175.11], note: "Official CBK indicative rate." },

    { id: "cover", label: "Import cover", group: "External", unit: " months", dir: 1,
      value: 6.3, prior: 5.6, priorLabel: "June", asOf: "Aug 2026", src: "Typed",
      band: [4, 24], bandLabel: "Statutory floor 4 months",
      what: "How many months of imports the country could pay for out of reserves alone.",
      why: "The practical measure of the external buffer. Below four months and the Central Bank starts losing room to defend the shilling.",
      hist: [4.6,4.9,5.1,5.3,5.6,6.0,6.3],
      note: "Comfortably above the four-month statutory floor." },

    { id: "reserves", label: "FX reserves", group: "External", unit: "$bn", dir: 1,
      value: 15.25, prior: 13.2, priorLabel: "June", asOf: "Aug 2026", src: "Typed",
      hist: [9.8,10.4,11.2,11.8,12.4,13.2,14.1,15.25],
      what: "The foreign currency the Central Bank holds.",
      why: "The country's buffer. It is what defends the shilling in a bad month and pays for imports when export earnings fall short.",
      note: "6.3 months of import cover against a 4-month floor. The strongest buffer in a decade." },
    { id: "cab", label: "Current account", group: "External", unit: "% GDP", dir: 1,
      value: -3.0, prior: -1.9, priorLabel: "a year ago", asOf: "12m to Jun 2026", src: "Typed",
      hist: [-1.9,-2.1,-2.4,-2.7,-3],
      what: "The gap between what Kenya earns abroad and what it spends abroad.",
      why: "A persistent deficit must be funded by borrowing or investment from outside. It is the external equivalent of spending more than you earn.",
      note: "Widening as imports outrun exports. The one external line genuinely deteriorating." },

    { id: "gdp", label: "GDP growth", group: "Activity", unit: "%", dir: 1,
      value: 5.3, prior: 4.9, priorLabel: "Q1 2025", asOf: "Q1 2026", src: "KNBS",
      hist: [4.9,5,4.6,4.8,5.3],
      what: "How much more the economy produced than in the same quarter last year.",
      why: "The broadest measure of whether the country is getting richer. It arrives late, so most of what it reports you could already see in credit and activity data.",
      note: "Broad-based across industry and services." },
    { id: "pmi", label: "Stanbic PMI", group: "Activity", unit: "", dir: 1,
      value: 51.8, prior: 51.2, priorLabel: "June", asOf: "Jul 2026", src: "Typed",
      band: [50, 100], bandLabel: "Above 50 means expansion",
      hist: [49.6,50.1,50.8,51.4,50.9,51.2,51.8],
      what: "A monthly survey of purchasing managers. Above 50 means expansion.",
      why: "The earliest read on activity there is, published on the first working day of each month \u2014 months before GDP confirms the same story.",
      note: "The earliest read on activity there is - published on the first working day, months before GDP." },

    { id: "nasi", label: "NSE All Share", group: "Markets", unit: "", dir: 1,
      value: 241.18, prior: 238.13, priorLabel: "14 Aug", asOf: "17 Aug 2026", src: "NSE",
      hist: [186,194,203,212,221,228,231.6,236.3,238.13,241.18],
      what: "The value of every share on the Nairobi exchange, as an index.",
      why: "The market's collective opinion on the future of listed companies. It usually moves before earnings do.",
      note: "Up 27.6% this year. Straight from the exchange, not a republisher." },
    { id: "nse20", label: "NSE 20 Share", group: "Markets", unit: "", dir: 1,
      value: 4178.5, prior: 4136.12, priorLabel: "previous close", asOf: "17 Aug 2026", src: "NSE",
      hist: [3170,3320,3480,3640,3790,3920,4050,4136,4178.5],
      what: "An index of twenty large, actively traded shares.",
      why: "The older, narrower gauge. Useful for comparison with the past, less representative of the market today.",
      note: "Third-party feeds were quoting 3,710 on the same day the exchange published 4,178.50." },
    { id: "nse25", label: "NSE 25 Share", group: "Markets", unit: "", dir: 1,
      value: 6717.1, prior: 6650.2, priorLabel: "previous close", asOf: "17 Aug 2026", src: "NSE",
      what: "An index of twenty-five shares weighted by size and liquidity.",
      why: "A middle ground between the narrow NSE 20 and the all-inclusive NASI.",
      hist: [5100,5400,5700,6000,6250,6450,6650,6717.1],
      note: "Broader than the NSE 20 and less dominated by a handful of names." },

    { id: "bank_idx", label: "NSE Banking Sector", group: "Markets", unit: "", dir: 1,
      value: 279.9, prior: 276.63, priorLabel: "previous close", asOf: "17 Aug 2026", src: "NSE",
      hist: [206,218,231,244,256,265,272,276.6,279.9],
      what: "An index of listed banking shares.",
      why: "Banks are the plumbing of the economy, so their share prices tend to price a recovery before the wider market notices it.",
      note: "Up 35.8% this year, ahead of the wider market. Pricing the credit recovery before earnings show it." },
    { id: "mktcap", label: "NSE market cap", group: "Markets", unit: " KES bn", dir: 1,
      value: 4047.48, prior: 3996.38, priorLabel: "previous close", asOf: "17 Aug 2026", src: "NSE",
      hist: [3200,3400,3600,3800,3950,4040,3996,4047.48],
      what: "What every listed company is collectively worth.",
      why: "Against the size of the economy it shows whether the market is cheap or dear compared with its own history.",
      note: "About $31bn, or 23% of GDP." },

    { id: "debt", label: "Public debt stock", group: "Fiscal", unit: " KES tn", dir: -1,
      value: 13.02, prior: 12.82, priorLabel: "March", asOf: "May 2026", src: "Typed",
      hist: [11.13,11.8,12.29,12.4,12.84,12.82,13.02],
      what: "The total the government owes, at home and abroad.",
      why: "Every shilling of it must eventually be repaid out of taxes. The pace at which it grows matters more than the level.",
      note: "KES 10tn to 13tn in fifteen months. The pace is the story, not the level." },
    { id: "debt_gdp", label: "Public debt to GDP", group: "Fiscal", unit: "%", dir: -1,
      value: 69.9, prior: 69.5, priorLabel: "February", asOf: "Mar 2026", src: "Typed",
      band: [0, 55], bandLabel: "Statutory anchor 55% by 2028",
      hist: [66.2,67,67.6,67.8,69.5,69.9],
      what: "Government debt measured against the size of the economy.",
      why: "The standard way of asking whether a debt is large relative to the ability to repay it. Parliament's own ceiling is 55%.",
      note: "14.9pp above Parliament's anchor. The IMF sees 71.6% this year and no inflection to 2031." },
    { id: "debtserv", label: "Debt service to revenue", group: "Fiscal", unit: "%", dir: -1,
      value: 69, prior: 63, priorLabel: "FY23/24", asOf: "FY24/25", src: "Typed",
      band: [0, 30], bandLabel: "IMF comfort threshold 30%",
      hist: [48,55,59,63,69],
      what: "The share of government revenue spent on interest and repayments.",
      why: "The most binding number in Kenyan public finance. Every shilling here is one that cannot build a road or staff a clinic.",
      note: "KES 1.72tn against ordinary revenue. More than twice the threshold, and the binding constraint on everything else." },

    { id: "fed_funds", label: "US Fed funds", group: "Global", unit: "%", dir: 0,
      value: 3.63, prior: 4.33, priorLabel: "a year ago", asOf: "13 Aug 2026", src: "FRED",
      hist: [5.33,5.33,4.83,4.58,4.33,4.33,4.08,3.88,3.63],
      what: "The US central bank's policy rate.",
      why: "It sets the return on holding dollars. When it falls, money looks harder for yield elsewhere \u2014 which is quietly good for the shilling and for Kenyan bonds.",
      note: "170bp of cuts. A falling Fed narrows the carry on holding dollars, which is quietly supportive of the shilling." },
    { id: "us10y", label: "US 10-year", group: "Global", unit: "%", dir: 0,
      value: 4.63, prior: 4.28, priorLabel: "a year ago", asOf: "13 Aug 2026", src: "FRED",
      hist: [4.28,4.15,4.35,4.5,4.4,4.55,4.7,4.63],
      what: "The return on lending to the US government for ten years.",
      why: "The world's risk-free rate. Everything else, including Kenyan debt, is priced as a premium on top of it.",
      note: "Rising while the Fed cuts. The long end is pricing something the short end is not." },
    { id: "ssa_gdp", label: "Sub-Saharan Africa growth", group: "Global", unit: "%", dir: 1,
      value: 4.3, prior: 4.5, priorLabel: "2025", asOf: "2026 forecast", src: "IMF",
      hist: [3.6,4,4.5,4.3],
      what: "Expected growth across Sub-Saharan Africa.",
      why: "Kenya's neighbourhood and its main regional market. Kenya growing faster than the region is the case for investing here rather than next door.",
      note: "Kenya is forecast to grow above the regional average through 2031." },
    { id: "world_gdp", label: "World growth", group: "Global", unit: "%", dir: 1,
      value: 3.1, prior: 3.4, priorLabel: "2025", asOf: "2026 forecast", src: "IMF",
      hist: [3.5,3.3,3.4,3.1],
      what: "Expected growth for the world economy.",
      why: "It sets demand for Kenya's tea, coffee, flowers and tourism. A slowing world reaches Nairobi through the export desk.",
      note: "Slowing. Export demand and tourism both take their cue from this." },
  ],

  /* ---- LAYER 1: after-tax real return, computed by the collector ---- */
  ladder: [
    { id: "infra", label: "Infrastructure bond", gross: 12.8, taxPct: 0, net: 12.8, real: 6.31, note: "tax-exempt", doublingYears: 11.4, typed: true, asOf: "2026-08-01", ageDays: 17, stale: false },
    { id: "bond10", label: "10-year bond", gross: 13.45, taxPct: 10, net: 12.11, real: 5.62, note: "10% WHT", doublingYears: 12.8 },
    { id: "mmf_top", label: "Top-quartile MMF", gross: 12.1, taxPct: 15, net: 10.29, real: 3.79, note: "15% WHT", doublingYears: 19.0, typed: true, asOf: "2026-04-01", ageDays: 139, stale: true },
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
    { id: "gdp", label: "GDP growth", lagMonths: 11, value: 5.3, move: 0.4, status: "still",
      why: "Activity follows the cost of borrowing, at a long remove" },
  ],

  /* ---- LAYER 3: relationships that have come apart ---- */
  breaks: [
    { name: "Bank margin over policy", value: 5.63, unit: "pp", normalLo: 3.5, normalHi: 5.5, state: "high", basis: "judgement", n: 0,
      why: "Average lending rate less the Central Bank Rate.",
      reading: "Banks are holding spreads wide while policy eases. Transmission is incomplete, so more of the cut has yet to reach borrowers - and more of the fall in lending rates is still to come." },
    { name: "91-day over policy", value: 0.02, unit: "pp", normalLo: -1, normalHi: 0.75, state: "normal", basis: "judgement", n: 0,
      why: "91-day bill less the Central Bank Rate.",
      reading: "Inside its usual range, but it has climbed 113bp since February. Worth watching: a move above 0.75 says the market has stopped believing in more cuts." },
    { name: "Sovereign spread", value: 8.82, unit: "pp", normalLo: 7, normalHi: 11, state: "normal", basis: "judgement", n: 0,
      why: "Kenya 10-year less the US 10-year.",
      reading: "Mid-range. Foreign money is being paid fairly to stay in Kenyan paper, and the state is not paying a crisis premium." },
    { name: "Real deposit rate", value: 0.35, unit: "pp", normalLo: -1, normalHi: 2, state: "normal", basis: "judgement", n: 0,
      why: "Average deposit rate less headline inflation.",
      reading: "Barely positive. A bank deposit is just about keeping pace with inflation, and a savings account is not." },
    { name: "Market cap to GDP", value: 23.02, unit: "%", normalLo: 15, normalHi: 30, state: "normal", basis: "judgement", n: 0,
      why: "NSE market capitalisation as a share of GDP.",
      reading: "Re-rating off the bottom. It reached 30% in 2013 and fell to 15% in 2023. There is room before this looks stretched." },
    { name: "Overnight against policy", value: 0, unit: "pp", normalLo: -0.5, normalHi: 0.5, state: "normal", basis: "judgement", n: 0,
      why: "KESONIA less the Central Bank Rate.",
      reading: "Exactly on policy. The money market is in balance - no stress, no flood." },
  ],

  call: "Real yields are positive: seven of ten instruments beat inflation after tax, led by infrastructure bonds at +6.31% real. Three lose purchasing power, cash worst at −6.49%. In the chain, everything has moved except GDP, which lags credit by about eleven months - the growth already funded has not yet printed. One relationship is outside its range: the bank margin over policy at 5.63pp, which says lending rates have further to fall.",

  disagreements: [
    { id: "gdp", label: "GDP growth", kept: "KNBS quarterly", keptValue: 5.3,
      other: "World Bank annual", otherValue: 4.63, gapPct: 12.6,
      why: "Different vintages. The quarterly print is Q1 2026, the annual is calendar 2025." },
    { id: "tbill_tax", label: "T-bill withholding tax", kept: "Tax practices", keptValue: 15,
      other: "Retail aggregator", otherValue: 0, gapPct: 100,
      why: "EY, Cliffe Dekker and FNJ all state 15% on bill interest. One retail site claims individuals are exempt. No tax practice corroborates it, so 15% is used - override it in settings if your own advice differs." },
  ],
};

const SOURCES = [
  { name: "Central Bank of Kenya", covers: "CBR, KESONIA, REPO, 91-day, inflation, lending, deposit, savings, official FX - ten rates in one request", key: false },
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

function stateOf(i) {
  if (i.band) { const [lo, hi] = i.band; if (i.value > hi || i.value < lo) return "stress"; }
  if (i.prior == null || i.dir === 0) return "steady";
  const m = (i.value - i.prior) / Math.abs(i.prior || 1);
  if (Math.abs(m) < 0.01) return "steady";
  return (m > 0) === (i.dir > 0) ? "good" : "stress";
}
const fmt = (v, unit, dp) => {
  if (v == null) return "-";
  const d = dp != null ? dp : Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 2 : 2;
  return v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }) + (unit || "");
};

/* ===========================================================================
   Pieces
=========================================================================== */
/* Icons are drawn, not typed. An emoji renders differently on every platform
   and carries no accessible name of its own. */
const G = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round",
  strokeLinejoin: "round", "aria-hidden": "true" };

const ThemeGlyph = ({ mode }) => mode === "light"
  ? <svg {...G}><circle cx="12" cy="12" r="4.2" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" /></svg>
  : mode === "dark"
  ? <svg {...G}><path d="M20 14.5A8.2 8.2 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5Z" /></svg>
  : <svg {...G}><circle cx="12" cy="12" r="8.2" /><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4Z" fill="currentColor" stroke="none" /></svg>;

const GearGlyph = () => (
  <svg {...G}><circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></svg>
);

const CloseGlyph = () => <svg {...G}><path d="M18 6 6 18M6 6l12 12" /></svg>;

function Mark({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="13" style={{ fill: "var(--md-primary)" }} />
      <path d="M7 27h6.5l3.6-11 5.4 20 4.6-15 3.2 8.5h11"
        fill="none" strokeWidth="2.6" style={{ stroke: "var(--md-on-primary)" }}
        strokeLinecap="round" strokeLinejoin="round" opacity=".97" />
      <circle cx="38.5" cy="29.5" r="2.9" style={{ fill: "var(--md-on-primary)" }} />
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
      <polyline points={pts} fill="none" strokeWidth="1.8"
        strokeLinejoin="round" strokeLinecap="round"
        style={{ stroke: colour, strokeDasharray: 400, strokeDashoffset: 0,
          animation: "kp-draw .7s var(--ease-standard)" }} />
      <circle cx={w} cy={h - ((last - lo) / r) * (h - 4) - 2} r="2.6" style={{ fill: colour }} />
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
      <div style={{ display: "flex", gap: 4, minWidth: 0 }}>
        {/* y-axis: without a scale the bars are decoration, not information */}
        <div style={{ width: axisW, height: H, position: "relative", flexShrink: 0,
          fontSize: narrow ? "0.6875rem" : "0.6875rem", color: c.faint }}>
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
          {/* design.md 11.2: horizontal gridlines only - no axis line, no
              tick marks, no border. The zero rule below carries the baseline. */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: narrow ? 1 : 2,
            height: H, position: "relative", minWidth: 0 }}>
            <div style={{ position: "absolute", left: 0, right: 0, top: `${zero}%`,
              borderTop: `1px dashed ${c.line}` }} />
            {values.map((v, i) => {
              const on = hover === i;
              const h = v == null ? 0 : (Math.abs(v) / r) * 100;
              const up = (v ?? 0) >= 0;
              return (
                <div key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                  onClick={() => setHover(on ? null : i)}
                  title={v == null ? `${years[i]} - not published` : `${years[i]}: ${fmt(v, unit)}`}
                  style={{ flex: 1, minWidth: 0, height: "100%", position: "relative",
                    cursor: "pointer" }}>
                  {v == null ? (
                    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0,
                      height: 3, background: c.line, opacity: .5, borderRadius: 4 }} />
                  ) : (
                    <div style={{ position: "absolute", left: 0, right: 0,
                      top: up ? `calc(${zero}% - ${h}%)` : `${zero}%`,
                      height: `${h}%`, minHeight: 1,
                      background: on ? c.ink : (up ? c.good : c.bad),
                      opacity: on ? 1 : .84, borderRadius: 4,
                      transition: "background .15s, opacity .15s" }} />
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between",
            fontSize: narrow ? "0.6875rem" : "0.75rem", color: c.faint, marginTop: 4, gap: 4 }}>
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
  <span style={{ fontSize: "0.6875rem", fontWeight: 600, letterSpacing: ".05em",
    textTransform: "uppercase", whiteSpace: "nowrap", padding: "3px 9px", borderRadius: "var(--r-lg)",
    color: { good: c.good, stress: c.bad, watch: c.warn, steady: c.dim }[tone] || c.dim,
    background: c.chip }}>{children}</span>
);

/* ===========================================================================
   App
=========================================================================== */
export default function KenyaPulse() {
  const [cfg, setCfg] = useState(() => ({
    theme: uiPref("ui.theme", ["system", "light", "dark"], "system"),
    size: uiPref("ui.fontScale", ["compact", "default", "large", "xlarge"], "default"),
    autoSync: true,
    pinned: ["inflation", "cbr", "tbill", "debt_gdp"], showBands: true,
    compact: false, taxBill: 15, taxMmf: 15, taxBond: 10,
    notifyOn: false, notifyTime: "08:00", notifyDays: [1, 2, 3, 4, 5],
    ...store.get("kp.cfg", {}),
    /* last word to the keys the pre-paint script read */
    theme: uiPref("ui.theme", ["system", "light", "dark"],
      store.get("kp.cfg", {}).theme || "system"),
    size: uiPref("ui.fontScale", ["compact", "default", "large", "xlarge"],
      store.get("kp.cfg", {}).size || "default"),
  }));
  const [data, setData] = useState(() => store.get("kp.data", SEED));
  const [tab, setTab] = useState(() => readHash().tab || "pulse");
  const [openSettings, setOpenSettings] = useState(false);
  const [trendKey, setTrendKey] = useState(() => {
    const h = readHash();
    return h.tab === "trends" && h.id && ANNUAL[h.id] ? h.id : "gdp_growth";
  });
  const [expanded, setExpanded] = useState(() => {
    const h = readHash();
    return h.tab === "pulse" && h.id ? h.id : null;
  });
  const [openBreak, setOpenBreak] = useState(() => {
    const h = readHash();
    return h.tab === "edge" && h.id ? h.id : null;
  });
  const [sync, setSync] = useState({ state: "idle", msg: "" });
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  const saveTimer = useRef(null);
  useEffect(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => store.set("kp.cfg", cfg), 250);
    return () => clearTimeout(saveTimer.current);
  }, [cfg]);
  useEffect(() => { store.probe(); }, []);
  /* The scaffold's index.html may carry a stale title; the app states its own. */
  useEffect(() => { try { document.title = "Kenya Pulse"; } catch { /* not fatal */ } }, []);

  /* The clock is the device's, not the feed's. */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const [notePerm, setNotePerm] = useState(() =>
    typeof Notification !== "undefined" ? Notification.permission : "unsupported");
  const [noteState, setNoteState] = useState({ state: "idle", msg: "" });
  const [pushCap] = useState(pushCapability);

  useEffect(() => {
    const id = tab === "trends" ? trendKey
      : tab === "pulse" ? expanded
      : tab === "edge" ? openBreak : null;
    writeHash(tab, id);
  }, [tab, trendKey, expanded, openBreak]);

  useEffect(() => {
    const onNav = () => {
      const h = readHash();
      if (h.tab) setTab(h.tab);
      if (h.tab === "trends" && h.id && ANNUAL[h.id]) setTrendKey(h.id);
      if (h.tab === "pulse") setExpanded(h.id || null);
      if (h.tab === "edge") setOpenBreak(h.id || null);
    };
    window.addEventListener("hashchange", onNav);
    return () => window.removeEventListener("hashchange", onNav);
  }, []);
  useEffect(() => () => { clearTimeout(copyTimer.current); clearTimeout(saveTimer.current); }, []);
  const set = (k, v) => setCfg(p => ({ ...p, [k]: v }));

  /* viewport width drives the handful of layout decisions that cannot be made
     in CSS alone - sparkline geometry, label length, chart density */
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
  const c = C;

  /* The palette and the scale live on <html>, matching the script that ran
     before the first stylesheet. Writing the same two keys it reads means the
     next cold start opens in the right theme with no flash. design.md 12. */
  useEffect(() => {
    const root = typeof document !== "undefined" && document.documentElement;
    if (!root) return;                       // no DOM: nothing to dress
    root.classList.toggle("dark", dark);
    root.dataset.fontScale = cfg.size;
    try {
      window.localStorage.setItem("ui.theme", cfg.theme);
      window.localStorage.setItem("ui.fontScale", cfg.size);
    } catch { /* private browsing; the app still works, it just forgets */ }
  }, [dark, cfg.theme, cfg.size]);

  const pull = async (silent) => {
    setSync({ state: "busy", msg: "Fetching…" });
    try {
      const r = await fetch(FEED, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const merged = mergeFeed(SEED, j);
      setData(merged); store.set("kp.data", merged);
      setSync({ state: "ok", msg: `Synced ${j.asOf || "now"}` });
      return merged;
    } catch (e) {
      setSync({ state: "err", msg: silent ? "" : `Could not reach the feed - ${e.message}` });
      return null;
    }
  };
  useEffect(() => {
    store.set("kp.data", data);                       // seed the drawer on first run
    if (cfg.autoSync) pull(true);
    /* eslint-disable-next-line */
  }, []);

  const inds = useMemo(() => data.indicators.map(i => ({ ...i, state: stateOf(i) })), [data]);

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
  const stressed = inds.filter(i => i.state === "stress");
  const offRange = data.breaks.filter(b => b.state !== "normal");

  /* There is no composite score. One number that weights the currency the same
     as debt service is not measuring anything, it only feels as though it is.
     The headline is the most actionable fact instead: what the best available
     return is once tax and inflation have taken their share. */
  const best = ladder[0], worst = ladder[ladder.length - 1];
  const spread = best && worst ? best.real - worst.real : 0;
  const staleRungs = ladder.filter(r => r.stale);
  const vcol = best && best.real > 0 ? c.good : c.bad;

  const brief = useMemo(() => buildBrief(inds, ladder, data.breaks, data.asOf),
    [inds, ladder, data]);

  /* ---- Daily notification ----------------------------------------------
     The schedule lives on the server, not in this page. A timer here only
     runs while the app is open, which is precisely when a reminder is least
     useful. The device registers a push subscription and its preferred time;
     the sender on the VM wakes it. Turning the toggle off deletes the
     subscription at both ends. */
  const enableNotify = async (v) => {
    if (!v) {
      set("notifyOn", false);
      setNoteState({ state: "idle", msg: "" });
      await pushUnsubscribe();
      return;
    }
    /* Permission first, and before any await that is not the request itself:
       Safari only honours the prompt inside the tap that asked for it. */
    if (typeof Notification === "undefined") return;
    let p = Notification.permission;
    if (p === "default") {
      try { p = await Notification.requestPermission(); } catch { p = "denied"; }
    }
    setNotePerm(p);
    if (p !== "granted") { set("notifyOn", false); return; }

    setNoteState({ state: "busy", msg: "Scheduling…" });
    const r = await pushSubscribe({ time: cfg.notifyTime, days: cfg.notifyDays });
    if (r.ok) {
      set("notifyOn", true);
      setNoteState({ state: "ok", msg: "Scheduled. It arrives whether the app is open or not." });
    } else {
      set("notifyOn", false);
      setNoteState({ state: "err", msg: r.msg });
    }
  };

  /* A change of time or days is only worth a round trip once the user has
     stopped fiddling with the control. */
  const noteSync = useRef(null);
  useEffect(() => {
    if (!cfg.notifyOn) return;
    clearTimeout(noteSync.current);
    noteSync.current = setTimeout(async () => {
      const r = await pushSubscribe({ time: cfg.notifyTime, days: cfg.notifyDays });
      setNoteState(r.ok
        ? { state: "ok", msg: "Schedule updated." }
        : { state: "err", msg: r.msg });
    }, 900);
    return () => clearTimeout(noteSync.current);
  }, [cfg.notifyOn, cfg.notifyTime, cfg.notifyDays]);

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

  /* The device's own share sheet where the browser offers one; the clipboard
     where it does not, so desktop browsers still get a working button. */
  const share = async (title, url) => {
    if (typeof navigator !== "undefined" && navigator.share) {
      try { await navigator.share({ title, url }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    copy(url);
  };

  const S = {
    page: { minHeight: "100vh", background: c.bg, color: c.ink,
      fontFamily: "var(--font-ui)", ...T.bodyMd,
      transition: "background var(--dur-medium, .3s) var(--ease-standard)" },
    wrap: { maxWidth: 720, margin: "0 auto",
      padding: narrow ? "10px 10px 40px" : "12px 14px 44px" },
    eyebrow: { fontSize: "0.75rem", fontWeight: 600, letterSpacing: ".1em",
      textTransform: "uppercase", color: c.dim },
    icon: { width: 44, height: 44, borderRadius: "var(--r-full)", border: "none",
      background: c.chip, color: c.dim, cursor: "pointer", ...T.labelLg,
      display: "grid", placeItems: "center", flexShrink: 0,
      transition: "transform .16s var(--ease-emphasized), background .2s" },
    btn: (bg, fg) => ({ padding: "10px 18px", borderRadius: "var(--r-sm)", border: "none",
      background: bg, color: fg, fontWeight: 600, cursor: "pointer", fontSize: "0.875rem",
      letterSpacing: "-.01em",
      transition: "transform .18s var(--ease-emphasized), background .2s" }),
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
        @keyframes kp-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        @keyframes kp-fade{from{opacity:0}to{opacity:1}}
        @keyframes kp-sheet{from{transform:translateY(100%)}to{transform:none}}
        @keyframes kp-veil{from{opacity:0}to{opacity:1}}
        @keyframes kp-draw{from{stroke-dashoffset:400}to{stroke-dashoffset:0}}
        @keyframes kp-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
        /* Apple's standard easing. Motion decelerates rather than coasting,
           which is most of why native transitions feel settled. */
        .kp-tap{transition:transform .18s var(--ease-emphasized)}
        /* Nothing may push the page sideways. A dashboard that scrolls
           horizontally on a phone is a dashboard you stop opening. */
        html,body{overflow-x:hidden;-webkit-text-size-adjust:100%}
        table{max-width:100%}
        pre{word-break:break-word}
        .kp-tap:active{transform:scale(.96);opacity:.7}
        .kp-f:focus-visible{outline:2px solid ${c.cool};outline-offset:2px;border-radius:8px}
        .kp-bar{transform-origin:left;animation:kp-grow .6s var(--ease-emphasized) both}
        @media (prefers-reduced-transparency:reduce){
          .kp-veil{background:var(--md-surface)!important}
        }
        @media (prefers-reduced-motion:reduce){
          *,*::before,*::after{animation:none!important;transition:none!important}
        }
      `}</style>

      <div style={S.wrap}>
        {/* ---------------- header ---------------- */}
        <header style={{ display: "flex", alignItems: "flex-start", gap: 12,
          margin: "6px 0 18px", padding: "0 2px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 0 }}>
              <Mark size={26} />
              <span style={{ fontSize: "0.75rem", fontWeight: 600, color: c.dim,
                letterSpacing: ".01em" }}>Kenya Pulse</span>
            </div>
            <div style={{ fontSize: narrow ? "1.75rem" : "2rem", fontFamily: MONO, fontWeight: 600,
              letterSpacing: "-.028em", lineHeight: 1.08 }}>
              {now.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}
            </div>
            <div style={{ fontSize: "0.75rem", color: c.faint, marginTop: 4 }}>
              {now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              {" · readings to "}
              {new Date(data.asOf + "T00:00:00").toLocaleDateString("en-GB",
                { day: "numeric", month: "short" })}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
            <button className="kp-f kp-tap" style={S.icon} aria-label="Theme"
              onClick={() => set("theme", cfg.theme === "light" ? "dark"
                : cfg.theme === "dark" ? "system" : "light")}>
              <ThemeGlyph mode={cfg.theme} />
            </button>
            <button className="kp-f kp-tap" style={S.icon} aria-label="Settings"
              onClick={() => setOpenSettings(true)}><GearGlyph /></button>
          </div>
        </header>

        {/* ---------------- hero ---------------- */}
        <div style={{ marginBottom: 16, minWidth: 0,
          animation: "kp-rise .42s both var(--ease-emphasized)" }}>
          <div style={{ fontSize: "0.75rem", fontWeight: 600, letterSpacing: ".02em",
            color: c.dim, padding: "0 16px 7px", textTransform: "uppercase" }}>
            Best real return
          </div>
          <div style={{ background: c.card, borderRadius: "var(--r-lg)", padding: narrow ? 16 : 18,
            boxShadow: c.shadow }}>
            {best ? (
              <>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8,
                  flexWrap: "wrap" }}>
                  <span style={{ fontSize: narrow ? "1.875rem" : "2.25rem", fontFamily: MONO, fontWeight: 600,
                    color: vcol, letterSpacing: "-.045em", lineHeight: 1 }}>
                    {best.real > 0 ? "+" : ""}{best.real.toFixed(2)}%
                  </span>
                  <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>{best.label}</span>
                </div>
                <div style={{ fontSize: "0.875rem", color: c.dim, marginTop: 8, lineHeight: 1.5 }}>
                  After tax and inflation. Cash loses {Math.abs(worst.real).toFixed(2)}% -
                  a gap of <strong style={{ color: c.ink, fontWeight: 600 }}>
                  KES {Math.round(spread * 10000).toLocaleString("en-GB")}</strong> a year
                  on a million.
                </div>
              </>
            ) : <div style={{ color: c.dim }}>Waiting on rates.</div>}

            {staleRungs.length > 0 && (
              <div style={{ marginTop: 8, fontSize: "0.75rem", color: c.warn }}>
                {staleRungs.length} rate{staleRungs.length > 1 ? "s" : ""} overdue a refresh
              </div>
            )}

            <div style={{ display: "flex", gap: 0.5, marginTop: 16, height: 14,
              alignItems: "center" }}>
              {inds.map((i, n) => (
                <button key={i.id} title={`${i.label} - ${i.state}`} className="kp-f"
                  onClick={() => { setTab("pulse"); setExpanded(i.id); }}
                  style={{ flex: 1, border: "none", padding: 0, cursor: "pointer",
                    borderRadius: 4,
                    height: i.state === "stress" ? 14 : i.state === "good" ? 9 : 4,
                    background: i.state === "stress" ? c.bad
                      : i.state === "good" ? c.good : c.line,
                    opacity: i.state === "steady" ? 1 : .82,
                    animation: `kp-rise .45s ${n * 0.012}s both var(--ease-emphasized)` }} />
              ))}
            </div>
            <div style={{ fontSize: "0.75rem", color: c.faint, marginTop: 8, lineHeight: 1.45 }}>
              {stressed.length
                ? <>{stressed.length} under pressure
                  {offRange.length > 0 && `, ${offRange.length} off range`}</>
                : "Nothing under pressure."}
            </div>
          </div>
        </div>

        {/* ---------------- tabs ---------------- */}
        <div role="tablist" style={{ display: "flex", background: c.seg, borderRadius: "var(--r-sm)",
          padding: 0, marginBottom: 16 }}>
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className="kp-f kp-tap"
              role="tab" aria-selected={tab === k}
              style={{ flex: 1, minWidth: 0, padding: "7px 2px",
                border: "none", borderRadius: "var(--r-xs)", cursor: "pointer",
                background: tab === k ? c.segOn : "transparent",
                ...T.labelLg,
                letterSpacing: tiny ? "-.02em" : "-.01em",
                color: tab === k ? c.ink : c.dim, fontWeight: 600,
                boxShadow: tab === k ? c.segShadow : "none", whiteSpace: "nowrap",
                transition: "background .22s var(--ease-emphasized), color .2s, box-shadow .22s" }}>
              {l}
            </button>
          ))}
        </div>

        {/* minWidth:0 is load-bearing. A grid item defaults to min-width:auto,
            which lets a horizontally scrolling child push the whole column
            wider than the screen. That is what clipped the Trends chart. */}
        <div key={tab} style={{ display: "grid", gap: 12, minWidth: 0,
          animation: "kp-fade .32s var(--ease-emphasized) both" }}>

          {/* ================= PULSE ================= */}
          {tab === "pulse" && <>
            {cfg.pinned.length > 0 && (
              <Section title="Pinned" c={c} i={0} pad={narrow ? 16 : 18}>
                <div style={{ display: "grid",
                  gridTemplateColumns: tiny ? "1fr" : "1fr 1fr", gap: narrow ? 12 : 14 }}>
                  {cfg.pinned.map(id => byId[id]).filter(Boolean).map(i => (
                    <div key={i.id} style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "0.75rem", color: c.dim, marginBottom: 4,
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap" }}>{i.label}</div>
                      {/* The figure stays neutral. Colour belongs on the change, not
                          the level - a rate easing slightly is not bad news. */}
                      <div style={{ fontSize: "1.5rem", fontFamily: MONO, fontWeight: 600, color: c.ink,
                        letterSpacing: "-.03em", lineHeight: 1.15 }}>
                        {fmt(i.value, i.unit)}
                      </div>
                      {i.prior != null && (
                        <div style={{ fontSize: "0.75rem", marginTop: 0,
                          color: i.state === "stress" ? c.bad
                            : i.state === "good" ? c.good : c.faint }}>
                          {i.value > i.prior ? "↑" : i.value < i.prior ? "↓" : "–"}
                          {" "}{fmt(Math.abs(i.value - i.prior), i.unit)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {groups.map((g, gi) => (
              <Section title={g} c={c} key={g} i={gi + 1} pad={0}>
                {inds.filter(i => i.group === g).map((i, n, arr) => {
                  const open = expanded === i.id;
                  const col = i.state === "stress" ? c.bad : i.state === "good" ? c.good : c.faint;
                  return (
                    <div key={i.id}>
                      <button onClick={() => setExpanded(open ? null : i.id)} className="kp-f"
                        aria-expanded={open}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12,
                          padding: cfg.compact ? "10px 16px" : "13px 16px", background: "none",
                          border: "none", cursor: "pointer", textAlign: "left", minHeight: 44 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "var(--r-xs)", background: col,
                          flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontWeight: 500, fontSize: "0.875rem",
                            lineHeight: 1.3, letterSpacing: "-.012em",
                            ...(narrow ? {} : { overflow: "hidden", textOverflow: "ellipsis",
                              whiteSpace: "nowrap" }) }}>{i.label}</span>
                          <span style={{ fontSize: "0.75rem", color: c.faint }}>
                            {i.asOf}
                          </span>
                        </span>
                        {!cfg.compact && !tiny &&
                          <Spark data={i.hist} colour={col} w={narrow ? 46 : 76} h={narrow ? 24 : 28} />}
                        <span style={{ textAlign: "right", flexShrink: 0 }}>
                          <span style={{ display: "block", fontWeight: 600, fontSize: "1rem",
                            letterSpacing: "-.015em" }}>{fmt(i.value, i.unit)}</span>
                          {i.prior != null && (
                            <span style={{ fontSize: "0.75rem", color: col }}>
                              {i.value > i.prior ? "+" : ""}{fmt(i.value - i.prior, "")}
                            </span>
                          )}
                        </span>
                        <span aria-hidden="true" style={{ color: c.faint, fontSize: "0.875rem",
                          flexShrink: 0, transform: open ? "rotate(90deg)" : "none",
                          transition: "transform .25s var(--ease-emphasized)" }}>›</span>
                      </button>

                      {open && (
                        <div style={{ padding: "2px 16px 16px 35px", fontSize: "0.875rem",
                          color: c.dim, animation: "kp-rise .28s both var(--ease-emphasized)" }}>
                          {i.what && (
                            <div style={{ marginBottom: 12, padding: "12px 14px",
                              background: c.chip, borderRadius: "var(--r-sm)" }}>
                              <div style={{ color: c.ink, marginBottom: 8 }}>{i.what}</div>
                              <div style={{ color: c.dim }}>{i.why}</div>
                            </div>
                          )}
                          <div style={{ marginBottom: 12, color: c.ink }}>{i.note}</div>
                          <div style={{ display: "flex", gap: 12, flexWrap: "wrap",
                            fontSize: "0.875rem", color: c.faint }}>
                            <span>{i.src}</span>
                          </div>
                          {i.band && cfg.showBands && (
                            <div style={{ marginTop: 8, color: c.warn }}>{i.bandLabel}</div>
                          )}
                          <button onClick={() => share(i.label, linkTo("pulse", i.id))}
                            className="kp-f kp-tap"
                            style={{ marginTop: 12, padding: 0, border: "none",
                              background: "none", color: c.cool, cursor: "pointer",
                              fontSize: "0.875rem", fontWeight: 600 }}>
                            {copied ? "Link copied" : "Share"}
                          </button>
                        </div>
                      )}

                      {n < arr.length - 1 && (
                        <div style={{ height: 1, background: c.line, marginLeft: 32 }} />
                      )}
                    </div>
                  );
                })}
              </Section>
            ))}
          </>}

          {/* ================= EDGE ================= */}
          {tab === "edge" && <>
            <Section title="Briefing" c={c} i={0} pad={narrow ? 16 : 18}>
              <div style={{ fontSize: "0.875rem", lineHeight: 1.52, color: c.ink }}>{data.call}</div>
              <pre style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
                fontSize: "0.75rem", lineHeight: 1.6, whiteSpace: "pre-wrap",
                margin: "14px 0 0", color: c.dim }}>{brief}</pre>
              <button onClick={() => copy(`${data.call}\n\n${brief}`)} className="kp-f kp-tap"
                style={{ ...S.btn(copied ? c.good : c.cool, "#fff"), marginTop: 12 }}>
                {copied ? "Copied" : "Copy briefing"}
              </button>
            </Section>

            {/* LADDER */}
            <Section title="What is being paid" c={c} i={1} pad={narrow ? 16 : 18}
              note="OLD marks a rate past its usual publication cycle - check it before acting. Arithmetic on published rates, not advice. Tax rates are editable in settings.">
              <div style={{ fontSize: "0.875rem", color: c.dim, marginBottom: 16 }}>
                After withholding tax, less inflation.
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
                        alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontWeight: n === 0 ? 600 : 400, fontSize: "0.875rem",
                          display: "flex", alignItems: "center", gap: 4 }}>
                          {r.label}
                          {r.stale && <span title="This rate needs refreshing"
                            style={{ fontSize: "0.6875rem", fontWeight: 600, color: c.warn,
                              border: `1px solid ${c.warn}`, borderRadius: 4,
                              padding: "0 4px", opacity: .9 }}>OLD</span>}
                        </span>
                        <span style={{ fontWeight: 600, color: pos ? c.good : c.bad,
                          fontSize: "1rem", whiteSpace: "nowrap" }}>
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
                      <div style={{ fontSize: "0.75rem", color: r.stale ? c.warn : c.faint }}>
                        {r.gross.toFixed(2)}% gross · {r.note} · {r.net.toFixed(2)}% net
                        {r.doublingYears && ` · doubles in ${r.doublingYears}y`}
                        {r.stale && (r.ageDays != null
                          ? ` · rate is ${r.ageDays} days old`
                          : " · rate has no date")}
                      </div>
                    </div>
                  );
                });
              })()}
              <div style={{ marginTop: 16, padding: "12px 14px", background: c.chip,
                borderRadius: "var(--r-sm)", fontSize: "0.875rem" }}>
                Top to bottom is <strong style={{ color: c.warn, fontWeight: 600 }}>
                {(ladder[0].real - ladder[ladder.length - 1].real).toFixed(2)} points</strong> a
                year - about <strong style={{ fontWeight: 600 }}>KES {Math.round((ladder[0].real -
                ladder[ladder.length - 1].real) * 10000).toLocaleString("en-GB")}</strong> on a
                million. That is the price of standing still.
              </div>
            </Section>

            {/* CHAIN */}
            <Section title="What is already coming" c={c} i={2} pad={narrow ? 16 : 18}
              note="A link that has not moved while the one before it has is the part nobody has priced.">
              <div style={{ fontSize: "0.875rem", color: c.dim, marginBottom: 16 }}>
                Policy reaches the economy along a chain, each link lagging the last.
              </div>
              {data.chain.map((s, n) => {
                const last = n === data.chain.length - 1;
                const tone = s.status === "moved" ? c.good : s.status === "still" ? c.warn : c.faint;
                return (
                  <div key={s.id} style={{ display: "flex", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 22 }}>
                      <span style={{ width: 11, height: 11, borderRadius: "var(--r-sm)", background: tone,
                        border: `2px solid ${c.card}`, boxShadow: `0 0 0 1.5px ${tone}`, flexShrink: 0,
                        animation: `kp-rise .35s ${n * .06}s both` }} />
                      {!last && <span style={{ flex: 1, width: 2, background: c.line, minHeight: 30 }} />}
                    </div>
                    <div style={{ flex: 1, paddingBottom: last ? 0 : 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between",
                        alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>{s.label}</span>
                        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{s.value}</span>
                      </div>
                      <div style={{ fontSize: "0.75rem", color: c.faint, marginTop: 0 }}>
                        {s.lagMonths === 0 ? "immediate" : `about ${s.lagMonths} months behind policy`}
                        {" · "}{s.why}
                      </div>
                      <div style={{ fontSize: "0.75rem", marginTop: 4, color: tone, fontWeight: 600 }}>
                        {s.status === "moved" && `moved ${s.move > 0 ? "+" : ""}${s.move} over recent readings`}
                        {s.status === "still" && "has not moved yet"}
                        {s.status === "waiting" && "needs more readings"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </Section>

            {/* BREAKS */}
            <Section title="What is mispriced" c={c} i={3} pad={narrow ? 16 : 18}
              note="A measured range is computed from readings this app has logged. A judged one is read off published history until enough readings exist.">
              <div style={{ fontSize: "0.875rem", color: c.dim, marginBottom: 16 }}>
                Relationships that normally hold. One outside its range is either a mispricing
                or a regime change.
              </div>
              {data.breaks.map((b, n) => {
                const open = openBreak === b.name;
                const off = b.state !== "normal";
                const span = b.normalHi - b.normalLo || 1;
                const pos = Math.max(-18, Math.min(118, ((b.value - b.normalLo) / span) * 100));
                return (
                  <div key={b.name} style={{ paddingTop: n ? 14 : 0, paddingBottom: 12,
                    borderTop: n ? `1px solid ${c.line}` : "none" }}>
                    <button onClick={() => setOpenBreak(open ? null : b.name)} className="kp-f"
                      aria-expanded={open}
                      style={{ width: "100%", background: "none", border: "none", padding: 0,
                        cursor: "pointer", textAlign: "left" }}>
                      <div style={{ display: "flex", justifyContent: "space-between",
                        alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>{b.name}</span>
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <strong style={{ color: off ? c.warn : c.ink }}>
                            {b.value}{b.unit}
                          </strong>
                          {off && <Pill tone="watch" c={c}>{b.state}</Pill>}
                        </span>
                      </div>
                      <div style={{ position: "relative", height: 6, background: c.chip,
                        borderRadius: 4, marginBottom: 4 }}>
                        <div style={{ position: "absolute", left: "0%", right: "0%", top: 0,
                          bottom: 0, background: c.line, borderRadius: 4, opacity: .8 }} />
                        {/* Position is data, not motion. It moves once a fortnight
                            when the feed updates; animating it is decoration. */}
                        <div style={{ position: "absolute", top: -4,
                          left: `calc(${pos}% - 3px)`, width: 6, height: 14,
                          borderRadius: 4, background: off ? c.warn : c.good }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between",
                        fontSize: "0.75rem", color: c.faint }}>
                        <span>{b.normalLo}{b.unit}</span>
                        <span>{b.basis === "derived" ? "measured range" : "judged range"}</span>
                        <span>{b.normalHi}{b.unit}</span>
                      </div>
                    </button>
                    {open && (
                      <div style={{ marginTop: 12, fontSize: "0.875rem", animation: "kp-rise .25s both" }}>
                        <div style={{ color: c.ink, marginBottom: 4 }}>{b.reading}</div>
                        <div style={{ color: c.faint, fontSize: "0.875rem", marginBottom: 8 }}>{b.why}</div>
                        <div style={{ color: b.basis === "derived" ? c.faint : c.warn,
                          fontSize: "0.875rem" }}>
                          {b.basisNote || (b.basis === "derived"
                            ? "Range computed from logged readings."
                            : "Range read off published history rather than measured - treat it as a judgement.")}
                        </div>
                        <button onClick={() => share(b.name, linkTo("edge", b.name))}
                          className="kp-f kp-tap"
                          style={{ marginTop: 12, padding: 0, border: "none",
                            background: "none", color: c.cool, cursor: "pointer",
                            fontSize: "0.875rem", fontWeight: 600 }}>
                          {copied ? "Link copied" : "Share"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </Section>
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
              <Section title="Twenty-four years · 2002 to 2025" c={c} i={0} pad={narrow ? 16 : 18}
                note="World Bank national accounts. A flat grey mark is a year not yet published.">

                <div style={{ position: "relative", marginBottom: 12, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 4, overflowX: "auto",
                    paddingBottom: 8, minWidth: 0,
                    scrollbarWidth: "thin", WebkitOverflowScrolling: "touch" }}>
                    {Object.entries(ANNUAL_META).map(([k, m]) => (
                      <button key={k} onClick={() => setTrendKey(k)} className="kp-f kp-tap"
                        style={{ padding: narrow ? "7px 10px" : "7px 12px", borderRadius: "var(--r-sm)",
                          whiteSpace: "nowrap", cursor: "pointer", flexShrink: 0,
                          border: `1px solid ${trendKey === k ? c.good : c.line}`,
                          background: trendKey === k ? c.good : "transparent",
                          color: trendKey === k ? "#fff" : c.dim,
                          fontSize: narrow ? "0.75rem" : "0.75rem",
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
                  marginBottom: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: narrow ? "1.375rem" : "1.5rem", fontFamily: MONO, fontWeight: 600,
                    letterSpacing: "-.03em" }}>{fmt(latest, u)}</span>
                  <span style={{ fontSize: "0.75rem", color: c.dim }}>
                    {meta.unit !== "%" && meta.unit + " · "}{latestYear}
                    {" · "}24-year average {fmt(avg, u)}
                  </span>
                </div>

                <Bars years={YEARS} values={vals} c={c} unit={u} narrow={narrow} />
                <button onClick={() => share(meta.label, linkTo("trends", trendKey))}
                  className="kp-f kp-tap"
                  style={{ marginTop: 12, padding: 0, border: "none", background: "none",
                    color: c.cool, cursor: "pointer", fontSize: "0.875rem", fontWeight: 600 }}>
                  {copied ? "Link copied" : "Share"}
                </button>
              </Section>

              <Section title="Where this sits" c={c} i={1} pad={narrow ? 16 : 18}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "0.75rem", color: c.dim }}>
                    Against the 24-year mean
                  </div>
                  <div style={{ fontSize: "1.5rem", fontFamily: MONO, fontWeight: 600,
                    color: (latest - avg) * meta.dir > 0 ? c.good : c.bad }}>
                    {latest > avg ? "+" : ""}{fmt(latest - avg, u)}
                  </div>
                </div>

                <div style={{ marginTop: 16, ...S.eyebrow, marginBottom: 8 }}>
                  Decade averages
                </div>
                {decades.map(([l, v], n) => (
                  <div key={l} style={{ display: "flex", alignItems: "center",
                    gap: 8, marginBottom: 8, minWidth: 0 }}>
                    <span style={{ width: narrow ? 74 : 82, fontSize: narrow ? "0.75rem" : "0.75rem",
                      color: c.dim, flexShrink: 0, whiteSpace: "nowrap" }}>{l}</span>
                    <span style={{ flex: 1, minWidth: 0, height: 8, background: c.chip,
                      borderRadius: 4, overflow: "hidden" }}>
                      <span className="kp-bar" style={{ display: "block",
                        width: `${Math.max(2, Math.min(100, Math.abs(v) / mx * 100))}%`,
                        height: "100%", background: v >= 0 ? c.good : c.bad,
                        borderRadius: 4, animationDelay: `${n * .07}s` }} />
                    </span>
                    <span style={{ width: narrow ? 58 : 66, textAlign: "right",
                      fontWeight: 600, fontSize: narrow ? "0.75rem" : "0.875rem",
                      flexShrink: 0, whiteSpace: "nowrap" }}>{fmt(v, u)}</span>
                  </div>
                ))}


              </Section>
            </>;
          })()}

          {/* ================= OUTLOOK ================= */}
          {tab === "outlook" && <>
            <Section title="The forward view · IMF" c={c} i={0} pad={narrow ? 16 : 18}>
              <div style={{ fontSize: "0.875rem", color: c.dim }}>
                Left of the marker has happened. Right of it is projection, and a projection is an
                opinion with a spreadsheet attached. Read the direction, not the decimal.
              </div>
            </Section>
            {Object.entries(FORECAST).map(([k, m], gi) => {
              const split = F_YEARS.indexOf(m.actualTo);
              const lo = Math.min(...m.v), hi = Math.max(...m.v), r = (hi - lo) || 1;
              const now = m.v[split], end = m.v[m.v.length - 1];
              const better = (end - now) * m.dir > 0;
              return (
                <Section c={c} key={k} i={gi + 1} pad={narrow ? 16 : 18}>
                  <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "baseline", marginBottom: 12 }}>
                    <span style={{ fontWeight: 600, letterSpacing: "-.015em" }}>{m.label}</span>
                    <Pill tone={better ? "good" : "stress"} c={c}>
                      {better ? "improves" : "deteriorates"} to 2031
                    </Pill>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 82,
                    position: "relative", marginBottom: 4 }}>
                    <div style={{ position: "absolute", top: 0, bottom: -4,
                      left: `${((split + .5) / m.v.length) * 100}%`, borderLeft: `1px dashed ${c.warn}` }} />
                    {m.v.map((val, i) => {
                      const h = Math.max(4, ((val - lo) / r) * 70 + 8), fut = i > split;
                      return (
                        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column",
                          justifyContent: "flex-end", alignItems: "center", height: "100%" }}>
                          {!tiny && (
                            <span style={{ fontSize: narrow ? "0.6875rem" : "0.6875rem",
                              color: c.faint, marginBottom: 0 }}>
                              {val >= 1000 ? Math.round(val) : val}
                            </span>
                          )}
                          <span style={{ width: "82%", height: h, borderRadius: "4px 4px 0 0",
                            background: fut ? "transparent" : c.good,
                            border: fut ? `1.5px dashed ${c.warn}` : "none", opacity: fut ? .9 : 1,
                            animation: `kp-rise .4s ${i * .035}s both` }} />
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {F_YEARS.map(y => (
                      <span key={y} style={{ flex: 1, textAlign: "center", fontSize: "0.6875rem",
                        color: y > m.actualTo ? c.warn : c.faint,
                        fontWeight: y > m.actualTo ? 600 : 400 }}>{String(y).slice(2)}</span>
                    ))}
                  </div>
                </Section>
              );
            })}
            <Section title="What the forward view says" c={c} i={7} pad={narrow ? 16 : 18}>
              <div style={{ fontSize: "0.875rem", display: "grid", gap: 8 }}>
                <div>· Kenya grows near 5% to 2031, above the Sub-Saharan average of 4.4% throughout.</div>
                <div>· Inflation settles around 5.5%, higher than the recent run but inside the band.</div>
                <div>· <strong style={{ color: c.bad }}>Debt rises every single year to 74.6%</strong> - no inflection on anyone's numbers.</div>
                <div>· World growth slows to 3.1%. Export demand and tourism take their cue from that.</div>
                <div style={{ borderTop: `1px solid ${c.line}`, paddingTop: 8, color: c.dim }}>
                  The state stays a heavy borrower in the domestic market for the whole horizon.
                  Domestic yields stay high enough to matter, which is why the top of the ladder is
                  government paper and likely stays there.
                </div>
              </div>
            </Section>
          </>}

          {/* ================= DATA ================= */}
          {tab === "data" && <>
            <Section title="Updates" c={c} i={0} pad={narrow ? 16 : 18}>
              <div style={{ display: "flex", justifyContent: "flex-end",
                alignItems: "center", marginBottom: 8 }}>
                <Pill tone={data.source === "seed" ? "steady" : "good"} c={c}>
                  {data.source === "seed" ? "seeded" : "live"}
                </Pill>
              </div>
              <div style={{ fontSize: "0.875rem", color: c.dim, marginBottom: 12, lineHeight: 1.5 }}>
                Readings sync automatically each time the app opens.
              </div>
              {sync.msg && <div style={{ fontSize: "0.875rem", marginBottom: 12,
                color: sync.state === "err" ? c.bad : c.good }}>{sync.msg}</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => pull(false)} className="kp-f kp-tap"
                  disabled={sync.state === "busy"}
                  style={{ ...S.btn(c.chip, c.ink), fontWeight: 600,
                    opacity: sync.state === "busy" ? .6 : 1 }}>
                  {sync.state === "busy" ? "Fetching…" : "Sync now"}
                </button>
                <button onClick={() => { setData(SEED); store.set("kp.data", SEED);
                  setSync({ state: "idle", msg: "Back to the seeded readings." }); }}
                  className="kp-f kp-tap"
                  style={{ ...S.btn(c.chip, c.dim), fontWeight: 600 }}>
                  Reset
                </button>
              </div>
            </Section>

            <Section title="Where sources disagree" c={c} i={1} pad={narrow ? 16 : 18}
              note="Nothing is averaged. Averaging two vintages makes a third figure nobody published.">

              {data.disagreements.map((d, n) => (
                <div key={d.id} style={{ padding: "12px 0", borderTop: n ? `1px solid ${c.line}` : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: "0.875rem" }}>{d.label}</strong>
                    <Pill tone="watch" c={c}>{d.gapPct}% apart</Pill>
                  </div>
                  <div style={{ display: "flex", gap: 20, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: c.good, fontWeight: 600 }}>KEPT</div>
                      <div style={{ fontWeight: 600 }}>{d.keptValue}</div>
                      <div style={{ fontSize: "0.75rem", color: c.faint }}>{d.kept}</div>
                    </div>
                    <div style={{ opacity: .5 }}>
                      <div style={{ fontSize: "0.75rem", color: c.dim, fontWeight: 600 }}>ALSO SEEN</div>
                      <div style={{ fontWeight: 600 }}>{d.otherValue}</div>
                      <div style={{ fontSize: "0.75rem", color: c.faint }}>{d.other}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: c.dim }}>{d.why}</div>
                </div>
              ))}
            </Section>

            <Section title="Sources" c={c} i={2} pad={narrow ? 16 : 18}
              note="If a source fails, the last good reading is carried forward and labelled with its age.">
              {SOURCES.map(s2 => (
                <div key={s2.name} style={{ display: "flex", gap: 8, padding: "10px 0",
                  borderBottom: `1px solid ${c.line}` }}>
                  <span style={{ width: 7, height: 7, borderRadius: "var(--r-xs)", background: c.good,
                    flexShrink: 0, marginTop: 4 }} />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 600, fontSize: "0.875rem" }}>{s2.name}</span>
                    <span style={{ fontSize: "0.75rem", color: c.faint }}>{s2.covers}</span>
                  </span>
                </div>
              ))}

            </Section>

            <Section title="Every reading" c={c} i={3} pad={narrow ? 16 : 18}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem" }}>
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
                        <td style={{ padding: "8px", textAlign: "right", fontWeight: 600,
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
            </Section>

            <Section title="On this device" c={c} i={4} pad={narrow ? 16 : 18}>
              <div style={{ fontSize: "0.875rem", color: c.dim, lineHeight: 1.5 }}>
                Your settings live on this device only, and no account is needed. Nothing
                is sent anywhere unless you switch the daily notification on, which needs
                an address to send to.
              </div>
              {store.report().ok === false && (
                <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: "var(--r-sm)",
                  background: c.chip, fontSize: "0.875rem", color: c.bad }}>
                  <strong>Nothing is being saved.</strong> This usually means private
                  browsing, or site data blocked for this address. The app still works,
                  but your settings will last only until you close it.
                </div>
              )}
            </Section>
          </>}
        </div>

        {/* ---------------- footer ---------------- */}
        <div style={{ marginTop: 32, paddingBottom: 8, textAlign: "center" }}>
          <a href="https://gachichio.org/kenya-pulse" target="_blank" rel="noopener noreferrer"
            className="kp-f kp-tap"
            style={{ display: "inline-flex", alignItems: "center", gap: 8,
              padding: "10px 18px", borderRadius: "var(--r-full)", background: c.chip,
              color: c.cool, fontWeight: 600, textDecoration: "none", fontSize: "0.875rem",
              minHeight: 44, transition: "opacity .2s" }}
            onMouseEnter={e => { e.currentTarget.style.opacity = ".8"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}>
            Made with <span style={{ color: c.bad }}>❤</span> by Brian Gachichio
          </a>
        </div>
      </div>

      {/* ================= SETTINGS ================= */}
      {openSettings && (
        <div onClick={() => setOpenSettings(false)} role="dialog" aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--md-on-surface) 40%, transparent)", zIndex: 50,
            display: "flex", alignItems: "flex-end", justifyContent: "center",
            animation: "kp-veil .28s both" }} className="kp-veil">
          <div onClick={e => e.stopPropagation()}
            style={{ background: c.bg, width: "100%", maxWidth: 720, maxHeight: "90vh",
              overflowY: "auto", borderRadius: "var(--r-xl) var(--r-xl) 0 0",
              padding: narrow ? "18px 12px 30px" : "20px 16px 34px",
              paddingBottom: "max(34px, env(safe-area-inset-bottom))",
              animation: "kp-sheet .42s var(--ease-emphasized) both" }}>
            <div style={{ width: 36, height: 5, borderRadius: 4, background: c.line,
              margin: "0 auto 18px" }} />
            <div style={{ display: "flex", justifyContent: "space-between",
              alignItems: "center", marginBottom: 24 }}>
              <span style={{ fontSize: "1.375rem", fontWeight: 600,
                letterSpacing: "-.025em" }}>Settings</span>
              <button onClick={() => setOpenSettings(false)} className="kp-f kp-tap"
                style={S.icon} aria-label="Close"><CloseGlyph /></button>
            </div>

            <Row label="Theme" c={c}>
              <Seg value={cfg.theme} onChange={v => set("theme", v)} c={c}
                opts={[["light", "Light"], ["dark", "Dark"], ["system", "Same as device"]]} />
            </Row>
            <Row label="Text size" c={c}>
              <Seg value={cfg.size} onChange={v => set("size", v)} c={c}
                opts={SCALES} />
            </Row>
            <Row label="Sync on open" hint="Fetch the latest readings each time the app starts." c={c}>
              <Toggle on={cfg.autoSync} onChange={v => set("autoSync", v)} c={c} />
            </Row>

            <div style={{ ...S.eyebrow, margin: "26px 0 14px", color: c.good }}>Daily notification</div>
            {pushCap === "install-first" ? (
              <div style={{ fontSize: "0.875rem", color: c.faint, marginBottom: 24, lineHeight: 1.5 }}>
                Add Kenya Pulse to your home screen first - the share button in Safari,
                then <strong style={{ color: c.dim, fontWeight: 600 }}>Add to Home Screen</strong>.
                Open it from there and this setting appears. iPhones only deliver
                notifications to an installed app.
              </div>
            ) : pushCap === "unsupported" ? (
              <div style={{ fontSize: "0.875rem", color: c.faint, marginBottom: 24, lineHeight: 1.5 }}>
                This browser cannot receive notifications. Chrome, Edge and Firefox can, as
                can an iPhone once the app is on the home screen.
              </div>
            ) : (
              <>
                <Row label="Daily briefing"
                  hint="One notification at your chosen time, on the days you choose, sent from the server - so it arrives whether the app is open or closed. Tap it to open the briefing."
                  c={c}>
                  <Toggle on={cfg.notifyOn} onChange={enableNotify} c={c} />
                </Row>
                {notePerm === "denied" && (
                  <div style={{ fontSize: "0.875rem", color: c.bad, marginBottom: 24 }}>
                    Notifications are blocked for this site. Allow them in the browser's
                    site settings, then switch this on again.
                  </div>
                )}
                {noteState.msg && (
                  <div style={{ fontSize: "0.875rem", marginBottom: 24, lineHeight: 1.5,
                    color: noteState.state === "err" ? c.bad
                      : noteState.state === "ok" ? c.good : c.dim }}>
                    {noteState.msg}
                  </div>
                )}
                {cfg.notifyOn && (
                  <>
                    <Row label="Time of day" c={c}>
                      <input type="time" value={cfg.notifyTime}
                        onChange={e => set("notifyTime", e.target.value || "08:00")}
                        style={{ padding: "10px 12px", borderRadius: "var(--r-sm)",
                          border: `1px solid ${c.line}`, background: c.card,
                          color: c.ink, fontSize: "0.875rem" }} />
                    </Row>
                    <Row label="Days" hint="Deselect all to pause without switching off." c={c}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {[["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4],
                          ["Fri", 5], ["Sat", 6], ["Sun", 0]].map(([l, d]) => {
                          const on = (cfg.notifyDays || []).includes(d);
                          return (
                            <button key={d} className="kp-f kp-tap"
                              onClick={() => set("notifyDays", on
                                ? cfg.notifyDays.filter(x => x !== d)
                                : [...(cfg.notifyDays || []), d])}
                              style={{ padding: "8px 12px", borderRadius: "var(--r-sm)", fontSize: "0.75rem",
                                cursor: "pointer", minHeight: 40,
                                border: `1px solid ${on ? c.good : c.line}`,
                                background: on ? c.good : "transparent",
                                color: on ? "#fff" : c.dim, fontWeight: on ? 600 : 500,
                                transition: "background .18s, color .18s" }}>
                              {l}
                            </button>
                          );
                        })}
                      </div>
                    </Row>
                    <div style={{ fontSize: "0.875rem", color: c.dim, marginTop: -12,
                      marginBottom: 24, lineHeight: 1.5 }}>
                      {whenPhrase(nextBriefing(cfg.notifyTime, cfg.notifyDays, now), now)}
                      {" "}A time that has already passed today waits until its next day.
                    </div>
                  </>
                )}
              </>
            )}

            <div style={{ ...S.eyebrow, margin: "26px 0 14px", color: c.good }}>Tax assumptions</div>
            <Row label={`Treasury bills and deposits · ${cfg.taxBill}%`}
              hint="Tax practices say 15%. One retail source claims bills are exempt for individuals - set what your own advice says." c={c}>
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
            <Row label="Show target bands" hint="The CBK inflation band, the 55% debt anchor." c={c}>
              <Toggle on={cfg.showBands} onChange={v => set("showBands", v)} c={c} />
            </Row>
            <Row label="Compact rows" hint="Hides sparklines, fits more on a screen." c={c}>
              <Toggle on={cfg.compact} onChange={v => set("compact", v)} c={c} />
            </Row>
            <Row label="Pinned to the top" hint="Choose up to four." c={c}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {inds.map(i => {
                  const on = cfg.pinned.includes(i.id);
                  return (
                    <button key={i.id} className="kp-f kp-tap"
                      onClick={() => set("pinned", on ? cfg.pinned.filter(x => x !== i.id)
                        : cfg.pinned.length < 4 ? [...cfg.pinned, i.id] : cfg.pinned)}
                      style={{ padding: "6px 11px", borderRadius: "var(--r-sm)", fontSize: "0.75rem", cursor: "pointer",
                        border: `1px solid ${on ? c.good : c.line}`,
                        background: on ? c.good : "transparent", color: on ? "#fff" : c.dim,
                        fontWeight: on ? 600 : 500, transition: "background .18s, color .18s" }}>
                      {i.label}
                    </button>
                  );
                })}
              </div>
            </Row>

            <div style={{ fontSize: "0.75rem", color: c.faint, marginTop: 20, lineHeight: 1.6 }}>
              Settings are stored on this device only, and no account is needed. The daily
              notification is the one exception: switching it on sends this device's
              notification address, your chosen time and days, and your timezone to the
              server that does the sending. Switching it off deletes them.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* A grouped section: the heading belongs to the space above the card, not
   inside it. That single change is most of what makes a list feel native. */
function Section({ title, note, children, c, i = 0, pad = 16, style }) {
  return (
    <div style={{ minWidth: 0, animation: `kp-rise .42s ${i * 0.05}s both var(--ease-emphasized)` }}>
      {title && (
        <div style={{ fontSize: "0.75rem", fontWeight: 600, letterSpacing: ".02em",
          color: c.dim, padding: "0 16px 7px", textTransform: "uppercase" }}>
          {title}
        </div>
      )}
      <div style={{ background: c.card, borderRadius: "var(--r-lg)", padding: pad,
        boxShadow: c.shadow, minWidth: 0, overflow: "hidden", ...style }}>
        {children}
      </div>
      {note && (
        <div style={{ fontSize: "0.75rem", color: c.faint, padding: "8px 16px 0",
          lineHeight: 1.45 }}>{note}</div>
      )}
    </div>
  );
}

/* ---------- settings helpers ---------- */
function Row({ label, hint, children, c }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontWeight: 500, marginBottom: hint ? 3 : 10, fontSize: "0.875rem",
        letterSpacing: "-.012em" }}>{label}</div>
      {hint && <div style={{ fontSize: "0.75rem", color: c.faint, marginBottom: 8,
        lineHeight: 1.45 }}>{hint}</div>}
      {children}
    </div>
  );
}
function Seg({ value, onChange, opts, c }) {
  return (
    <div style={{ display: "flex", background: c.seg, borderRadius: "var(--r-sm)", padding: 0 }}>
      {opts.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className="kp-f"
          style={{ flex: 1, padding: "8px 4px", border: "none", borderRadius: "var(--r-xs)", cursor: "pointer",
            background: value === v ? c.segOn : "transparent",
            color: value === v ? c.ink : c.dim, fontWeight: 600, fontSize: "0.875rem",
            boxShadow: value === v ? c.segShadow : "none",
            transition: "background .22s var(--ease-emphasized), color .2s" }}>{l}</button>
      ))}
    </div>
  );
}
function Toggle({ on, onChange, c }) {
  return (
    <button onClick={() => onChange(!on)} className="kp-f" aria-pressed={on} role="switch"
      style={{ width: 51, height: 44, borderRadius: "var(--r-full)", border: "none", cursor: "pointer",
        background: "transparent", position: "relative", flexShrink: 0, padding: 0,
        display: "grid", placeItems: "center",
        transition: "background .28s var(--ease-emphasized)" }}>
      <span style={{ width: 51, height: 31, borderRadius: "var(--r-full)", position: "relative",
        background: on ? c.good : c.chip,
        transition: "background .28s var(--ease-emphasized)" }}>
        <span style={{ position: "absolute", top: 2, left: 2, width: 27, height: 27,
          borderRadius: "var(--r-full)", background: "#fff",
          transform: on ? "translateX(20px)" : "none",
          transition: "transform .28s var(--ease-emphasized)",
          boxShadow: "var(--md-elevation-2)" }} />
      </span>
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
  /* Anything the collector publishes that the seed has never heard of is
     appended rather than dropped. Silently discarding a live indicator because
     nobody added it here is how a feed and an app drift apart. */
  const known = new Set(seed.indicators.map(i => i.id));
  const extra = feed.signals.filter(s => !known.has(s.id) && typeof s.value === "number")
    .map(s => ({ id: s.id, label: s.label, group: s.group || "Other", unit: s.unit || "",
      dir: s.dir ?? 0, value: s.value, prior: s.prior ?? s.value, priorLabel: "last reading",
      asOf: feed.asOf, src: s.source || "feed",
      hist: Array.isArray(s.hist) && s.hist.length > 2 ? s.hist : [s.value],
      note: "Added by the feed." }));

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
  return { ...seed, indicators: [...indicators, ...extra],
    asOf: feed.asOf || seed.asOf, source: "live",
    ladder: Array.isArray(feed.ladder) && feed.ladder.length ? feed.ladder : seed.ladder,
    chain: Array.isArray(feed.chain) && feed.chain.length ? feed.chain : seed.chain,
    breaks: Array.isArray(feed.breaks) && feed.breaks.length ? feed.breaks : seed.breaks,
    call: feed.call || seed.call,
    disagreements: Array.isArray(feed.disagreements) && feed.disagreements.length
      ? feed.disagreements.map(d => ({ ...d, why: d.why || "Sources report different vintages." }))
      : seed.disagreements };
}

/* ---------- briefing ---------- */
/* Five lines an executive can read in ten seconds. The narrative call sits
   above this in the Briefing card; the copy button carries both. */
function buildBrief(inds, ladder, breaks, asOf) {
  const g = Object.fromEntries(inds.map(i => [i.id, i]));
  const f = id => g[id] ? `${g[id].value}${g[id].unit}` : "-";
  const best = ladder[0], worst = ladder[ladder.length - 1];
  const off = breaks.filter(b => b.state !== "normal");
  const L = [`KENYA PULSE - ${asOf}`,
    `Policy ${f("cbr")} · Inflation ${f("inflation")} · KES/USD ${f("kes_usd")}`,
    `Best after tax and inflation: ${best.label} ${best.real > 0 ? "+" : ""}${best.real.toFixed(2)}% · ${worst.label} ${worst.real.toFixed(2)}%`,
    `Debt ${f("debt_gdp")} of GDP · Debt service ${f("debtserv")} of revenue`];
  if (off.length) {
    L.push(`Off range: ${off.map(b => `${b.name} ${b.value}${b.unit}`).join(" · ")}`);
  }
  return L.join("\n");
}
