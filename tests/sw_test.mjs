/* The service worker's own logic, run as shipped.
 *
 * This loads app/dist/sw.js — the bundled artefact that goes to production,
 * not the source — inside a mocked worker global, and drives the events a
 * phone would raise. It covers the one path a browser cannot be told to
 * perform from a script: tapping the notification.
 *
 * Run:  cd app && npm run build && cd ../tests && node sw_test.mjs
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';

const SW = resolve(process.argv[2] || '../app/dist/sw.js');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

/* ---- a worker global, near enough for the handlers under test ---- */
function makeScope({ windows = [] } = {}) {
  const calls = { shown: [], opened: [], focused: [], navigated: [], closed: 0, posted: [], subscribed: [] };
  const handlers = {};
  const clients = {
    matchAll: async () => windows,
    openWindow: async (url) => { calls.opened.push(url); return { url }; },
    claim: async () => {},
  };
  const scope = {
    console,
    URL, Request, Response, Headers, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    location: new URL('https://kenyapulse.gachichio.org/sw.js'),
    caches: {
      open: async () => ({ match: async () => undefined, put: async () => {}, keys: async () => [] }),
      keys: async () => [], delete: async () => true, match: async () => undefined,
    },
    fetch: async (url, init) => { calls.posted.push({ url: String(url), init }); return new Response('{}', { status: 200 }); },
    indexedDB: { open: () => ({ addEventListener() {}, }) },
    importScripts: () => {},
  };
  scope.self = scope;
  scope.globalThis = scope;
  scope.addEventListener = (type, fn) => { (handlers[type] ||= []).push(fn); };
  scope.removeEventListener = () => {};
  scope.skipWaiting = async () => {};
  scope.registration = {
    scope: 'https://kenyapulse.gachichio.org/',
    showNotification: async (title, opts) => { calls.shown.push({ title, ...opts }); },
    pushManager: {
      getSubscription: async () => null,
      subscribe: async (opts) => {
        calls.subscribed.push(opts);
        return { endpoint: 'https://fcm.googleapis.com/fcm/send/NEW', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/NEW' }) };
      },
    },
  };
  scope.clients = clients;
  return { scope, handlers, calls };
}

function win(url, { navigable = true } = {}) {
  const w = { url, focused: false, navigatedTo: null, focus: async () => { w.focused = true; } };
  if (navigable) w.navigate = async (u) => { w.navigatedTo = u; return w; };
  return w;
}

async function fire(handlers, type, event) {
  const waits = [];
  event.waitUntil = (p) => waits.push(p);
  for (const fn of handlers[type] || []) await fn(event);
  await Promise.all(waits);
}

const source = await readFile(SW, 'utf8');
const script = new vm.Script(source, { filename: 'sw.js' });

function boot(opts) {
  const built = makeScope(opts);
  vm.createContext(built.scope);
  script.runInContext(built.scope);
  return built;
}

console.log('── THE WORKER LOADS AND CLAIMS ITS EVENTS');
{
  const { handlers } = boot();
  ok('registers a push handler', (handlers.push || []).length === 1);
  ok('registers a notificationclick handler', (handlers.notificationclick || []).length === 1);
  ok('registers a pushsubscriptionchange handler', (handlers.pushsubscriptionchange || []).length === 1);
  ok('still precaches (install handler present)', (handlers.install || []).length >= 1);
}

console.log('\n── TAPPING THE NOTIFICATION WITH THE APP ALREADY OPEN');
{
  const existing = win('https://kenyapulse.gachichio.org/#pulse');
  const { handlers, calls } = boot({ windows: [existing] });
  let closed = 0;
  await fire(handlers, 'notificationclick', {
    notification: { data: { url: '/#edge' }, close: () => { closed++; } },
  });
  ok('the notification is dismissed', closed === 1);
  ok('the open window is brought to the front', existing.focused === true);
  ok('and taken to the briefing', existing.navigatedTo === '/#edge', String(existing.navigatedTo));
  ok('no second window is opened', calls.opened.length === 0, JSON.stringify(calls.opened));
}

console.log('\n── TAPPING IT WITH THE APP CLOSED');
{
  const { handlers, calls } = boot({ windows: [] });
  await fire(handlers, 'notificationclick', {
    notification: { data: { url: '/#edge' }, close: () => {} },
  });
  ok('the app is opened', calls.opened.length === 1, JSON.stringify(calls.opened));
  ok('straight to the briefing', calls.opened[0] === '/#edge', String(calls.opened[0]));
}

console.log('\n── EDGE CASES OF THE TAP');
{
  const other = win('https://example.com/somewhere');
  const { handlers, calls } = boot({ windows: [other] });
  await fire(handlers, 'notificationclick', { notification: { data: { url: '/#edge' }, close: () => {} } });
  ok('a window on another site is not hijacked', other.focused === false);
  ok('a new window is opened instead', calls.opened.length === 1);
}
{
  const { handlers, calls } = boot({ windows: [] });
  await fire(handlers, 'notificationclick', { notification: { close: () => {} } });
  ok('a notification with no link still opens the app', calls.opened[0] === '/', String(calls.opened[0]));
}
{
  /* Some browsers expose no navigate(). Focus alone still counts as opening. */
  const old = win('https://kenyapulse.gachichio.org/#data', { navigable: false });
  const { handlers, calls } = boot({ windows: [old] });
  await fire(handlers, 'notificationclick', { notification: { data: { url: '/#edge' }, close: () => {} } });
  ok('a browser without navigate() still focuses the app', old.focused === true);
  ok('and does not throw or double-open', calls.opened.length === 0);
}

console.log('\n── WHAT THE PUSH SHOWS');
{
  const { handlers, calls } = boot();
  await fire(handlers, 'push', {
    data: { json: () => ({ title: 'Kenya Pulse', body: 'CBR 8.75%', url: '/#edge' }) },
  });
  ok('shows the title it was sent', calls.shown[0].title === 'Kenya Pulse');
  ok('shows the body it was sent', calls.shown[0].body === 'CBR 8.75%');
  ok('keeps the link for the tap', calls.shown[0].data.url === '/#edge');
  ok('replaces the previous day rather than stacking', calls.shown[0].tag === 'kp-daily');
}
{
  const { handlers, calls } = boot();
  await fire(handlers, 'push', { data: { json: () => { throw new Error('bad json'); } } });
  ok('an unreadable push still shows one notification', calls.shown.length === 1);
  ok('with a sensible fallback body', /readings/i.test(calls.shown[0].body), calls.shown[0].body);
}
{
  const { handlers, calls } = boot();
  await fire(handlers, 'push', { data: { json: () => ({ title: 'x', body: 'y', url: 'https://evil.test/steal' }) } });
  ok('an off-site link in the payload is refused', calls.shown[0].data.url === '/#edge',
    calls.shown[0].data.url);
}

console.log('\n── THE PUSH SERVICE ROTATES THE SUBSCRIPTION');
{
  const { handlers, calls } = boot();
  await fire(handlers, 'pushsubscriptionchange', {
    oldSubscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/OLD',
      options: { applicationServerKey: new Uint8Array([1, 2, 3]) },
    },
  });
  ok('resubscribes with the same server key', calls.subscribed.length === 1);
  ok('keeps userVisibleOnly', calls.subscribed[0].userVisibleOnly === true);
  const post = calls.posted.find(p => p.url.includes('/push/refresh'));
  ok('tells the server the new address', !!post, JSON.stringify(calls.posted.map(p => p.url)));
  ok('naming the old one so preferences carry over',
    post && JSON.parse(post.init.body).oldEndpoint.endsWith('/OLD'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
