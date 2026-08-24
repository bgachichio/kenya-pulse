const babel=require('/home/claude/node_modules/@babel/core'),fs=require('fs');
const DISK={}; let W=412;
global.window={localStorage:{getItem:k=>k in DISK?DISK[k]:null,setItem:(k,v)=>{DISK[k]=String(v)},removeItem:k=>{delete DISK[k]}},
 matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
 addEventListener(){},removeEventListener(){},get innerWidth(){return W},
 location:{origin:'https://kenya-pulse-app.vercel.app'}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
global.document={createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
 body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});
fs.writeFileSync('t.js',babel.transformSync(fs.readFileSync('/mnt/user-data/outputs/KenyaPulse.jsx','utf8'),
 {presets:[['/home/claude/node_modules/@babel/preset-env',{targets:{node:'current'}}],
  ['/home/claude/node_modules/@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);
const React=require('react'),TR=require('react-test-renderer');
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);(n.children||[]).forEach(c=>walk(c,fn));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}
let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};
const fresh=()=>{delete require.cache[require.resolve('./t.js')];const A=require('./t.js').default;
  let r;TR.act(()=>{r=TR.create(React.createElement(A))});return r;};
const B=r=>collect(r.toJSON(),'button');
const go=(r,n)=>TR.act(()=>B(r).find(b=>(b.children||[]).join('')===n).props.onClick());

// hand-computed truth
const YEARS=Array.from({length:24},(_,i)=>2002+i);
const GDPG=[0.55,2.93,5.1,5.91,6.47,6.85,0.23,3.31,8.06,5.12,4.57,3.8,5.02,4.97,4.21,3.84,5.65,5.11,-0.27,7.59,4.86,5.72,4.66,4.63];
const CAB=[-0.9,0.89,-0.82,-1.35,-1.98,-3.23,-5.52,-3.99,-5.22,-8.15,-7.48,-7.85,-9.34,-6.3,-5.4,-7,-5.41,-5.24,-3.27,-4.6,-4.2,-2.55,-1.29,null];
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const dec=(vals,f,t)=>{const v=YEARS.map((y,i)=>({y,v:vals[i]})).filter(x=>x.v!=null&&x.y>=f&&x.y<=t).map(x=>x.v);return v.length?mean(v):null;};

let r=fresh(); go(r,'Trends');

console.log('── OVERFLOW ROOT CAUSE');
let noMin=[];
walk(r.toJSON(),n=>{const st=n.props&&n.props.style;
  if(st&&st.display==='grid'&&st.gap===14&&st.minWidth!==0)noMin.push('tab grid');});
ok('tab content grid has minWidth:0', noMin.length===0, noMin.join(','));
const cards=[];walk(r.toJSON(),n=>{const st=n.props&&n.props.style;
  if(st&&st.borderRadius===16&&st.boxShadow!==undefined)cards.push(st.minWidth);});
ok(`all ${cards.length} cards have minWidth:0`, cards.every(x=>x===0), String(cards));
const wide=[];walk(r.toJSON(),n=>{const st=n.props&&n.props.style;
  if(st&&typeof st.width==='number'&&st.width>300)wide.push(st.width);});
ok('no fixed width over 300px', wide.length===0, wide.join(','));

console.log('\n── Y-AXIS (was absent entirely)');
let t=txt(r.toJSON());
ok('shows axis maximum 8.06', t.includes('8.06')||t.includes('8.1'), '');
ok('shows axis minimum -0.27', t.includes('-0.27')||t.includes('-0.3'), '');
ok('start year label', t.includes('2002'));
ok('end year label 2025 present', t.includes('2025'));

console.log('\n── PERCENTILE REMOVED');
ok('no percentile card in output', !/percentile/i.test(t), '');
ok('24-year mean comparison remains', t.includes('Against the 24-year mean'), '');

console.log('\n── DECADE AVERAGES BY YEAR (was slicing the filtered array)');
const gd1=dec(GDPG,2002,2011), gd2=dec(GDPG,2012,2021), gd3=dec(GDPG,2022,2025);
console.log(`   GDP growth expected: ${gd1.toFixed(2)} / ${gd2.toFixed(2)} / ${gd3.toFixed(2)}`);
ok('GDP decade 1 rendered', t.includes(gd1.toFixed(2)), gd1.toFixed(2));
ok('GDP decade 2 rendered', t.includes(gd2.toFixed(2)), gd2.toFixed(2));
ok('GDP decade 3 rendered', t.includes(gd3.toFixed(2)), gd3.toFixed(2));

// current account has a null at 2025 — the old code shifted every decade
const sel=B(r).filter(b=>txt(b).trim()==='Current account');
ok('current account selector exists', sel.length>0);
TR.act(()=>sel[0].props.onClick());
t=txt(r.toJSON());
const cd1=dec(CAB,2002,2011), cd2=dec(CAB,2012,2021), cd3=dec(CAB,2022,2025);
console.log(`   Current account expected: ${cd1.toFixed(2)} / ${cd2.toFixed(2)} / ${cd3.toFixed(2)}`);
ok('gapped series decade 1 correct', t.includes(cd1.toFixed(2)), cd1.toFixed(2));
ok('gapped series decade 2 correct', t.includes(cd2.toFixed(2)), cd2.toFixed(2));
ok('gapped series decade 3 correct', t.includes(cd3.toFixed(2)), cd3.toFixed(2));
// old buggy method would have produced these instead
const clean=CAB.filter(v=>v!=null);
const bad2=mean(clean.slice(10,20));
ok('does NOT reproduce the old filtered-slice value', !t.includes(bad2.toFixed(2)) || bad2.toFixed(2)===cd2.toFixed(2),
   `old method gave ${bad2.toFixed(2)}`);

console.log('\n── LATEST YEAR LABELLED (cab ends 2024, not 2025)');
ok('names the year of the latest reading', t.includes('2024'), '');
ok('latest value is the 2024 figure', t.includes('-1.29'));

console.log('\n── ALL TEN SERIES RENDER');
let allOk=true, broke=null;
for(const label of ['GDP growth','Inflation','GDP','GDP a head','Exports','Imports',
                    'Current account','Private credit','FX reserves','Remittances']){
  const b=B(r).filter(x=>txt(x).trim()===label)[0];
  if(!b){allOk=false;broke=label+' missing';break;}
  try{ TR.act(()=>b.props.onClick());
    if(txt(r.toJSON()).length<1500){allOk=false;broke=label+' rendered empty';break;} }
  catch(e){allOk=false;broke=label+': '+e.message.slice(0,50);break;}
}
ok('every series renders without error', allOk, broke||'');

console.log('\n── NARROW VIEWPORT');
for(const w of [320,360,412]){
  W=w; const rr=fresh(); go(rr,'Trends');
  const tt=txt(rr.toJSON());
  ok(`${w}px Trends renders`, tt.includes('Decade averages')&&tt.includes('2002'), '');
  const bad=[];walk(rr.toJSON(),n=>{const st=n.props&&n.props.style;
    if(st&&typeof st.width==='number'&&st.width>w-40)bad.push(st.width);});
  ok(`  ${w}px nothing exceeds viewport`, bad.length===0, bad.join(','));
}

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
