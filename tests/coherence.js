/* Does the picture agree with the number beside it?

   Three separate claims sit in one row: a value, a change, and a line. They
   are easy to get wrong together. The bug this suite was written for: the app
   took the live history from the feed but kept a `prior` hard-coded here
   months earlier, so a row reported a fall of 0.25 with a dead flat line
   beside it. Nothing crashed and no test noticed. */

{const _si=setInterval;global.setInterval=(...a)=>{const t=_si(...a);t&&t.unref&&t.unref();return t;};}
const babel=require('@babel/core'),fs=require('fs'),path=require('path');
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
const DISK={}; let W=412,HASH='',DARK=false;
global.window={localStorage:{getItem:k=>k in DISK?DISK[k]:null,setItem:(k,v)=>{DISK[k]=String(v)},removeItem:k=>{delete DISK[k]}},
 matchMedia:()=>({get matches(){return DARK},addEventListener(){},removeEventListener(){}}),
 addEventListener(){},removeEventListener(){},get innerWidth(){return W},
 get location(){return{origin:'https://x.test',pathname:'/',get hash(){return HASH}}},
 history:{replaceState:(a,b,h)=>{HASH=h}}};
global.document={documentElement:{classList:{toggle(){}},dataset:{},style:{}},
 createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
 body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});

const SRC=fs.readFileSync(path.resolve(__dirname,'../app/src/App.jsx'),'utf8');
/* mergeFeed, SEED and changeSentence are internal to the app and stay that
   way; the compiled copy this suite loads gets an extra line exposing them,
   rather than the shipped module growing exports it does not need. */
const compiled=babel.transformSync(SRC,
 {presets:[['@babel/preset-env',{targets:{node:'current'},modules:'commonjs'}],
  ['@babel/preset-react',{runtime:'classic'}]],filename:'k.jsx'}).code;
fs.writeFileSync('coherence.mjs.js',
  compiled+'\nmodule.exports.mergeFeed=mergeFeed;'+
  '\nmodule.exports.SEED=SEED;\nmodule.exports.changeSentence=changeSentence;'+
  '\nmodule.exports.levels=levels;\n');
const {mergeFeed,SEED,changeSentence}=require('./coherence.mjs.js');
let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log(`  ✓ ${n}`)):(fail++,console.log(`  ✗ ${n} ${d}`))};

const sign=x=>Math.abs(x)<1e-9?0:Math.sign(x);
const lastStep=h=>Array.isArray(h)&&h.length>1?h[h.length-1]-h[h.length-2]:null;

console.log('── THE FEED PATH: THE FIGURE IS THE LAST STEP OF THE LINE');
/* The exact shape that produced the bug: a live value that has not moved
   since the previous run, against a seed carrying an older, different prior. */
const seedCbr = SEED.indicators.find(i=>i.id==='cbr');
ok('the seed really does carry a different prior', seedCbr.prior !== seedCbr.value);
const flat = mergeFeed(SEED, {asOf:'2026-08-23', signals:[
  {id:'cbr', value:8.75, prior:8.75, hist:[9.25,9.00,8.75], source:'cbk'}]});
const cbr = flat.indicators.find(i=>i.id==='cbr');
ok('a value that has not moved reports no change', sign(cbr.value-cbr.prior)===0,
   `prior ${cbr.prior}`);
ok('the prior comes from the feed, not from the seed', cbr.prior===8.75,
   `got ${cbr.prior}, seed holds ${seedCbr.prior}`);
ok('and the line it is drawn from is the live one', cbr.hist.length===3);
ok('the line ends on the value shown',
   Math.abs(cbr.hist[cbr.hist.length-1]-cbr.value)<1e-9);

/* and a live value that has moved: there the figure and the line's last step
   are the same fact, and must agree exactly. */
const moved = mergeFeed(SEED, {asOf:'2026-08-23', signals:[
  {id:'cbr', value:9.25, prior:8.75, hist:[8.5,8.75,9.25], source:'cbk'}]});
const cbr2 = moved.indicators.find(i=>i.id==='cbr');
ok('a rise is reported as a rise', sign(cbr2.value-cbr2.prior)>0);
ok('and matches the last step of the line',
   Math.abs((cbr2.value-cbr2.prior)-lastStep(cbr2.hist))<1e-9);

console.log('\n── EVERY INDICATOR IN A REAL COLLECTOR PAYLOAD');
const live=JSON.parse(fs.readFileSync(path.resolve(__dirname,'live.json'),'utf8'));
const merged=mergeFeed(SEED, live);
/* what the app actually draws: levels() is applied to every indicator on its
   way to the screen, so that is what this has to measure. */
const {levels}=require('./coherence.mjs.js');
const drawn=merged.indicators.map(i=>({...i,hist:levels(i.hist)}))
  .filter(i=>i.prior!=null&&Array.isArray(i.hist)&&i.hist.length>1);
ok('the payload actually exercises this', drawn.length>0, `${drawn.length} rows`);
/* The rule, stated precisely: when a row reports a move, that move is the last
   step of the line. When it reports none, the line simply has not gained a
   point - it never repeats a level, so there is nothing to disagree with. */
const off=drawn.filter(i=>{
  const d=i.value-i.prior;
  if (sign(d)===0) return false;
  return Math.abs(d-lastStep(i.hist))>1e-6;
});
ok('no row that reports a move disagrees with its own line', off.length===0,
   off.map(i=>`${i.id}: row ${(i.value-i.prior).toFixed(3)} line ${lastStep(i.hist).toFixed(3)}`).join(' | '));
const repeats=drawn.filter(i=>i.hist.some((v,n)=>n>0&&Math.abs(v-i.hist[n-1])<1e-9));
ok('no line repeats a level, so its length does not track the schedule',
   repeats.length===0, repeats.map(i=>i.id).join(','));
