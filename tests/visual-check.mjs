import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
const DIST = resolve('../app/dist'), PORT = 4321, ORIGIN = `http://localhost:${PORT}`;
const T = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml',
  '.woff2':'font/woff2','.woff':'font/woff' };
const server = createServer(async (req,res)=>{const path=(req.url||'/').split('?')[0];
  const name = path==='/'?'index.html':path;
  try{const f=await readFile(join(DIST,name));
    res.writeHead(200,{'content-type':T[extname(name)]||'application/octet-stream','cache-control':'no-store'});res.end(f);}
  catch{res.writeHead(404).end('no');}});
await new Promise(r=>server.listen(PORT,r));
async function launch(){try{return await chromium.launch();}catch(e){
  const root='/opt/pw-browsers';const dirs=(await readdir(root)).filter(d=>/^chromium-\d+$/.test(d));
  return await chromium.launch({executablePath:join(root,dirs.pop(),'chrome-linux','chrome')});}}
const b = await launch();
let pass=0,fail=0; const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`))};

for (const mode of ['light','dark']) {
  const ctx = await b.newContext({ colorScheme: mode, viewport:{width:412,height:915} });
  const page = await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
  await page.goto(ORIGIN,{waitUntil:'load'});
  await page.waitForTimeout(1200);
  const m = await page.evaluate(()=>{
    const cs=getComputedStyle(document.body), root=getComputedStyle(document.documentElement);
    const hero=[...document.querySelectorAll('span')].find(e=>/%$/.test(e.textContent||'')&&e.textContent.length<10);
    return { bg: cs.backgroundColor, fg: cs.color, family: cs.fontFamily,
      dark: document.documentElement.classList.contains('dark'),
      scale: document.documentElement.dataset.fontScale,
      rootFont: root.fontSize,
      primary: root.getPropertyValue('--md-primary').trim(),
      heroFamily: hero?getComputedStyle(hero).fontFamily:'',
      heroSize: hero?getComputedStyle(hero).fontSize:'',
      text: document.body.innerText.length,
      overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  console.log(`── ${mode.toUpperCase()}`);
  ok('page renders text', m.text>1500, String(m.text));
  ok('no runtime errors', errs.length===0, errs.join('|'));
  ok('dark class matches scheme', m.dark===(mode==='dark'), JSON.stringify({d:m.dark}));
  ok('background is a real colour', /^rgb/.test(m.bg)&&m.bg!=='rgba(0, 0, 0, 0)', m.bg);
  ok('foreground differs from background', m.fg!==m.bg, `${m.fg} on ${m.bg}`);
  ok('body is Inter', /Inter/.test(m.family), m.family);
  ok('hero number is the mono face', /Courier/.test(m.heroFamily), m.heroFamily);
  ok('primary token resolves', m.primary.length>0, m.primary);
  ok('no horizontal overflow', !m.overflow);
  await page.screenshot({path:`/tmp/kp-${mode}.png`, fullPage:false});
  await ctx.close();
}

// design.md 12.2: test every screen at xlarge before shipping
const ctx = await b.newContext({viewport:{width:412,height:915}});
const page = await ctx.newPage();
await page.addInitScript(()=>localStorage.setItem('ui.fontScale','xlarge'));
await page.goto(ORIGIN,{waitUntil:'load'}); await page.waitForTimeout(1200);
const x = await page.evaluate(()=>({
  scale:document.documentElement.dataset.fontScale,
  rootFont:getComputedStyle(document.documentElement).fontSize,
  overflow:document.documentElement.scrollWidth>window.innerWidth,
  sw:document.documentElement.scrollWidth, iw:window.innerWidth }));
console.log('── XLARGE SCALE');
ok('scale applied from storage', x.scale==='xlarge', x.scale);
ok('root font grew', parseFloat(x.rootFont)>16, x.rootFont);
ok('no horizontal overflow at xlarge', !x.overflow, `${x.sw} vs ${x.iw}`);
await page.screenshot({path:'/tmp/kp-xlarge.png'});
await b.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
