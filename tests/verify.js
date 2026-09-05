require('./harness.js');
const React=require('react'),TR=require('react-test-renderer');
const App=require('./compiled.js').default;
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);(n.children||[]).forEach(c=>walk(c,fn));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}
const B=()=>collect(r.toJSON(),'button');
const tab=n=>TR.act(()=>B().find(b=>(b.children||[]).join('')===n).props.onClick());
/* A rung reads: label, an OLD badge when the rate is overdue, the advertised
   rate, then what survives tax and inflation - "Top-quartile MMFOLD12.10%
   gross+3.79% real". Both numbers are captured; the arithmetic below checks
   the real one, and grossOf() lets the pairing itself be checked. */
function rungs(){const out={};walk(r.toJSON(),n=>{const t=txt(n);
  // The label must END in a letter. Requiring it to START with one dropped
  // "10-year bond" and the three bills; allowing anything let a stray digit
  // stand in as a label, because txt() collects a node's own strings before
  // descending. Every real label ends in a word.
  const m=t.match(/^([A-Za-z0-9][A-Za-z0-9\- ]*[A-Za-z])([\d.]+)% gross([+\-][\d.]+)% real$/);
  // The label group ends in a letter, so it swallows the OLD badge when one is
  // present ("Top-quartile MMFOLD"). No indicator label ends in OLD, so strip it.
  if(m&&t.length<60)out[m[1].replace(/OLD$/,'').trim()]={gross:parseFloat(m[2]),real:parseFloat(m[3])};});
  return out;}
function ladder(){const o={};for(const[k,v]of Object.entries(rungs()))o[k]=v.real;return o;}
function grossOf(){const o={};for(const[k,v]of Object.entries(rungs()))o[k]=v.gross;return o;}
let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};
let r; TR.act(()=>{r=TR.create(React.createElement(App));});
(async()=>{

console.log("── LADDER ARITHMETIC");
tab('Edge');
let L=ladder();
console.log("   ",JSON.stringify(L));
ok('infra bond +6.31% (12.80 gross, 0% tax, −6.49 inflation)', Math.abs(L['Infrastructure bond']-6.31)<0.01);
ok('MMF +3.79% (12.10 gross, 15% tax)', Math.abs(L['Top-quartile MMF']-3.79)<0.01);
ok('savings −3.67% (3.32 gross, 15% tax)', Math.abs(L['Bank savings account']+3.67)<0.01);
ok('cash −6.49% (= negative inflation)', Math.abs(L['Cash']+6.49)<0.01);
ok('ranked high to low', L['Infrastructure bond']>L['Top-quartile MMF']
   && L['Top-quartile MMF']>L['Bank savings account'] && L['Bank savings account']>L['Cash']);

/* Readers were taking the real figure for the advertised one, so both now sit
   on the rung and the pairing is checked, not just the arithmetic. */
let G=grossOf();
/* Count first. A parser that quietly matches fewer rows still passes every
   assertion about the rows it found, which is how coverage disappears. */
ok('all ten rungs were read', Object.keys(L).length===10,
   `${Object.keys(L).length}: ${Object.keys(L).join(', ')}`);
ok('every rung shows its advertised rate too',
   Object.keys(L).every(k=>typeof G[k]==='number'), JSON.stringify(G));
ok('the infra bond advertises 12.80%', Math.abs(G['Infrastructure bond']-12.80)<0.01, String(G['Infrastructure bond']));
ok('the MMF advertises 12.10%', Math.abs(G['Top-quartile MMF']-12.10)<0.01, String(G['Top-quartile MMF']));
ok('gross always beats real, because tax and inflation only subtract',
   Object.keys(L).every(k=>G[k]>=L[k]),
   JSON.stringify(Object.keys(L).filter(k=>G[k]<L[k])));
ok('cash advertises nothing at all', Math.abs(G['Cash'])<0.01, String(G['Cash']));

console.log("\n── COST OF INACTION");
let found=null;
walk(r.toJSON(),n=>{const t=txt(n); const m=t.match(/([0-9]+\.[0-9]+) pointsKES ([0-9,]+)/); if(m)found=m;});
ok('gap = top minus cash', found && Math.abs(parseFloat(found[1])-(L['Infrastructure bond']-L['Cash']))<0.01,
   found?`shows ${found[1]}`:'not found');
ok('KES figure = gap × 10,000', found && parseInt(found[2].replace(/,/g,''))===Math.round(parseFloat(found[1])*10000),
   found?`shows KES ${found[2]}`:'');

console.log("\n── TAX SLIDER RECOMPUTES");
TR.act(()=>B().find(b=>b.props['aria-label']==='Settings').props.onClick());
const ranges=collect(r.toJSON(),'input').filter(i=>i.props.type==='range');
TR.act(()=>ranges[1].props.onChange({target:{value:'0'}}));   // MMF tax → 0
TR.act(()=>B().find(b=>b.props['aria-label']==='Close').props.onClick());
tab('Edge');
const L2=ladder();
ok('MMF rose when tax set to 0', L2['Top-quartile MMF']>L['Top-quartile MMF'],
   `${L['Top-quartile MMF']} → ${L2['Top-quartile MMF']}`);
ok('MMF now 12.10 − 6.49 = 5.61', Math.abs(L2['Top-quartile MMF']-5.61)<0.02);
ok('untouched rows unchanged', Math.abs(L2['Cash']-L['Cash'])<0.01);
ok('re-sorted after change', Object.values(L2).every((v,i,a)=>i===0||a[i-1]>=v));

console.log("\n── TOGGLE ROUND-TRIPS");
const sizes=['S','M','L','XL'];
TR.act(()=>B().find(b=>b.props['aria-label']==='Settings').props.onClick());
let sizeOk=true;
for(const s of sizes){ try{ TR.act(()=>B().find(b=>(b.children||[]).join('')===s).props.onClick()); }
  catch(e){ sizeOk=false; } }
ok('all four text sizes apply', sizeOk);
const toggles=B().filter(b=>b.props.role==='switch');
ok(`${toggles.length} switches present`, toggles.length>=3);
let tOk=true;
toggles.forEach((t,i)=>{ try{ const b=B().filter(x=>x.props.role==='switch')[i]; TR.act(()=>b.props.onClick()); }catch(e){ tOk=false; console.log('     switch err:',e.message.slice(0,50)); } });
ok('every switch toggles', tOk);
const pins=B().filter(b=>txt(b)==='Central Bank Rate'||txt(b)==='Stanbic PMI');
ok('pin buttons exist', pins.length>0);
if(pins.length){ TR.act(()=>pins[0].props.onClick()); ok('pin toggles without error', true); }

console.log("\n── PERSISTENCE");

TR.act(()=>B().find(b=>b.props['aria-label']==='Close').props.onClick());
// writes are debounced by 250ms — flush the timer before reading disk
await new Promise(res=>setTimeout(res,320));   // let the debounced write land
const raw=global.window.localStorage.getItem('kp.cfg');
const saved=raw?JSON.parse(raw):null;
ok('config written to localStorage', !!saved, raw?'':'nothing on disk');
ok('tax override persisted', saved && saved.taxMmf===0, saved?`taxMmf=${saved.taxMmf}`:'no cfg');
ok('theme persisted', saved && typeof saved.theme==='string');
ok('schema version stamped', saved && saved.__v===1, saved?String(saved.__v):'');

console.log(`\n${'═'.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(46)}`);
process.exit(fail?1:0);
})();
