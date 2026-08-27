/* The app's side of the daily notification.
 *
 * What the device hands the server, what it refuses to do, and what it says on
 * the platforms that cannot receive a push at all.
 *
 * Run:  node notify.js
 */
const babel = require('@babel/core'), fs = require('fs'), path = require('path');

const SRC = process.env.KP_APP || path.resolve(__dirname, '../app/src/App.jsx');
const DISK = {};
let PERM = 'default', SUBSCRIBED = null, CALLS = [], UNSUB = 0, IOS = false, STANDALONE = false;

global.window = {
  localStorage: { getItem: k => k in DISK ? DISK[k] : null, setItem: (k, v) => { DISK[k] = String(v); }, removeItem: k => { delete DISK[k]; } },
  matchMedia: () => ({ matches: STANDALONE, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {}, innerWidth: 412,
  location: { origin: 'https://kenyapulse.gachichio.org', pathname: '/', hash: '' },
  history: { replaceState() {} },
  get navigator() { return globalThis.navigator; },
};
/* `"PushManager" in window` asks whether the property exists, not what it
   holds — an iPhone in a Safari tab genuinely does not have it, so the mock
   has to remove it rather than set it undefined. */
function setPushSupport(on) {
  if (on) window.PushManager = function PushManager() {};
  else delete window.PushManager;
}
setPushSupport(true);

function resetPush() {
  SUBSCRIBED = null; CALLS = []; UNSUB = 0;
}

const registration = {
  pushManager: {
    getSubscription: async () => SUBSCRIBED,
    subscribe: async (opts) => {
      SUBSCRIBED = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/TESTDEVICE',
        options: opts,
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/TESTDEVICE', keys: { p256dh: 'p', auth: 'a' } }),
        unsubscribe: async () => { UNSUB++; return true; },
      };
      return SUBSCRIBED;
    },
  },
};

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: { writeText: async () => {} },
    get userAgent() { return IOS ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari' : 'Mozilla/5.0 (Linux; Android 14) Chrome'; },
    get standalone() { return IOS ? STANDALONE : undefined; },
    serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => registration },
  },
});

class N {
  static get permission() { return PERM; }
  static requestPermission = async () => PERM === 'default' ? (PERM = 'granted') : PERM;
}
global.Notification = N;

global.document = { title: '', createElement: () => ({ style: {}, select() {}, remove() {}, appendChild() {} }),
  body: { appendChild() {}, removeChild() {} }, execCommand: () => true };

global.fetch = async (url, init) => {
  const u = String(url);
  CALLS.push({ url: u, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });
  if (u.endsWith('/push/key')) return { ok: true, status: 200, json: async () => ({ key: 'BNDIYVuTpnD3ht9Dn0WOi9cuRgXWrAnjmtjXOs3DhVsLuz2EgVT9EQP8Pc2CEC5t2N2Yg9uRGfMaT5JJUlRIfxw' }) };
  return { ok: true, status: 200, json: async () => ({ ok: true, asOf: '2026-08-24', signals: [] }) };
};

fs.writeFileSync('notify.compiled.js', babel.transformSync(fs.readFileSync(SRC, 'utf8'), {
  presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
    ['@babel/preset-react', { runtime: 'classic' }]], filename: 'k.jsx' }).code);

const React = require('react'), TR = require('react-test-renderer');
function walk(n, f) { if (!n || typeof n !== 'object') return; f(n); (n.children || []).forEach(c => walk(c, f)); }
function txt(n) { let s = ''; walk(n, x => (x.children || []).forEach(c => { if (typeof c === 'string') s += c; })); return s; }
function collect(r, t) { const o = []; walk(r.toJSON(), n => { if (n.type === t) o.push(n); }); return o; }
const B = r => collect(r, 'button');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

async function mount() {
  let r;
  await TR.act(async () => { r = TR.create(React.createElement(require('./notify.compiled.js').default)); });
  await TR.act(async () => { await wait(300); });
  return r;
}
const openSettings = async (r) => {
  await TR.act(async () => { B(r).find(b => b.props['aria-label'] === 'Settings').props.onClick(); });
};
const toggleNotify = async (r) => {
  const sw = B(r).filter(b => b.props.role === 'switch');
  await TR.act(async () => { await sw[1].props.onClick(); });   // 0 = sync on open
  await TR.act(async () => { await wait(420); });
};

