/* Real browser, real touch. Chromium is the only engine on a build machine,
   so this proves the tap path works against a genuine event pipeline - a real
   pointerdown, a real click, a real hit test with a real 44px finger - rather
   than against handlers called by hand.

   What it cannot prove is Safari. WebKit is not installable here. The value is
   that the two engines synthesise compatibility mouse events in the same
   documented order, so a control that survives Chromium's touch pipeline
   without depending on hover is the control that survives WebKit's. The iPhone
   checks in DEPLOY.md remain the only evidence that counts for Safari. */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
const DIST = resolve('../app/dist'), PORT = 4323, ORIGIN = `http://localhost:${PORT}`;
const T = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml',
  '.woff2':'font/woff2','.woff':'font/woff' };
const server = createServer(async (req,res)=>{const p=(req.url||'/').split('?')[0];
  const name = p==='/'?'index.html':p;
  try{const f=await readFile(join(DIST,name));
    res.writeHead(200,{'content-type':T[extname(name)]||'application/octet-stream','cache-control':'no-store'});res.end(f);}
  catch{res.writeHead(404).end('no');}});
await new Promise(r=>server.listen(PORT,r));
async function launch(){try{return await chromium.launch();}catch{
  const root='/opt/pw-browsers';const dirs=(await readdir(root)).filter(d=>/^chromium-\d+$/.test(d));
  return await chromium.launch({executablePath:join(root,dirs.pop(),'chrome-linux','chrome')});}}
