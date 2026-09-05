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
console.log('\n── SHARE BRIEFING');
/* Readers took the headline for the advertised rate. Whatever leaves the app
   has to carry both numbers and say which is which, and it has to say who made
   it - a briefing pasted into a group chat with no attribution is anonymous. */
const goTab=(r,n)=>TR.act(()=>{B(r).find(b=>(b.children||[]).join('')===n).props.onClick()});
goTab(r,'Edge');
const findShare=r=>B(r).find(b=>b.props['aria-label']==='Share briefing');
const shareBtn=findShare(r);
ok('the button says share, not copy', !!shareBtn && /Share briefing/.test(txt(shareBtn)),
   txt(r.toJSON()).slice(0,60));
ok('and keeps that name even while it is working',
   shareBtn.props['aria-label']==='Share briefing');
ok('nothing still offers to copy the briefing',
   !/Copy briefing/.test(txt(r.toJSON())));

/* No navigator.share in this harness, so it must reach the clipboard. */
let clipped='';
globalThis.navigator.clipboard.writeText=async t=>{clipped=t};
await TR.act(async()=>{await shareBtn.props.onClick();});
await new Promise(x=>setTimeout(x,50));

ok('it puts the briefing somewhere the reader can use', clipped.length>80, String(clipped.length));
ok('the best rung carries its gross rate', /Best:.*% gross/.test(clipped),
   (clipped.match(/Best:.*/)||[''])[0]);
ok('and its real rate, named as real', /Best:.*-> [+-][\d.]+% real/.test(clipped),
   (clipped.match(/Best:.*/)||[''])[0]);
ok('the worst rung does the same', /Worst:.*% gross -> [+-]?[\d.]+% real/.test(clipped),
   (clipped.match(/Worst:.*/)||[''])[0]);
ok('and it explains what real means',
   /left after withholding tax and inflation/.test(clipped));
ok('it is signed', clipped.includes('Generated by Kenya Pulse | made by Brian Gachichio'),
   clipped.slice(-140));
ok('and carries the address', clipped.includes('https://kenyapulse.gachichio.org'),
   clipped.slice(-140));

/* With a share sheet, it must use it rather than the clipboard. */
let shared=null;
globalThis.navigator.share=async d=>{shared=d};
clipped='';
await TR.act(async()=>{await findShare(r).props.onClick();});
await new Promise(x=>setTimeout(x,50));
ok('a device with a share sheet gets the share sheet', !!shared);
ok('and the clipboard is left alone', clipped==='', clipped.slice(0,40));
ok('the share is titled', shared && shared.title==='Kenya Pulse', shared&&shared.title);
ok('and carries the same signed text',
   shared && shared.text.includes('made by Brian Gachichio'));

/* Canvas is absent here, so no image - and that must not break the share. */
ok('no canvas means text only, not a failure',
   shared && (!shared.files || shared.files.length===0),
   shared && JSON.stringify(Object.keys(shared)));

console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
})();