(async () => {
  console.log('── SWITCHING IT ON REGISTERS WITH THE SERVER');
  resetPush(); PERM = 'default';
  let r = await mount();
  await openSettings(r);
  ok('the control is offered', txt(r.toJSON()).includes('Daily briefing'));
  await toggleNotify(r);

  ok('permission was asked for', PERM === 'granted');
  ok('the server key was fetched', CALLS.some(c => c.url.endsWith('/push/key')));
  ok('the browser minted a subscription', !!SUBSCRIBED);
  ok('it is a user-visible subscription', SUBSCRIBED.options.userVisibleOnly === true);
  const sub = CALLS.find(c => c.url.endsWith('/push/subscribe'));
  ok('the subscription reached the server', !!sub, JSON.stringify(CALLS.map(c => c.url)));
  ok('with the endpoint the browser minted',
    sub && sub.body.subscription.endpoint.includes('TESTDEVICE'));
  ok('with the chosen time', sub && sub.body.time === '08:00', sub && sub.body.time);
  ok('with the chosen days', sub && JSON.stringify(sub.body.days) === '[1,2,3,4,5]', sub && JSON.stringify(sub.body.days));
  ok('and the device timezone, so the server knows when morning is',
    sub && typeof sub.body.tz === 'string' && sub.body.tz.length > 2, sub && sub.body.tz);
  ok('the setting is remembered on the device', JSON.parse(DISK['kp.cfg']).notifyOn === true);
  ok('the screen confirms it arrives when closed',
    /open or not|whether the app is open/i.test(txt(r.toJSON())), '');

  console.log('\n── CHANGING THE TIME RE-REGISTERS, ONCE');
  CALLS.length = 0;
  const timeInput = collect(r, 'input').find(i => i.props.type === 'time');
  ok('a time control is shown', !!timeInput);
  await TR.act(async () => { timeInput.props.onChange({ target: { value: '06:45' } }); });
  await TR.act(async () => { await wait(1400); });
  const resubs = CALLS.filter(c => c.url.endsWith('/push/subscribe'));
  ok('the new time reached the server', resubs.length === 1 && resubs[0].body.time === '06:45',
    JSON.stringify(resubs.map(c => c.body && c.body.time)));
  ok('the key was not fetched again', !CALLS.some(c => c.url.endsWith('/push/key')));
  ok('the device did not mint a second subscription',
    resubs[0] && resubs[0].body.subscription.endpoint === sub.body.subscription.endpoint,
    `${sub.body.subscription.endpoint} vs ${resubs[0] && resubs[0].body.subscription.endpoint}`);
  ok('so the server sees one device, rescheduled — not two',
    SUBSCRIBED.endpoint === 'https://fcm.googleapis.com/fcm/send/TESTDEVICE');

  console.log('\n── CHANGING THE DAYS RE-REGISTERS');
  CALLS.length = 0;
  await TR.act(async () => { B(r).find(b => txt(b).trim() === 'Sat').props.onClick(); });
  await TR.act(async () => { await wait(1400); });
  const dayPost = CALLS.find(c => c.url.endsWith('/push/subscribe'));
  ok('Saturday was added server-side', dayPost && dayPost.body.days.includes(6),
    dayPost && JSON.stringify(dayPost.body.days));

  console.log('\n── SWITCHING IT OFF CLEARS BOTH ENDS');
  CALLS.length = 0;
  await toggleNotify(r);
  await TR.act(async () => { await wait(200); });
  ok('the server was told to stop', CALLS.some(c => c.url.endsWith('/push/unsubscribe')),
    JSON.stringify(CALLS.map(c => c.url)));
  ok('naming the endpoint to drop',
    (CALLS.find(c => c.url.endsWith('/push/unsubscribe')) || {}).body.endpoint.includes('TESTDEVICE'));
  ok('the browser subscription was released', UNSUB === 1, String(UNSUB));
  ok('the setting is off on the device', JSON.parse(DISK['kp.cfg']).notifyOn === false);

  console.log('\n── A REFUSED PERMISSION LEAVES NOTHING BEHIND');
  resetPush(); PERM = 'denied'; delete DISK['kp.cfg'];
  r = await mount();
  await openSettings(r);
  await toggleNotify(r);
  ok('no subscription is attempted', !SUBSCRIBED);
  ok('nothing is sent to the server', !CALLS.some(c => c.url.includes('/push/')),
    JSON.stringify(CALLS.map(c => c.url)));
  ok('the setting stays off', JSON.parse(DISK['kp.cfg'] || '{}').notifyOn !== true);
  ok('and the block is explained', txt(r.toJSON()).includes('blocked for this site'));

  console.log('\n── A SERVER THAT CANNOT BE REACHED IS REPORTED, NOT SWALLOWED');
  resetPush(); PERM = 'granted'; delete DISK['kp.cfg'];
  const realFetch = global.fetch;
  global.fetch = async (u, i) => {
    if (String(u).includes('/push/')) throw new Error('offline');
    return realFetch(u, i);
  };
  r = await mount();
  await openSettings(r);
  await toggleNotify(r);
  await TR.act(async () => { await wait(200); });
  ok('the failure is on screen', /Could not schedule/i.test(txt(r.toJSON())), '');
  ok('the toggle does not claim success', JSON.parse(DISK['kp.cfg']).notifyOn === false);
  global.fetch = realFetch;

  console.log('\n── AN IPHONE IN A SAFARI TAB IS TOLD WHAT TO DO');
  resetPush(); PERM = 'default'; setPushSupport(false); IOS = true; STANDALONE = false; delete DISK['kp.cfg'];
  r = await mount();
  await openSettings(r);
  let t = txt(r.toJSON());
  ok('it asks for the home screen first', /Add to Home Screen/i.test(t), '');
  ok('and explains why', /installed app/i.test(t), '');
  ok('no dead toggle is offered', !t.includes('Daily briefing'));

  console.log('\n── A BROWSER THAT SIMPLY CANNOT IS TOLD PLAINLY');
  setPushSupport(false); IOS = false; delete DISK['kp.cfg'];
  r = await mount();
  await openSettings(r);
  t = txt(r.toJSON());
  ok('it says so', /cannot receive notifications/i.test(t), '');
  ok('and names what can', /Chrome|Firefox/.test(t));
  setPushSupport(true);

  console.log('\n── THE OLD PAGE TIMER IS GONE');
  const src = fs.readFileSync(SRC, 'utf8');
  ok('no notification is raised by the page itself',
    !/new Notification\(/.test(src) && !/showNotification\(/.test(src),
    (src.match(/new Notification\(|showNotification\(/g) || []).join(','));
  ok('no daily bookkeeping left on the device', !src.includes('kp.notified'));
  ok('the worker owns it instead', fs.existsSync(__dirname + '/../app/src/sw.js'));

  console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
  process.exit(fail ? 1 : 0);
})();
