/* Push, in a real browser.
 *
 * Chromium is the engine behind Chrome on Android, so what passes here is what
 * an Android phone runs. Safari cannot be driven from this machine — the iOS
 * checks are the ones listed in DEPLOY.md, done by hand on a device.
 *
 * Serves the production build, registers the worker, delivers a push through
 * the DevTools protocol exactly as a push service would, and reads back the
 * notification the worker raised.
 *
 * Run:  cd app && npm run build && cd ../tests && node push_browser.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

/* Playwright's own download normally wins. Where a machine ships Chromium at a
   fixed path instead (this project's build box does), fall back to it rather
   than pulling 150 MB. */
async function launch() {
  try { return await chromium.launch(); } catch (first) {
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    try {
      const dirs = (await readdir(root)).filter(d => /^chromium-\d+$/.test(d));
      if (!dirs.length) throw first;
      return await chromium.launch({ executablePath: join(root, dirs.pop(), 'chrome-linux', 'chrome') });
    } catch { throw first; }
  }
}

const DIST = resolve(process.argv[2] || '../app/dist');
const PORT = 4319;
const ORIGIN = `http://localhost:${PORT}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml' };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

const server = createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  /* Type off the resolved file, not the request path: "/" has no extension
     and octet-stream makes the browser download the app instead of run it. */
  const name = path === '/' ? 'index.html' : path;
  try {
    const file = await readFile(join(DIST, name));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream',
      'cache-control': 'no-store' });
    res.end(file);
  } catch { res.writeHead(404).end('no'); }
});

await new Promise(r => server.listen(PORT, r));

const browser = await launch();
const ctx = await browser.newContext({ permissions: ['notifications'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

const cdp = await ctx.newCDPSession(page);
let registrationId = null;
await cdp.send('ServiceWorker.enable');
cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
  for (const r of registrations) {
    if (r.scopeURL.startsWith(ORIGIN) && !r.isDeleted) registrationId = r.registrationId;
  }
});

console.log('── THE WORKER REGISTERS');
await page.goto(ORIGIN, { waitUntil: 'load' });
const active = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  /* ready resolves as soon as there is an active worker, which can still be
     mid-activation for a tick. */
  for (let i = 0; i < 50 && reg.active && reg.active.state !== 'activated'; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  return { scope: reg.scope, state: reg.active && reg.active.state };
});
ok('service worker is active', active.state === 'activated', JSON.stringify(active));
ok('scoped to the whole app', active.scope === ORIGIN + '/', active.scope);
ok('the page itself threw nothing', errors.length === 0, errors.join(' | '));
ok('DevTools sees the registration', !!registrationId, String(registrationId));

console.log('\n── A PUSH ARRIVES (the page is not doing the work)');
const payload = JSON.stringify({
  title: 'Kenya Pulse',
  body: 'CBR 8.75% · Inflation 6.49%\nBest real return: Infrastructure bond +5.28%',
  url: '/#edge',
});
await cdp.send('ServiceWorker.deliverPushMessage', { origin: ORIGIN, registrationId, data: payload });

const shown = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  for (let i = 0; i < 40; i++) {
    const ns = await reg.getNotifications();
    if (ns.length) return ns.map(n => ({ title: n.title, body: n.body, tag: n.tag, data: n.data, icon: n.icon }));
    await new Promise(r => setTimeout(r, 100));
  }
  return [];
});
ok('the worker raised a notification', shown.length === 1, JSON.stringify(shown));
ok('titled Kenya Pulse', shown[0] && shown[0].title === 'Kenya Pulse');
ok('carries the briefing body', shown[0] && shown[0].body.includes('Best real return'));
ok('tagged so it replaces yesterday\'s', shown[0] && shown[0].tag === 'kp-daily');
ok('carries the deep link a tap will follow', shown[0] && shown[0].data && shown[0].data.url === '/#edge',
  JSON.stringify(shown[0] && shown[0].data));
ok('carries the app icon', shown[0] && shown[0].icon.endsWith('/icon-192.png'), shown[0] && shown[0].icon);

console.log('\n── A MALFORMED PUSH STILL SHOWS SOMETHING');
await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  (await reg.getNotifications()).forEach(n => n.close());
});
await cdp.send('ServiceWorker.deliverPushMessage', { origin: ORIGIN, registrationId, data: 'not json' });
const fallback = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  for (let i = 0; i < 40; i++) {
    const ns = await reg.getNotifications();
    if (ns.length) return { title: ns[0].title, body: ns[0].body };
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
});
/* userVisibleOnly is a promise to the browser: a push that shows nothing costs
   the site its permission. */
ok('rubbish payload still raises a notification', !!fallback, JSON.stringify(fallback));
ok('falls back to a sensible line', fallback && fallback.body.length > 0, JSON.stringify(fallback));

console.log('\n── THE APP STILL WORKS OFFLINE');
await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  (await reg.getNotifications()).forEach(n => n.close());
});
await ctx.setOffline(true);
await page.reload({ waitUntil: 'load' });
const offlineText = await page.evaluate(() => document.body.innerText.slice(0, 400));
ok('the app renders with the network down', offlineText.includes('Kenya Pulse'), offlineText.slice(0, 80));
ok('the tabs are there', /Pulse|Edge|Trends/.test(offlineText));
await ctx.setOffline(false);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
