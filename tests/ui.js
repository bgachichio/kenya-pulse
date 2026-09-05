// the app keeps a 30s clock interval; unref it so a finished suite exits
{const _si=setInterval;global.setInterval=(...a)=>{const t=_si(...a);t&&t.unref&&t.unref();return t;};}
const babel=require('@babel/core'),fs=require('fs');
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async t=>{global.__c=t}}}});
const DISK={}; let W=412, HASH='', DARK=false;
global.window={localStorage:{getItem:k=>k in DISK?DISK[k]:null,setItem:(k,v)=>{DISK[k]=String(v)},removeItem:k=>{delete DISK[k]}},
 matchMedia:()=>({get matches(){return DARK},addEventListener(){},removeEventListener(){}}),
 addEventListener(){},removeEventListener(){},get innerWidth(){return W},
 get location(){return {origin:'https://x.test',pathname:'/',get hash(){return HASH}}},
 history:{replaceState:(a,b,h)=>{HASH=h}}};
global.document = { documentElement: { classList: { toggle() {} }, dataset: {}, style: {} },createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
 body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});
fs.writeFileSync('ui.mjs.js',babel.transformSync(fs.readFileSync(require('path').resolve(__dirname, '../app/src/App.jsx'),'utf8'),
 {presets:[['@babel/preset-env',{targets:{node:'current'},modules:'commonjs'}],
  ['@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);
const React=require('react'),TR=require('react-test-renderer');
function walk(n,f){if(!n||typeof n!=='object')return;f(n);(n.children||[]).forEach(c=>walk(c,f));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}
let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};
const fresh=()=>{delete require.cache[require.resolve('./ui.mjs.js')];
  const A=require('./ui.mjs.js').default;let r;TR.act(()=>{r=TR.create(React.createElement(A))});return r;};
const B=r=>collect(r.toJSON(),'button');
const go=(r,n)=>TR.act(()=>B(r).find(b=>(b.children||[]).join('')===n).props.onClick());
const SRC=fs.readFileSync(require('path').resolve(__dirname, '../app/src/App.jsx'),'utf8');

let r=fresh();
console.log('── FOOTER');
let t=txt(r.toJSON());
ok('shows the signature', t.includes('Made with'));
ok('no method paragraph', !t.includes('scored against its own recent run'));
ok('no source list', !t.includes('CBK · NSE · KNBS'));
const link=collect(r.toJSON(),'a').find(a=>a.props.href==='https://gachichio.org/kenya-pulse');
ok('links to the site', !!link);
ok('opens safely', link && link.props.rel==='noopener noreferrer');

console.log('\n── GROUPED LIST STRUCTURE');
ok('no bordered cards remain', !/border: `1px solid \$\{c\.line\}`,\s*borderRadius: 16/.test(SRC));
ok('Card component removed', !SRC.includes('const Card = ('));
ok('Section component in use', (SRC.match(/<Section/g)||[]).length>=12,
   String((SRC.match(/<Section/g)||[]).length));
go(r,'Pulse');
const insets=[];walk(r.toJSON(),n=>{const st=n.props&&n.props.style;
  if(st&&st.height===1&&st.marginLeft===32)insets.push(1);});
ok(`${insets.length} inset separators`, insets.length>10, String(insets.length));
const chevrons=txt(r.toJSON()).split('›').length-1;
ok(`${chevrons} chevrons on rows`, chevrons>20, String(chevrons));

console.log('\n── TAP TARGETS');
const small=[];walk(r.toJSON(),n=>{const st=n.props&&n.props.style;
  if(n.type==='button'&&st&&st.minHeight&&st.minHeight<44)small.push(st.minHeight);});
ok('rows meet the 44px minimum', small.length===0, small.join(','));

console.log('\n── TYPOGRAPHY & PALETTE');
/* design.md v1.1. The component file carries no colour of its own: every
   value resolves to a role token declared in index.css. */
const CSS = fs.readFileSync(require('path').resolve(__dirname, '../app/src/index.css'), 'utf8');
ok('no hex value in the component', !/#[0-9A-Fa-f]{6}/.test(SRC),
   (SRC.match(/#[0-9A-Fa-f]{6}/g)||[]).slice(0,3).join(','));
ok('no raw rgba in the component', !/rgba\(/.test(SRC));
ok('colour comes from --md-* role tokens', (SRC.match(/var\(--md-/g)||[]).length > 10,
   String((SRC.match(/var\(--md-/g)||[]).length));
ok('UI face is Inter', /--font-ui: 'Inter Variable'/.test(CSS));
ok('narrative face is the mono', /--font-narrative: 'Courier Prime'/.test(CSS));
ok('brand green sits at tone 40', CSS.includes('--md-primary: #237352'));
ok('dark is a Material surface, not true black', /--md-surface: #0F1512/.test(CSS));
ok('separation is a token, not a hardcoded hairline',
   SRC.includes('background: c.line') && CSS.includes('--md-outline-variant'));

console.log('\n── MOTION');
ok('one easing token, not many copies', (SRC.match(/var\(--ease-emphasized\)/g)||[]).length>8,
   String((SRC.match(/cubic-bezier\(\.32,\.72,0,1\)/g)||[]).length));
ok('press state dims and scales', SRC.includes('transform:scale(.96);opacity:.7'));
ok('reduced motion still honoured', SRC.includes('prefers-reduced-motion'));

console.log('\n── TEXT REDUCTION');
go(r,'Edge'); const edge=txt(r.toJSON());
ok('ladder blurb trimmed', !edge.includes('Nominal yield is the energy'));
ok('breaks blurb trimmed', !edge.includes('both are worth knowing early'));
ok('cost of standing still kept', edge.includes('price of standing still'));
ok('not-advice note kept', edge.includes('not advice'));
ok('provenance note kept', edge.includes('measured range is computed'));

console.log('\n── SETTINGS SHEET');
TR.act(()=>B(r).find(b=>b.props['aria-label']==='Settings').props.onClick());
t=txt(r.toJSON());
ok('sheet opens', t.includes('Settings'));
ok('grab handle present', SRC.includes('width: 36, height: 5, borderRadius: 4'));
const sw=B(r).filter(b=>b.props.role==='switch');
ok(`${sw.length} iOS switches`, sw.length>=3);
ok('switch is 51x31', SRC.includes('width: 51, height: 31'));

console.log('\n── NOTHING BROKE');
TR.act(()=>B(r).find(b=>b.props['aria-label']==='Close').props.onClick());
let allTabs=true;
for(const tb of ['Pulse','Edge','Trends','Outlook','Data']){
  try{go(r,tb); if(txt(r.toJSON()).length<1200)allTabs=false;}catch(e){allTabs=false;console.log('   ',tb,e.message.slice(0,60))}
}
ok('all five tabs render', allTabs);
DARK=true; let rd=fresh();
ok('dark mode renders', txt(rd.toJSON()).length>2000);
W=360; let rn=fresh();
ok('360px renders', txt(rn.toJSON()).length>2000);
W=412;
console.log('\n── GROSS BESIDE EVERY REAL RETURN');
/* The reported confusion: readers took the headline for the advertised rate
   and could not see that it was net of tax and inflation. Every place a real
   return appears must now show the gross beside it and name which is which. */
r=fresh();
let hero=txt(r.toJSON());
ok('the headline return is labelled real', /[+-][\d.]+%\s*real/.test(hero),
   (hero.match(/[+-][\d.]+%[^.]{0,20}/)||[''])[0]);
ok('and the gross rate sits with it', /[\d.]+% gross/.test(hero),
   (hero.match(/[\d.]+% gross[^.]{0,40}/)||[''])[0]);
ok('the hero names both deductions', /less [\d.]+% tax and [\d.]+% inflation/.test(hero),
   (hero.match(/less .{0,44}/)||[''])[0]);

go(r,'Edge');
const edgeTxt=txt(r.toJSON());
ok('the ladder explains gross before listing any',
   /advertised rate/.test(edgeTxt) && /Gross/.test(edgeTxt), edgeTxt.slice(0,80));
/* txt() gathers a node's own strings before descending, so the words inside
   <strong> arrive after the sentence they sit in. Assert the phrases, not the
   order they happen to be collected in. */
ok('and explains real as what survives tax and inflation',
   /withholding tax and [\d.]+% inflation/.test(edgeTxt)
   && /the part that actually buys anything/.test(edgeTxt)
   && /Real/.test(edgeTxt));
const rungs=edgeTxt.match(/[\d.]+% gross/g)||[];
ok('every rung shows a gross rate', rungs.length>=10, `${rungs.length} found`);
const reals=edgeTxt.match(/[+-][\d.]+% real/g)||[];
ok('and every rung labels its real one', reals.length>=10, `${reals.length} found`);
ok('the rungs no longer repeat gross in the small print',
   !/% gross · /.test(edgeTxt));
ok('the small print says what tax and inflation each cost',
   /% after tax · less [\d.]+% inflation/.test(edgeTxt));

console.log('\n── DESIGN.MD v1.1 TYPE AND SHAPE');
ok('no px font size anywhere', !/fontSize: *"[0-9.]+px"/.test(SRC),
   (SRC.match(/fontSize: *"[0-9.]+px"/g)||[]).join(','));
ok('no em font size anywhere', !/fontSize: *"[0-9.]+em"/.test(SRC));
ok('type is rem, so the scale toggle moves it', (SRC.match(/fontSize: *"[0-9.]+rem"/g)||[]).length > 40);
ok('weights stay 400/500/600', !/fontWeight: *[7-9][0-9]{2}/.test(SRC));
ok('cards take the 20px shape token', SRC.includes('var(--r-lg)') && CSS.includes('--r-lg: 20px'));
ok('sheet takes the 28px token', SRC.includes('var(--r-xl)') && CSS.includes('--r-xl: 28px'));
ok('four font-size steps', ['compact','default','large','xlarge']
   .every((n,i,a)=>SRC.includes(`"${n}"`) && (i===0||SRC.indexOf(`"${n}"`)>SRC.indexOf(`"${a[i-1]}"`))));
ok('no em dash in interface copy',
   !SRC.split('\n').filter(l=>!/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n').includes('\u2014'));

console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);

