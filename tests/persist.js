const babel=require('/home/claude/node_modules/@babel/core'),fs=require('fs');
// localStorage that SURVIVES remounts, like a real browser
const DISK={};
let quotaFail=false;
global.window={
  localStorage:{
    getItem(k){return k in DISK?DISK[k]:null},
    setItem(k,v){ if(quotaFail) throw new Error('QuotaExceededError'); DISK[k]=String(v)},
    removeItem(k){delete DISK[k]},
  },
  matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
  addEventListener(){},removeEventListener(){},innerWidth:412,
  location:{origin:'https://kenya-pulse-app.vercel.app'},
};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
global.document={createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
  body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});
fs.writeFileSync('p.js',babel.transformSync(fs.readFileSync('/mnt/user-data/outputs/KenyaPulse.jsx','utf8'),
 {presets:[['/home/claude/node_modules/@babel/preset-env',{targets:{node:'current'}}],
   ['/home/claude/node_modules/@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);
const React=require('react'),TR=require('react-test-renderer');
const App=require('./p.js').default;
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);(n.children||[]).forEach(c=>walk(c,fn));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}
let pass=0,fail=0;
(async()=>{
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};

function mount(){let r;TR.act(()=>{r=TR.create(React.createElement(App))});return r;}
const B=r=>collect(r.toJSON(),'button');
const gear=r=>B(r).find(b=>b.props['aria-label']==='Settings');
const close=r=>B(r).find(b=>b.props['aria-label']==='Close');

console.log('── SESSION 1: change settings');
let r=mount();
TR.act(()=>gear(r).props.onClick());
// theme -> dark
TR.act(()=>B(r).find(b=>(b.children||[]).join('')==='Dark').props.onClick());
// size -> XL
TR.act(()=>B(r).find(b=>(b.children||[]).join('')==='XL').props.onClick());
// the feed is fixed now, so there is no URL field to set
// tax slider
const ranges=collect(r.toJSON(),'input').filter(i=>i.props.type==='range');
TR.act(()=>ranges[1].props.onChange({target:{value:'7'}}));
TR.act(()=>close(r).props.onClick());
TR.act(()=>{});
await new Promise(r=>setTimeout(r,400));   // let the debounced write land
console.log('   DISK keys after session 1:', Object.keys(DISK));
const saved1=DISK['kp.cfg']?JSON.parse(DISK['kp.cfg']):null;
console.log('   kp.cfg =', saved1?JSON.stringify({theme:saved1.theme,size:saved1.size,taxMmf:saved1.taxMmf}):'MISSING');
ok('cfg written to disk', !!saved1);
ok('theme saved', saved1 && saved1.theme==='dark', saved1?saved1.theme:'');
ok('size saved', saved1 && saved1.size==='xl', saved1?saved1.size:'');
ok('feed is not a stored setting any more', saved1 && !('feed' in saved1),
   saved1 && saved1.feed ? 'still present' : '');
ok('tax saved', saved1 && saved1.taxMmf===7, saved1?String(saved1.taxMmf):'');

console.log('\n── SESSION 2: fresh mount, same disk (simulates reopening the app)');
await new Promise(r=>setTimeout(r,400));
TR.act(()=>r.unmount());
delete require.cache[require.resolve('./p.js')];
const App2=require('./p.js').default;
let r2;TR.act(()=>{r2=TR.create(React.createElement(App2))});
TR.act(()=>B(r2).find(b=>b.props['aria-label']==='Settings').props.onClick());
const t2=txt(r2.toJSON());
ok('no feed input in settings', !collect(r2.toJSON(),'input').some(i=>i.props.inputMode==='url'));
ok('tax slider restored to 7', t2.includes('Money market funds · 7%'),
   t2.match(/Money market funds · \d+%/)?.[0]||'not found');
const r2ranges=collect(r2.toJSON(),'input').filter(i=>i.props.type==='range');
ok('slider value attribute restored', r2ranges[1] && r2ranges[1].props.value===7,
   r2ranges[1]?String(r2ranges[1].props.value):'');
const disk2=JSON.parse(DISK['kp.cfg']);
ok('theme still dark on disk', disk2.theme==='dark', disk2.theme);
ok('size still xl on disk', disk2.size==='xl', disk2.size);

console.log('\n── SESSION 3: does mount OVERWRITE saved settings?');
const before=JSON.stringify(JSON.parse(DISK['kp.cfg']));
await new Promise(r=>setTimeout(r,400));
TR.act(()=>r2.unmount());
delete require.cache[require.resolve('./p.js')];
const App3=require('./p.js').default;
let r3;TR.act(()=>{r3=TR.create(React.createElement(App3))});
const after=JSON.stringify(JSON.parse(DISK['kp.cfg']));
ok('mount does not clobber saved cfg', before===after,
   before===after?'':`\n     before: ${before.slice(0,120)}\n     after:  ${after.slice(0,120)}`);

console.log('\n── QUOTA / PRIVATE MODE');
quotaFail=true;
let threw=null;
try{ TR.act(()=>{const rr=TR.create(React.createElement(App3)); rr.unmount();}); }catch(e){threw=e.message;}
ok('survives localStorage throwing', !threw, threw||'');
quotaFail=false;

console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
})();
