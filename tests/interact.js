/* Interaction model: does a tap do something, and does a click do something.

   The bug this suite exists for: iOS Safari answers one tap with a synthetic
   mouseover *and* a click. A control that sets state on hover and toggles it
   on click therefore selects on the mouseover and immediately deselects on
   the click, and reads as completely dead to the person tapping it.

   None of this needs WebKit to test. The sequence WebKit emits is documented
   and deterministic, so it is replayed here against the real component. What
   this cannot prove is that Safari emits that sequence - that is the device
   check in DEPLOY.md. */

// the app keeps a 30s clock interval; unref it so a finished suite exits
{const _si=setInterval;global.setInterval=(...a)=>{const t=_si(...a);t&&t.unref&&t.unref();return t;};}
const babel=require('@babel/core'),fs=require('fs'),path=require('path');
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
const DISK={}; let W=412, HASH='', DARK=false;
global.window={localStorage:{getItem:k=>k in DISK?DISK[k]:null,setItem:(k,v)=>{DISK[k]=String(v)},removeItem:k=>{delete DISK[k]}},
 matchMedia:()=>({get matches(){return DARK},addEventListener(){},removeEventListener(){}}),
 addEventListener(){},removeEventListener(){},get innerWidth(){return W},
 get location(){return {origin:'https://x.test',pathname:'/',get hash(){return HASH}}},
 history:{replaceState:(a,b,h)=>{HASH=h}}};
global.document={documentElement:{classList:{toggle(){}},dataset:{},style:{}},
 createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
 body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});

