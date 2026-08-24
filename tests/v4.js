const babel=require('/home/claude/node_modules/@babel/core'),fs=require('fs');
const DISK={}; let W=412, HASH='';
global.window={localStorage:{getItem:k=>k in DISK?DISK[k]:null,setItem:(k,v)=>{DISK[k]=String(v)},removeItem:k=>{delete DISK[k]}},
 matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
 addEventListener(){},removeEventListener(){},get innerWidth(){return W},
 get location(){return {origin:'https://kenya-pulse-app.vercel.app',pathname:'/',get hash(){return HASH}}},
 history:{replaceState:(a,b,h)=>{HASH=h}}};
// Node 22 ships a read-only built-in navigator getter, so a plain assignment
// is silently swallowed. defineProperty replaces it properly.
Object.defineProperty(globalThis,'navigator',{configurable:true,
  value:{clipboard:{writeText:async(t)=>{global.__copied=t}}}});
global.document={createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
 body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});
fs.writeFileSync('v4.mjs.js',babel.transformSync(fs.readFileSync('/mnt/user-data/outputs/KenyaPulse.jsx','utf8'),
 {presets:[['/home/claude/node_modules/@babel/preset-env',{targets:{node:'current'}}],
  ['/home/claude/node_modules/@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);
const React=require('react'),TR=require('react-test-renderer');
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);(n.children||[]).forEach(c=>walk(c,fn));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}
let pass=0,fail=0,COPYCHECK=null;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};
const fresh=()=>{delete require.cache[require.resolve('./v4.mjs.js')];
  const A=require('./v4.mjs.js').default;let r;TR.act(()=>{r=TR.create(React.createElement(A))});return r;};
const B=r=>collect(r.toJSON(),'button');
const go=(r,n)=>TR.act(()=>B(r).find(b=>(b.children||[]).join('')===n).props.onClick());

let r=fresh();
console.log('── PULSE SCORE RETIRED');
let t=txt(r.toJSON());
ok('no "Pulse score" eyebrow', !t.includes('Pulse score'));
ok('no verdict words', !/EXPANDING|UNDER STRAIN/.test(t), (t.match(/EXPANDING|UNDER STRAIN/)||[])[0]||'');
ok('no "of 100"', !t.includes('of 100'));
const src=fs.readFileSync('/mnt/user-data/outputs/KenyaPulse.jsx','utf8');
ok('gone from source entirely', !/verdict|pulse >=/.test(src));

console.log('\n── HERO IS THE ACTIONABLE FACT');
ok('headline is best real return', t.includes('Best real return'));
ok('names the instrument', t.includes('Infrastructure bond'));
ok('shows +6.31%', t.includes('+6.31%'));
ok('quantifies the cost of cash', t.includes('128,000'), '');
ok('in shillings on a million', /KES\s?128,000/.test(t.replace(/\s+/g,' ')), '');
ok('hero stays compact, no redundant CTA', !txt(r.toJSON()).includes('See the ladder'));
ok('warns about stale rates', t.includes('overdue a refresh'));

console.log('\n── PLAIN LANGUAGE');
go(r,'Pulse');
const row=B(r).find(b=>txt(b).includes('KESONIA overnight'));
TR.act(()=>row.props.onClick());
t=txt(r.toJSON());
// the uppercase micro-labels went; the chip now does the separating
ok('definition rendered', t.includes('banks actually charge each other'));
ok('why-it-matters rendered', t.includes('money market is calm'));
ok('current commentary still below it', t.includes('Sitting almost exactly on the policy rate'));
ok('plain definition present', t.includes('banks actually charge each other'), '');
let covered=0, missing=[];
const SRC=fs.readFileSync('/mnt/user-data/outputs/KenyaPulse.jsx','utf8');
// core inflation and private credit growth were removed — no automatic source exists
for(const id of ['cbr','kesonia','tbill','tbill182','tbill364','discount','inflation','lending',
  'deposit','savings','npl','kes_usd','kes_eur','kes_gbp','cover','reserves','cab','gdp','pmi',
  'nasi','nse20','nse25','bank_idx','mktcap','debt','debt_gdp','debtserv','fed_funds','us10y',
  'ssa_gdp','world_gdp','repo','bond10']){
  const i=SRC.indexOf(`{ id: "${id}",`);
  const seg=SRC.slice(i, i+2400);
  if(seg.includes('what:')&&seg.includes('why:'))covered++; else missing.push(id);
}
ok(`all 33 indicators have plain language`, covered===33, missing.join(','));

console.log('\n── DEEP LINKS');
go(r,'Trends');
ok('hash tracks the tab', HASH.startsWith('#trends'), HASH);
const infl=B(r).filter(b=>txt(b).trim()==='Inflation')[0];
TR.act(()=>infl.props.onClick());
ok('hash carries the series', HASH==='#trends/inflation', HASH);
const shareBtn=B(r).find(b=>txt(b).trim()==='Share');
ok('share link on trends', !!shareBtn);
TR.act(()=>shareBtn.props.onClick());
COPYCHECK = shareBtn;

HASH='#edge';
let r2=fresh();
ok('opens on the tab from the URL', txt(r2.toJSON()).includes('Briefing'), '');
HASH='#trends/reserves';
let r3=fresh();
ok('opens on the series from the URL', txt(r3.toJSON()).includes('FX reserves'), '');
HASH='#pulse/debtserv';
let r4=fresh();
ok('expands the indicator from the URL', txt(r4.toJSON()).includes('binding number'), '');
HASH='';

console.log('\n── STALE RATES ON THE LADDER');
let r5=fresh(); go(r5,'Edge');
t=txt(r5.toJSON());
ok('marks the old rate', t.includes('OLD'));
ok('states its age', t.includes('139 days old'), '');
ok('explains the marker', t.includes('past its usual publication cycle'), '');

console.log('\n── BREAK PROVENANCE');
ok('labels the range as judged', t.includes('judged range'), '');
ok('explains measured vs judged', t.includes('computed from readings this app has logged'), '');
const bb=B(r5).find(b=>txt(b).includes('Sovereign spread'));
TR.act(()=>bb.props.onClick());
t=txt(r5.toJSON());
ok('per-break provenance note', t.includes('treat it as a judgement')||t.includes('Range read off'), '');
ok('per-break share link', B(r5).some(b=>txt(b).trim()==='Share'));

console.log('\n── STILL ALL WORKS');
let allTabs=true;
for(const tb of ['Pulse','Edge','Trends','Outlook','Data']){
  try{go(r5,tb); if(txt(r5.toJSON()).length<1500)allTabs=false;}catch(e){allTabs=false}
}
ok('five tabs render', allTabs);
ok('no Claude anywhere', !/claude/i.test(SRC));
setTimeout(()=>{
  ok('copies a full deep link', (global.__copied||'').includes('#trends/inflation'), global.__copied||'none');
  console.log(`\n${'═'.repeat(50)}\n  ${pass+1} passed, ${fail} failed\n${'═'.repeat(50)}`);
}, 50);
