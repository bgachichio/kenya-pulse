// the app keeps a 30s clock interval; unref it so a finished suite exits
{const _si=setInterval;global.setInterval=(...a)=>{const t=_si(...a);t&&t.unref&&t.unref();return t;};}
const babel=require('@babel/core'),fs=require('fs');
const DISK={}; let W=412; let fetched=[];
global.window={localStorage:{getItem:k=>k in DISK?DISK[k]:null,setItem:(k,v)=>{DISK[k]=String(v)},removeItem:k=>{delete DISK[k]}},
 matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
 addEventListener(){},removeEventListener(){},get innerWidth(){return W},
 location:{origin:'https://kenya-pulse-app.vercel.app'}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
global.document = { documentElement: { classList: { toggle() {} }, dataset: {}, style: {} },createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
 body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async(u)=>{fetched.push(u);return{ok:true,status:200,json:async()=>({asOf:'2026-08-19',signals:[]})}};
fs.writeFileSync('sh.js',babel.transformSync(fs.readFileSync(require('path').resolve(__dirname, '../app/src/App.jsx'),'utf8'),
 {presets:[['@babel/preset-env',{targets:{node:'current'},modules:'commonjs'}],
  ['@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);
const React=require('react'),TR=require('react-test-renderer');
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);(n.children||[]).forEach(c=>walk(c,fn));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}
let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};
const B=r=>collect(r.toJSON(),'button');

(async()=>{
let r; TR.act(()=>{r=TR.create(React.createElement(require('./sh.js').default))});
await new Promise(x=>setTimeout(x,400));

console.log('── FEED HARD-CODED');
ok('fetches on open without any setting', fetched.length>0, `calls: ${fetched.length}`);
ok('fetches the fixed URL', fetched[0]==='https://gachichio.org/pulse/data.json', fetched[0]||'none');
const cfg=JSON.parse(DISK['kp.cfg']);
ok('no feed key stored in settings', !('feed' in cfg), Object.keys(cfg).join(','));

console.log('\n── DATA TAB');
TR.act(()=>B(r).find(b=>(b.children||[]).join('')==='Data').props.onClick());
let t=txt(r.toJSON());
ok('no feed URL shown', !t.includes('gachichio.org/pulse'), '');
ok('no "Reading" label', !t.includes('Reading http'));
ok('no schedule wording (frequencies removed)', !t.includes('1st and 16th') && !t.toLowerCase().includes('saturday'), '');
ok('says readings sync on open', t.includes('sync automatically'), '');
ok('Sync now still present', B(r).some(b=>txt(b).trim()==='Sync now'));
const sb=B(r).find(b=>txt(b).trim()==='Sync now');
fetched=[]; TR.act(()=>sb.props.onClick()); await new Promise(x=>setTimeout(x,200));
ok('Sync now fires the fixed URL', fetched[0]==='https://gachichio.org/pulse/data.json', fetched[0]||'none');

console.log('\n── SETTINGS');
TR.act(()=>B(r).find(b=>b.props['aria-label']==='Settings').props.onClick());
t=txt(r.toJSON());
ok('no "Data feed" row', !t.includes('Data feed'));
ok('no URL input remains', collect(r.toJSON(),'input').every(i=>i.props.inputMode!=='url'));
ok('Sync on open kept', t.includes('Sync on open'));
ok('theme control kept', t.includes('Same as device'));
ok('tax sliders kept', t.includes('Money market funds'));

console.log('\n── NO "CLAUDE" ANYWHERE');
const src=fs.readFileSync(require('path').resolve(__dirname, '../app/src/App.jsx'),'utf8');
ok('not in source', !/claude/i.test(src));
TR.act(()=>B(r).find(b=>b.props['aria-label']==='Close').props.onClick());
let all='';
for(const tb of ['Pulse','Edge','Trends','Outlook','Data']){
  TR.act(()=>B(r).find(b=>(b.children||[]).join('')===tb).props.onClick());
  all+=txt(r.toJSON());
}
TR.act(()=>B(r).find(b=>b.props['aria-label']==='Settings').props.onClick());
all+=txt(r.toJSON());
ok('not in any rendered tab or settings', !/claude/i.test(all));

console.log('\n── STILL WORKS END TO END');
TR.act(()=>B(r).find(b=>b.props['aria-label']==='Close').props.onClick());
let allTabs=true;
for(const tb of ['Pulse','Edge','Trends','Outlook','Data']){
  try{TR.act(()=>B(r).find(b=>(b.children||[]).join('')===tb).props.onClick());
    if(txt(r.toJSON()).length<1500)allTabs=false;}catch(e){allTabs=false}
}
ok('all five tabs render', allTabs);
console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
})();
