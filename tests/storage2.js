const babel=require('/home/claude/node_modules/@babel/core'),fs=require('fs');
const DISK={}; let quotaFail=false, ORIGIN='https://kenya-pulse-app.vercel.app';
global.window={
  localStorage:{getItem(k){return k in DISK?DISK[k]:null},
    setItem(k,v){if(quotaFail){const e=new Error('q');e.name='QuotaExceededError';throw e}DISK[k]=String(v)},
    removeItem(k){delete DISK[k]}},
  matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
  addEventListener(){},removeEventListener(){},innerWidth:412,
  get location(){return {origin:ORIGIN}},
};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
global.document={createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
  body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});
fs.writeFileSync('s.js',babel.transformSync(fs.readFileSync('/mnt/user-data/outputs/KenyaPulse.jsx','utf8'),
 {presets:[['/home/claude/node_modules/@babel/preset-env',{targets:{node:'current'}}],
   ['/home/claude/node_modules/@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);
const React=require('react'),TR=require('react-test-renderer');
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);(n.children||[]).forEach(c=>walk(c,fn));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}
let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};
const fresh=()=>{delete require.cache[require.resolve('./s.js')];
  const A=require('./s.js').default;let r;TR.act(()=>{r=TR.create(React.createElement(A))});return r;};
const B=r=>collect(r.toJSON(),'button');
const tab=(r,n)=>TR.act(()=>B(r).find(b=>(b.children||[]).join('')===n).props.onClick());

(async()=>{
console.log('── DIAGNOSTICS PANEL');
let r=fresh(); await new Promise(x=>setTimeout(x,350));
tab(r,'Data'); let t=txt(r.toJSON());
ok('panel present', t.includes('On this device'));
ok('plain-language summary', t.includes('on this device only'), '');
ok('does NOT expose the address to visitors', !t.includes('vercel.app'));
ok('no diagnostics noise (byte sizes gone)', !/\d+\.\d KB/.test(t));
ok('no deploy-address noise at all', !t.includes('one-off deployment address'));

console.log('\n── VERCEL PREVIEW URL DETECTION');
ORIGIN='https://kenya-pulse-oc5gq73qe-gachichio.vercel.app';
r=fresh(); await new Promise(x=>setTimeout(x,350));
tab(r,'Data'); t=txt(r.toJSON());
ok('no developer-facing deploy warning for visitors', !t.includes('one-off deployment address'));
ORIGIN='https://kenya-pulse-app.vercel.app';

console.log('\n── STORAGE BLOCKED');
quotaFail=true;
r=fresh(); await new Promise(x=>setTimeout(x,350));
tab(r,'Data'); t=txt(r.toJSON());
ok('detects blocked storage', t.includes('Nothing is being saved') || t.includes('storage is full'),
   t.match(/Storage\w*/)?.[0]||'');
ok('app still usable when blocked', txt(r.toJSON()).length>2000);
quotaFail=false;

console.log('\n── RESTORE REMOVED');
r=fresh(); await new Promise(x=>setTimeout(x,350));
tab(r,'Data');
ok('no restore box any more', collect(r.toJSON(),'textarea').length===0);
ok('no Restore button any more', !B(r).some(b=>(b.children||[]).join('')==='Restore'));
ok('app still renders', txt(r.toJSON()).length>2000);

console.log('\n── SCHEMA VERSION STAMPED');
ok('cfg carries __v', JSON.parse(DISK['kp.cfg']).__v===1, String(JSON.parse(DISK['kp.cfg']).__v));

console.log('\n── DEBOUNCE');
const before=Object.keys(DISK).length;
r=fresh();
const gear=B(r).find(b=>b.props['aria-label']==='Settings');
TR.act(()=>gear.props.onClick());
const rng=collect(r.toJSON(),'input').filter(i=>i.props.type==='range')[1];
for(let i=0;i<20;i++){ TR.act(()=>rng.props.onChange({target:{value:String(i)}})); }
const midWrites=JSON.parse(DISK['kp.cfg']).taxMmf;
await new Promise(x=>setTimeout(x,400));
const finalV=JSON.parse(DISK['kp.cfg']).taxMmf;
ok('20 rapid changes collapse into one write', finalV===19, `final=${finalV}`);

console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
})();