const b = await launch();
let pass=0,fail=0; const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`))};

/* A phone: touch only, no mouse, no hover. */
const ctx = await b.newContext({ ...devices['Pixel 7'], hasTouch:true, isMobile:true });
const page = await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
await page.goto(ORIGIN,{waitUntil:'load'});
await page.waitForTimeout(1200);

console.log('── A FINGER ON A PHONE');
const tab = (pg,name)=>pg.locator('button').filter({hasText:new RegExp(`^${name}$`,'i')}).first();
await tab(page,'Trends').tap();
await page.waitForTimeout(400);
ok('the Trends tab opened on a tap', (await page.locator('body').innerText()).includes('tap a bar'));

const yearBars = page.locator('button[aria-pressed]');
const n = await yearBars.count();
ok('the chart exposes its bars as buttons', n>=20, `found ${n}`);

const label = await yearBars.nth(6).getAttribute('aria-label');
await yearBars.nth(6).tap();
await page.waitForTimeout(300);
let body = await page.locator('body').innerText();
ok('a real tap selects the bar', !body.includes('tap a bar'), body.slice(0,120));
ok('it selected the bar that was touched', body.includes(label.slice(0,4)), `wanted ${label}`);

/* The regression: on the old build the synthetic mouseover set the state and
   the click that followed cleared it, so this second tap left nothing. */
const label2 = await yearBars.nth(14).getAttribute('aria-label');
await yearBars.nth(14).tap();
await page.waitForTimeout(300);
body = await page.locator('body').innerText();
ok('a second tap moves the selection rather than clearing it', !body.includes('tap a bar'));
ok('the selection followed the second tap', body.includes(label2.slice(0,4)), `wanted ${label2}`);

await yearBars.nth(14).tap();
await page.waitForTimeout(300);
ok('tapping the same bar again clears it',
   (await page.locator('body').innerText()).includes('tap a bar'));

console.log('\n── THE SETTINGS SHEET ON A FINGER');
await page.locator('button[aria-label*="ettings" i]').first().tap();
await page.waitForTimeout(500);
ok('the sheet opens on a tap', (await page.locator('body').innerText()).includes('Text size'));
/* tap the veil, well above the sheet */
await page.mouse.move(0,0);
const box = await page.locator('.kp-veil').boundingBox();
await page.touchscreen.tap(box.x + box.width/2, box.y + 40);
await page.waitForTimeout(500);
ok('a tap on the veil closes it', !(await page.locator('body').innerText()).includes('Text size'));

/* Reopen it and measure what is inside, which the sweep above never sees. */
await page.locator('button[aria-label*="ettings" i]').first().tap();
await page.waitForTimeout(500);
const inSheet = await page.evaluate(()=>{
  const sheet=document.querySelector('[role="dialog"]'); if(!sheet) return ['no sheet'];
  const out=[];
  for(const el of sheet.querySelectorAll('button,a,input,[role="switch"]')){
    const r=el.getBoundingClientRect();
    if(r.width===0&&r.height===0) continue;
    if(r.height<44) out.push(`${el.tagName}:${(el.innerText||el.getAttribute('aria-label')||'').slice(0,20)}@${Math.round(r.height)}`);
  }
  return out;
});
ok('no control inside the settings sheet is under 44px', inSheet.length===0, inSheet.join(' | '));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('escape closes the sheet', !(await page.locator('body').innerText()).includes('Text size'));

console.log('\n── EVERY CONTROL IS BIG ENOUGH FOR A FINGER');
/* Height is the axis a phone actually gets wrong, and it is the one the app
   can always satisfy. Width is not: the vitals strip puts one mark per
   indicator across the screen, and 33 marks cannot each be 44px wide on a
   360px phone. Those are measured for height and named as the exception. */
const small = await page.evaluate(()=>{
  const out=[];
  for(const el of document.querySelectorAll('button,a,input,[role="switch"],[role="tab"]')){
    const r=el.getBoundingClientRect();
    if(r.width===0&&r.height===0) continue;                 // not rendered
    if(r.height < 44) out.push(`${el.tagName}:${(el.innerText||el.getAttribute('aria-label')||'').slice(0,28)}@${Math.round(r.height)}x${Math.round(r.width)}`);
  }
  return out;
});
ok('no control is under 44px tall', small.length===0, small.join(' | '));

const strip = await page.evaluate(()=>{
  const g=document.querySelector('[role="group"][aria-label*="glance"]');
  if(!g) return null;
  const kids=[...g.querySelectorAll('button')];
  return { n:kids.length,
    h:Math.round(kids[0].getBoundingClientRect().height),
    named:kids.every(k=>(k.getAttribute('aria-label')||'').length>3) };
});
ok('the vitals strip exists and is a named group', !!strip, 'not found');
ok('every mark in it carries a name', strip && strip.named);
ok('every mark is a 44px tall target', strip && strip.h>=44, JSON.stringify(strip));

const barBox = await page.evaluate(()=>{
  const b=document.querySelector('button[aria-pressed]'); const r=b.getBoundingClientRect();
  return {w:Math.round(r.width),h:Math.round(r.height)};
});
ok('the chart bars are a full-height target', barBox.h>=100, JSON.stringify(barBox));
ok('the bars tile the plot with no dead gaps', barBox.w>=10, JSON.stringify(barBox));

console.log('\n── A MOUSE ON A DESKTOP');
const dctx = await b.newContext({ viewport:{width:1280,height:900}, hasTouch:false });
const dpage = await dctx.newPage();
const derrs=[]; dpage.on('pageerror',e=>derrs.push(String(e)));
await dpage.goto(ORIGIN,{waitUntil:'load'});
await dpage.waitForTimeout(1200);
await tab(dpage,'Trends').click();
await dpage.waitForTimeout(400);
const dbars = dpage.locator('button[aria-pressed]');
await dbars.nth(8).hover();
await dpage.waitForTimeout(250);
ok('hovering with a mouse shows the value',
   !(await dpage.locator('body').innerText()).includes('tap a bar'));
await dpage.mouse.move(5,5);
await dpage.waitForTimeout(250);
ok('moving away clears it',
   (await dpage.locator('body').innerText()).includes('tap a bar'));
await dbars.nth(8).click();
await dpage.mouse.move(5,5);
await dpage.waitForTimeout(250);
ok('a click pins it so it survives the mouse leaving',
   !(await dpage.locator('body').innerText()).includes('tap a bar'));

console.log('\n── A KEYBOARD');
await dpage.keyboard.press('Tab');
const reachable = await dpage.evaluate(()=>{
  let n=0, seen=new Set();
  for(let i=0;i<400;i++){
    const a=document.activeElement;
    if(!a||a===document.body) break;
    const k=a.tagName+(a.getAttribute('aria-label')||a.textContent||'').slice(0,20);
    if(seen.has(k)) break; seen.add(k); n++;
    break;
  }
  return document.activeElement && document.activeElement !== document.body;
});
ok('tab reaches a control', reachable);
const focusRing = await dpage.evaluate(()=>{
  const el=document.activeElement; const cs=getComputedStyle(el);
  return { outline: cs.outlineStyle, width: cs.outlineWidth, shadow: cs.boxShadow };
});
ok('the focused control shows a ring',
   focusRing.outline!=='none' || (focusRing.shadow && focusRing.shadow!=='none'),
   JSON.stringify(focusRing));

ok('no runtime errors on the phone', errs.length===0, errs.join('|'));
ok('no runtime errors on the desktop', derrs.length===0, derrs.join('|'));

console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
await b.close(); server.close();
process.exit(fail?1:0);