const SRC=fs.readFileSync(path.resolve(__dirname,'../app/src/App.jsx'),'utf8');
fs.writeFileSync('interact.mjs.js',babel.transformSync(SRC,
 {presets:[['@babel/preset-env',{targets:{node:'current'},modules:'commonjs'}],
  ['@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);
const React=require('react'),TR=require('react-test-renderer');
function walk(n,f){if(!n||typeof n!=='object')return;f(n);(n.children||[]).forEach(c=>walk(c,f));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}
let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};
const fresh=()=>{delete require.cache[require.resolve('./interact.mjs.js')];
  const A=require('./interact.mjs.js').default;let r;TR.act(()=>{r=TR.create(React.createElement(A))});return r;};
const B=r=>collect(r.toJSON(),'button');
const go=(r,n)=>TR.act(()=>B(r).find(b=>(b.children||[]).join('')===n).props.onClick());

/* The bars carry an aria-label naming their year; that is how they are found. */
const bars=r=>B(r).filter(b=>/^\d{4},/.test(b.props['aria-label']||''));

/* Each event gets its own act(). That is the whole point: a browser commits a
   render between the mouseover and the click that follows it, so the click
   handler runs against the state the mouseover just set. Batching them into
   one act() would hide exactly the bug this suite is here to catch.

   The bar is looked up again before every event, because a commit replaces
   the node and a stale handle would call a stale closure. */
const at=(r,i)=>bars(r)[i];
const fire=(r,i,name,ev)=>{const h=at(r,i).props[name]; if(h) TR.act(()=>h(ev));};

/* One tap, as WebKit delivers it: the touch pointer events, then the
   compatibility mouse events it synthesises, then click. */
const tap=(r,i)=>{
  fire(r,i,'onPointerEnter',{pointerType:'touch'});
  fire(r,i,'onPointerDown',{pointerType:'touch'});
  fire(r,i,'onPointerUp',{pointerType:'touch'});
  fire(r,i,'onMouseEnter',{});          // the synthetic one WebKit adds
  fire(r,i,'onClick',{});
};
/* A mouse, as any desktop browser delivers it. */
const mouseOver=(r,i)=>{
  fire(r,i,'onPointerEnter',{pointerType:'mouse'});
  fire(r,i,'onMouseEnter',{});
};
const mouseOut=(r,i)=>{
  fire(r,i,'onPointerLeave',{pointerType:'mouse'});
  fire(r,i,'onMouseLeave',{});
};

let r=fresh();
go(r,'Trends');

console.log('── TRENDS BARS ARE REACHABLE');
let bs=bars(r);
ok('every bar is a real button', bs.length>0 && bs.length>=20, `found ${bs.length}`);
ok('each bar names its year and value to a screen reader',
   bs.every(b=>/^\d{4}, /.test(b.props['aria-label'])));
ok('bars take the tap without a 300ms wait',
   bs.every(b=>b.props.style && b.props.style.touchAction==='manipulation'));
ok('bars do not look like buttons',
   bs.every(b=>b.props.style.border==='none' && b.props.style.background==='transparent'));

console.log('\n── A TAP SELECTS, AND STAYS SELECTED');
r=fresh(); go(r,'Trends');
const before=txt(r.toJSON()).includes('tap a bar');
ok('nothing is selected to begin with', before);
tap(r,3);
let after=txt(r.toJSON());
ok('the tap selected a bar', !after.includes('tap a bar'));
const yr=bars(r)[3].props['aria-label'].slice(0,4);
ok('it selected the bar that was tapped', after.includes(yr), `wanted ${yr}`);
ok('the bar reports itself pressed', bars(r)[3].props['aria-pressed']===true);

console.log('\n── THE REGRESSION THIS SUITE EXISTS FOR');
/* Replay the whole iOS sequence a second time on a *different* bar. Under the
   old hover-toggle this left nothing selected at all. */
tap(r,7);
after=txt(r.toJSON());
ok('tapping a second bar moves the selection, it does not clear it',
   !after.includes('tap a bar'));
ok('the selection followed the second tap',
   after.includes(bars(r)[7].props['aria-label'].slice(0,4)));
tap(r,7);
ok('tapping the selected bar again clears it', txt(r.toJSON()).includes('tap a bar'));

console.log('\n── A MOUSE STILL HOVERS');
r=fresh(); go(r,'Trends');
mouseOver(r,5);
ok('hovering shows the value', !txt(r.toJSON()).includes('tap a bar'));
mouseOut(r,5);
ok('leaving clears it', txt(r.toJSON()).includes('tap a bar'));
mouseOver(r,5);
fire(r,5,'onClick',{});
mouseOut(r,5);
ok('a click pins, so it survives the mouse leaving',
   !txt(r.toJSON()).includes('tap a bar'));

console.log('\n── A TOUCH MUST NOT BE TREATED AS A HOVER');
r=fresh(); go(r,'Trends');
fire(r,2,'onPointerEnter',{pointerType:'touch'});
ok('a touch pointer entering selects nothing on its own',
   txt(r.toJSON()).includes('tap a bar'));
fire(r,2,'onPointerEnter',{pointerType:'pen'});
ok('nor does a pen', txt(r.toJSON()).includes('tap a bar'));

console.log('\n── KEYBOARD, AND THE FOCUS A TAP LEAVES BEHIND');
/* A focus event carries its element. Only a *keyboard* focus matches
   :focus-visible; the focus a tap leaves on a button does not. The app has to
   tell them apart, because treating a tap's focus as a hover kept the bar
   selected after the tap that was meant to clear it. */
const kbdFocus = { target: { matches: sel => sel === ':focus-visible' } };
const tapFocus = { target: { matches: () => false } };

r=fresh(); go(r,'Trends');
fire(r,9,'onFocus',kbdFocus);
ok('a keyboard focus shows the value', !txt(r.toJSON()).includes('tap a bar'));
fire(r,9,'onBlur',{});
ok('blurring clears it', txt(r.toJSON()).includes('tap a bar'));

r=fresh(); go(r,'Trends');
fire(r,4,'onFocus',tapFocus);
ok('the focus a tap leaves behind selects nothing', txt(r.toJSON()).includes('tap a bar'));

/* and the whole sequence a real tap produces, focus included */
r=fresh(); go(r,'Trends');
const tapWithFocus=(r,i)=>{ tap(r,i); fire(r,i,'onFocus',tapFocus); };
tapWithFocus(r,11);
ok('a tap that also focuses still selects', !txt(r.toJSON()).includes('tap a bar'));
tapWithFocus(r,11);
ok('and tapping it again still clears it - the focus does not hold it on',
   txt(r.toJSON()).includes('tap a bar'));

/* an ancient Safari with no :focus-visible must not break the tap */
r=fresh(); go(r,'Trends');
const oldSafari = { target: { matches: () => { throw new SyntaxError('unsupported'); } } };
fire(r,6,'onFocus',oldSafari);
ok('a browser without :focus-visible selects nothing on focus',
   txt(r.toJSON()).includes('tap a bar'));
tap(r,6); fire(r,6,'onFocus',oldSafari);
ok('and the tap still works there', !txt(r.toJSON()).includes('tap a bar'));

console.log('\n── NOTHING CLICKABLE HIDES ON A BARE DIV');
/* The class of bug, not the instance. WebKit only guarantees a click on
   interactive elements; anything else needs pointer events. */
const jsx=SRC.replace(/\{\/\*[\s\S]*?\*\/\}/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
const offenders=[];
for(const m of jsx.matchAll(/<(div|span|li|tr|td|section|header|footer)\b([^>]*)>/g)){
  if(/\bonClick=/.test(m[2])) offenders.push(m[1]+' '+m[2].slice(0,60));
}
ok('no onClick on a non-interactive element', offenders.length===0, offenders.join(' | '));

console.log('\n── THE SETTINGS SHEET CLOSES');
r=fresh();
TR.act(()=>B(r).find(b=>b.props['aria-label']==='Settings'||/settings/i.test(b.props['aria-label']||'')).props.onClick());
ok('the sheet opens', txt(r.toJSON()).includes('Text size'));
const veil=(()=>{let f=null;walk(r.toJSON(),n=>{if(!f&&n.props&&n.props.className==='kp-veil')f=n});return f})();
ok('the veil is present', !!veil);
ok('the veil dismisses on pointer events, not click',
   !!veil && typeof veil.props.onPointerUp==='function' && veil.props.onClick===undefined);
ok('the veil is not itself the dialog', !!veil && veil.props.role===undefined);
const sheet=(()=>{let f=null;walk(r.toJSON(),n=>{if(!f&&n.props&&n.props.role==='dialog')f=n});return f})();
ok('the sheet is the dialog', !!sheet && sheet.props['aria-modal']==='true');
/* a press that starts and ends on the veil closes it */
TR.act(()=>{const t={};veil.props.onPointerDown({target:t,currentTarget:t});
            veil.props.onPointerUp({target:t,currentTarget:t});});
ok('a press on the veil closes the sheet', !txt(r.toJSON()).includes('Text size'));
/* a press that starts inside the sheet and ends on the veil does not */
r=fresh();
TR.act(()=>B(r).find(b=>/settings/i.test(b.props['aria-label']||'')).props.onClick());
const veil2=(()=>{let f=null;walk(r.toJSON(),n=>{if(!f&&n.props&&n.props.className==='kp-veil')f=n});return f})();
TR.act(()=>{const v={},inner={};veil2.props.onPointerDown({target:inner,currentTarget:v});
            veil2.props.onPointerUp({target:v,currentTarget:v});});
ok('a drag out of the sheet does not close it', txt(r.toJSON()).includes('Text size'));

console.log('\n── GETTING SET UP');
r=fresh();
TR.act(()=>B(r).find(b=>/settings/i.test(b.props['aria-label']||'')).props.onClick());
let sheetTxt=txt(r.toJSON());
ok('the sheet offers a way in', /Install this app, and set it up/.test(sheetTxt));
ok('it is closed to begin with, so settings are not buried',
   !/Add to Home Screen/.test(sheetTxt));
const howBtn=B(r).find(b=>/Install this app/.test(txt(b)));
ok('and it is a real button with a state', !!howBtn && howBtn.props['aria-expanded']===false);
TR.act(()=>howBtn.props.onClick());
sheetTxt=txt(r.toJSON());
ok('opening it explains Safari', /Add to Home Screen/.test(sheetTxt));
ok('and Chrome on Android', /Install app/.test(sheetTxt));
ok('and a computer', /address bar/.test(sheetTxt));
ok('it warns that an iPhone browser other than Safari cannot do it',
   /Chrome and Firefox on an iPhone cannot install it/.test(sheetTxt));
ok('it covers turning the briefing on', /Turning on the daily briefing/.test(sheetTxt));
ok('it says a reinstall needs switching back on',
   /delete and reinstall/.test(sheetTxt));
ok('it covers the tax assumptions', /Setting your own assumptions/.test(sheetTxt));
ok('and says those stay on the device while the readings do not',
   /same for everyone and cannot be edited/.test(sheetTxt));
ok('every step is a numbered list, not a wall of text',
   collect(r.toJSON(),'ol').length>=4, String(collect(r.toJSON(),'ol').length));

console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
process.exit(fail?1:0);
