// the app keeps a 30s clock interval; unref it so a finished suite exits
{const _si=setInterval;global.setInterval=(...a)=>{const t=_si(...a);t&&t.unref&&t.unref();return t;};}
const babel=require('@babel/core');
const fs=require('fs');
let WIDTH=412;
global.window={
  localStorage:{_d:{},getItem(k){return k in this._d?this._d[k]:null},
    setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]}},
  matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
  addEventListener(){},removeEventListener(){},
  get innerWidth(){return WIDTH;}
};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
global.document = { documentElement: { classList: { toggle() {} }, dataset: {}, style: {} },createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
  body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});
const src=fs.readFileSync(require('path').resolve(__dirname, '../app/src/App.jsx'),'utf8');
fs.writeFileSync('m.js',babel.transformSync(src,{presets:[
  ['@babel/preset-env',{targets:{node:'current'},modules:'commonjs'}],
  ['@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code);

const React=require('react'),TR=require('react-test-renderer');
const App=require('./m.js').default;
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);(n.children||[]).forEach(c=>walk(c,fn));}
function txt(n){let s='';walk(n,x=>(x.children||[]).forEach(c=>{if(typeof c==='string')s+=c}));return s;}
function collect(r,t){const o=[];walk(r,n=>{if(n.type===t)o.push(n)});return o;}

let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`));};

// estimate rendered width of a tab label in px
function tabFits(width, baseFont){
  const fontPx = Math.min(15, Math.max(11, width*0.033));
  const pad = width < 440 ? 2 : 4;
  const strip = width - (width<440?20:28) - 8;          // page + strip padding
  const per = strip/5;
  const longest = 'Outlook'.length * fontPx * 0.58;      // avg glyph width
  return {per, need: longest+pad, fits: per > longest+pad, fontPx};
}

console.log('── TAB STRIP GEOMETRY (worst label "Outlook")');
for (const w of [320,360,390,412,430,768]) {
  const r=tabFits(w);
  ok(`${w}px: ${r.per.toFixed(0)}px/tab vs ${r.need.toFixed(0)}px needed @${r.fontPx.toFixed(1)}px font`,
     r.fits, `SHORT BY ${(r.need-r.per).toFixed(0)}px`);
}

console.log('\n── RENDERS AT EACH WIDTH');
for (const w of [320,360,390,412,768]) {
  WIDTH=w;
  delete require.cache[require.resolve('./m.js')];
  const A=require('./m.js').default;
  let r; let threw=null;
  try{ TR.act(()=>{r=TR.create(React.createElement(A));}); }catch(e){ threw=e.message; }
  ok(`${w}px mounts`, !threw, threw||'');
  if(threw) continue;
  const B=()=>collect(r.toJSON(),'button');
  let allTabs=true;
  for(const t of ['Pulse','Edge','Trends','Outlook','Data']){
    const b=B().find(x=>(x.children||[]).join('')===t);
    if(!b){allTabs=false;break;}
    try{ TR.act(()=>b.props.onClick()); }catch(e){ allTabs=false; }
  }
  ok(`  ${w}px all five tabs render`, allTabs);
}

console.log('\n── NARROW-MODE ADAPTATIONS');
WIDTH=390;
delete require.cache[require.resolve('./m.js')];
let r2; const A2=require('./m.js').default;
TR.act(()=>{r2=TR.create(React.createElement(A2));});
const svgs=collect(r2.toJSON(),'svg').filter(s=>s.props.width===46||s.props.width===76);
ok('sparklines shrink at 390px', svgs.some(s=>s.props.width===46),
   `widths seen: ${[...new Set(collect(r2.toJSON(),'svg').map(s=>s.props.width))]}`);
ok('header shows a large-title date', /\d{1,2} \w+/.test(txt(r2.toJSON())));

WIDTH=768;
delete require.cache[require.resolve('./m.js')];
let r3; const A3=require('./m.js').default;
TR.act(()=>{r3=TR.create(React.createElement(A3));});
ok('desktop keeps wider sparklines', collect(r3.toJSON(),'svg').some(s=>s.props.width===76));
ok('desktop renders fully', txt(r3.toJSON()).length>2500);

console.log('\n── NO FIXED WIDTHS THAT COULD OVERFLOW');
WIDTH=320;
delete require.cache[require.resolve('./m.js')];
let r4; const A4=require('./m.js').default;
TR.act(()=>{r4=TR.create(React.createElement(A4));});
const wide=[];
walk(r4.toJSON(),n=>{const st=n.props&&n.props.style;
  if(st&&typeof st.width==='number'&&st.width>300)wide.push(st.width);});
ok('nothing wider than 300px hard-coded at 320px viewport', wide.length===0, wide.join(','));

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
