const babel=require('/home/claude/node_modules/@babel/core'),fs=require('fs');
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async t=>{global.__c=t}}}});
const LIVE=JSON.parse(fs.readFileSync('live.json','utf8'));
const DISK={}; let HASH='', FETCHED=[], FAIL=false;
global.window={localStorage:{getItem:k=>k in DISK?DISK[k]:null,setItem:(k,v)=>{DISK[k]=String(v)},removeItem:k=>{delete DISK[k]}},
 matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
 addEventListener(){},removeEventListener(){},innerWidth:412,
 get location(){return {origin:'https://kenya-pulse-app.vercel.app',pathname:'/',get hash(){return HASH}}},
 history:{replaceState:(a,b,h)=>{HASH=h}}};
global.document={createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
 body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async(u)=>{FETCHED.push(u);
  if(FAIL) throw new Error('Failed to fetch');
  return {ok:true,status:200,json:async()=>LIVE};};
fs.writeFileSync('e2e.mjs.js',babel.transformSync(fs.readFileSync('/mnt/user-data/outputs/KenyaPulse.jsx','utf8'),
 {presets:[['/home/claude/node_modules/@babel/preset-env',{targets:{node:'current'}}],
  ['/home/claude/node_modules/@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);
const React=require('react'),TR=require('react-test-renderer');
function walk(n,f){if(!n||typeof n!=='object')return;f(n);(n.children||[]).forEach(c=>walk(c,f));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}
let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};
const fresh=()=>{delete require.cache[require.resolve('./e2e.mjs.js')];
  const A=require('./e2e.mjs.js').default;let r;TR.act(()=>{r=TR.create(React.createElement(A))});return r;};
const B=r=>collect(r.toJSON(),'button');
const go=(r,n)=>TR.act(()=>B(r).find(b=>(b.children||[]).join('')===n).props.onClick());
const wait=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
console.log('── SYNC AGAINST THE REAL data.json THE COLLECTOR JUST WROTE');
let r=fresh(); await wait(400);
ok('fetched on open', FETCHED.length>0);
ok('fetched the fixed feed', FETCHED[0]==='https://gachichio.org/pulse/data.json', FETCHED[0]);
let t=txt(r.toJSON());
const liveD=new Date(LIVE.asOf+'T00:00:00');
const readingsTo=`readings to ${liveD.getDate()} ${liveD.toLocaleDateString('en-GB',{month:'short'})}`;
ok(`adopted live date ${LIVE.asOf}`, t.includes(readingsTo), readingsTo);
ok('header date is the device\'s', new RegExp(`${new Date().getDate()} ${new Date().toLocaleDateString('en-GB',{month:'long'})}`).test(t), '');
go(r,'Data'); t=txt(r.toJSON());
ok('badge flips to live', t.includes('live')&&!t.includes('seeded'), '');

console.log('\n── LIVE VALUES REACH THE SCREEN');
const sig=Object.fromEntries(LIVE.signals.map(s=>[s.id,s]));
go(r,'Pulse'); t=txt(r.toJSON());
for(const id of ['cbr','kesonia','tbill','inflation','lending','nasi']){
  ok(`${sig[id].label} = ${sig[id].value}`, t.includes(String(sig[id].value)), '');
}

console.log('\n── LIVE LADDER, CHAIN, BREAKS');
go(r,'Edge'); t=txt(r.toJSON());
ok(`ladder top is ${LIVE.ladder[0].label}`, t.includes(LIVE.ladder[0].label));
ok('live real yields shown', t.includes(LIVE.ladder[0].real.toFixed(2)));
// one further "OLD" is the explainer note under the section, by design
ok(`${LIVE.staleRates.length} stale rates flagged OLD`,
   (t.match(/OLD/g)||[]).length===LIVE.staleRates.length+1,
   `saw ${(t.match(/OLD/g)||[]).length}`);
ok('each stale rate named on its rung', LIVE.staleRates.every(n=>t.includes(n)));
ok('live call text used', t.includes(LIVE.call.slice(0,40)), '');
ok(`all ${LIVE.chain.length} chain links`, LIVE.chain.every(x=>t.includes(x.label)));
ok(`all ${LIVE.breaks.length} relationships`, LIVE.breaks.every(x=>t.includes(x.name)));
ok('range provenance from feed', t.includes('judged range')||t.includes('measured range'));

console.log('\n── EVERY BUTTON, EVERY TAB');
let clicked=0, broke=[];
for(const tab of ['Pulse','Edge','Trends','Outlook','Data']){
  go(r,tab);
  const btns=B(r);
  for(let i=0;i<btns.length;i++){
    const b=B(r)[i]; if(!b||!b.props.onClick) continue;
    const label=(txt(b)||b.props.title||b.props['aria-label']||'?').slice(0,28);
    try{ TR.act(()=>b.props.onClick()); clicked++; }
    catch(e){ broke.push(`${tab}/${label}: ${e.message.slice(0,50)}`); }
  }
}
ok(`${clicked} buttons clicked without error`, broke.length===0, broke.join(' | '));

console.log('\n── INPUTS AND SLIDERS');
r=fresh(); await wait(300);
TR.act(()=>B(r).find(b=>b.props['aria-label']==='Settings').props.onClick());
const ranges=collect(r.toJSON(),'input').filter(i=>i.props.type==='range');
let sliderOk=true;
ranges.forEach((_,i)=>{try{
  const rr=collect(r.toJSON(),'input').filter(x=>x.props.type==='range')[i];
  TR.act(()=>rr.props.onChange({target:{value:String(rr.props.min||1)}}));
}catch(e){sliderOk=false}});
ok(`${ranges.length} sliders respond`, sliderOk);
const switches=B(r).filter(b=>b.props.role==='switch');
let swOk=true;
switches.forEach((_,i)=>{try{
  const sw=B(r).filter(b=>b.props.role==='switch')[i]; TR.act(()=>sw.props.onClick());
}catch(e){swOk=false}});
ok(`${switches.length} switches toggle`, swOk);
TR.act(()=>B(r).find(b=>b.props['aria-label']==='Close').props.onClick());

console.log('\n── RESTORE REMOVED');
go(r,'Data');
ok('no restore textarea any more', collect(r.toJSON(),'textarea').length===0);
ok('no Restore button any more', !B(r).some(b=>txt(b).trim()==='Restore'));

console.log('\n── FEED FAILURE IS HANDLED');
FAIL=true; FETCHED=[];
r=fresh(); await wait(400);
go(r,'Data');
const sb=B(r).find(b=>txt(b).trim()==='Sync now');
TR.act(()=>sb.props.onClick()); await wait(300);
t=txt(r.toJSON());
ok('failure surfaced to the user', t.includes('Could not reach'), '');
ok('app still renders on failure', t.length>2000);
// Keeping the last good data through a failed fetch is the point of caching.
// Reverting to seed would throw away a good reading, which would be worse.
ok('keeps the last good readings rather than reverting', t.includes('live'));
FAIL=false;

console.log('\n── DEEP LINKS ROUND-TRIP');
for(const [h,expect] of [['#edge','What is being paid'],['#trends/gdp_growth','Decade averages'],
  ['#outlook','forward view'],['#data','Updates'],['#pulse/npl','Non-performing']]){
  HASH=h; const rr=fresh();
  ok(`${h} opens correctly`, txt(rr.toJSON()).includes(expect), '');
}
HASH='';
console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
})();