ok('the line always ends on the value shown',
   drawn.every(i=>Math.abs(i.hist[i.hist.length-1]-i.value)<1e-9),
   drawn.filter(i=>Math.abs(i.hist[i.hist.length-1]-i.value)>=1e-9).map(i=>i.id).join(','));

console.log('\n── THE READER IS TOLD WHAT THE CHANGE IS MEASURED AGAINST');
ok('every live row names its basis',
   drawn.every(i=>typeof i.priorLabel==='string'&&i.priorLabel.length>3),
   drawn.filter(i=>!i.priorLabel).map(i=>i.id).join(','));
ok('every seed row names its basis too',
   SEED.indicators.filter(i=>i.prior!=null).every(i=>typeof i.priorLabel==='string'));

console.log('\n── THE SENTENCE UNDER AN OPEN ROW');
const s1=changeSentence({value:8.75,prior:8.75,unit:'%',dir:0,hist:[8.75,8.75,8.75],priorLabel:'last reading'});
ok('an unmoved figure says so', /^Unchanged from last reading\./.test(s1), s1);
ok('and still states the span of the line', /last 3 distinct levels/.test(s1), s1);

/* inflation: dir is -1, so a fall is the good outcome. The line goes down and
   the figure is green, which is the pairing that confuses people. */
const s2=changeSentence({value:6.0,prior:6.5,unit:'%',dir:-1,hist:[7,6.8,6.5,6.0],priorLabel:'June'});
ok('a fall is described as a fall', /^Down 0\.5/.test(s2), s2);
ok('it names the basis', /from June\./.test(s2), s2);
ok('and explains why a falling line is green', /Green because that helps\./.test(s2), s2);

const s3=changeSentence({value:7.0,prior:6.5,unit:'%',dir:-1,hist:[6,6.2,6.5,7.0],priorLabel:'June'});
ok('a rise in a bad-if-rising figure is explained as red', /Red because that hurts\./.test(s3), s3);

const s4=changeSentence({value:129.3,prior:129.2,unit:'',dir:0,hist:[129.1,129.2,129.3],priorLabel:'yesterday'});
ok('a figure that is neither good nor bad gets no colour claim',
   !/Green|Red/.test(s4), s4);

console.log('\n── THE SEEDED READINGS, WHICH AN OFFLINE FIRST RUN DRAWS');
/* The seed compares against real economic reference points - "December", "a
   year ago" - not against the previous reading, so its figure and the last
   step of its line measure different spans on purpose. That is fine as long as
   the row says which, and as long as a rate with only one recorded level draws
   no line at all rather than a misleading one. */
const seeded=SEED.indicators.map(i=>({...i,hist:levels(i.hist)}));
const longer=seeded.filter(i=>i.prior!=null&&i.hist.length>1
  &&Math.abs((i.value-i.prior)-lastStep(i.hist))>1e-6);
ok('rows comparing a longer span exist in the seed', longer.length>0, String(longer.length));
ok('and every one of them states the span it used',
   longer.every(i=>typeof i.priorLabel==='string'&&i.priorLabel.length>3),
   longer.filter(i=>!i.priorLabel).map(i=>i.id).join(','));
ok('none of them is left with the default wording',
   longer.every(i=>i.priorLabel!=='last reading'),
   longer.filter(i=>i.priorLabel==='last reading').map(i=>i.id).join(','));
const flatOnes=seeded.filter(i=>i.hist.length<2);
ok('a rate that has never moved is left with no line to misread',
   flatOnes.every(i=>Math.abs(i.value-i.prior)<1e-9),
   flatOnes.map(i=>i.id).join(','));

console.log('\n── THE LINE DOES NOT CHANGE SHAPE WHEN THE COLLECTOR RUNS MORE OFTEN');
/* The reason this matters: history is one row per run. Collecting daily rather
   than twice a month would otherwise turn a monthly series into a flat line. */
const twiceMonthly=[7.0,6.8,6.5,6.2,6.0];
const daily=[7.0,7.0,7.0,6.8,6.8,6.8,6.8,6.5,6.5,6.5,6.2,6.2,6.0,6.0,6.0,6.0];
const collapse=a=>a.filter((v,n)=>n===0||Math.abs(v-a[n-1])>1e-9);
ok('the same series sampled either way gives the same line',
   JSON.stringify(collapse(daily))===JSON.stringify(twiceMonthly),
   JSON.stringify(collapse(daily)));
const A=mergeFeed(SEED,{asOf:'x',signals:[{id:'inflation',value:6.0,prior:6.2,hist:twiceMonthly,source:'cbk'}]})
  .indicators.find(i=>i.id==='inflation');
const B=mergeFeed(SEED,{asOf:'x',signals:[{id:'inflation',value:6.0,prior:6.0,hist:collapse(daily),source:'cbk'}]})
  .indicators.find(i=>i.id==='inflation');
ok('and the app draws the same line for both',
   JSON.stringify(A.hist)===JSON.stringify(B.hist));
ok('the sentence describes levels, not visits',
   /distinct levels/.test(changeSentence(A)), changeSentence(A));
ok('a run where nothing moved still says so',
   /^Unchanged from/.test(changeSentence(B)), changeSentence(B));

console.log('\n── THE EXPLAINER IS ON THE PAGE');
ok('the app says colour is not direction', /Colour is not direction/.test(SRC));
ok('and explains why a long line can sit above a change of zero',
   /a long line can sit above\s+a change of zero/.test(SRC));
ok('it gives the worked example', /Inflation falling is a line going down/.test(SRC));

console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
process.exit(fail?1:0);
