const babel=require('/home/claude/node_modules/@babel/core'),fs=require('fs');
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async t=>{global.__c=t}}}});
const DISK={}; let W=412, HASH='', DARK=false;
global.window={localStorage:{getItem:k=>k in DISK?DISK[k]:null,setItem:(k,v)=>{DISK[k]=String(v)},removeItem:k=>{delete DISK[k]}},
 matchMedia:()=>({get matches(){return DARK},addEventListener(){},removeEventListener(){}}),
 addEventListener(){},removeEventListener(){},get innerWidth(){return W},
 get location(){return {origin:'https://x.test',pathname:'/',get hash(){return HASH}}},
 history:{replaceState:(a,b,h)=>{HASH=h}}};
global.document={createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
 body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});
fs.writeFileSync('ui.mjs.js',babel.transformSync(fs.readFileSync('/mnt/user-data/outputs/KenyaPulse.jsx','utf8'),
 {presets:[['/home/claude/node_modules/@babel/preset-env',{targets:{node:'current'}}],
  ['/home/claude/node_modules/@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);
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
const SRC=fs.readFileSync('/mnt/user-data/outputs/KenyaPulse.jsx','utf8');

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
  if(st&&st.height===1&&st.marginLeft===35)insets.push(1);});
ok(`${insets.length} inset separators`, insets.length>10, String(insets.length));
const chevrons=txt(r.toJSON()).split('›').length-1;
ok(`${chevrons} chevrons on rows`, chevrons>20, String(chevrons));

console.log('\n── TAP TARGETS');
const small=[];walk(r.toJSON(),n=>{const st=n.props&&n.props.style;
  if(n.type==='button'&&st&&st.minHeight&&st.minHeight<44)small.push(st.minHeight);});
ok('rows meet the 44px minimum', small.length===0, small.join(','));

console.log('\n── TYPOGRAPHY & PALETTE');
ok('SF stack leads', /fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text'/.test(SRC));
ok('negative tracking on body', SRC.includes('letterSpacing: "-.011em"'));
ok('grouped background', SRC.includes('bg: "#F2F2F7"'));
ok('dark uses true black', SRC.includes('bg: "#000000"'));
ok('house green kept as tint', SRC.includes('#1E7A55')||SRC.includes('#237352'));
ok('hairline separators', SRC.includes('rgba(60,60,67,0.13)'));

console.log('\n── MOTION');
ok('Apple easing curve used', (SRC.match(/cubic-bezier\(\.32,\.72,0,1\)/g)||[]).length>8,
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
ok('grab handle present', SRC.includes('width: 36, height: 5, borderRadius: 5'));
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
console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
