const babel=require('@babel/core');
const fs=require('fs'),path=require('path'),Module=require('module');

// minimal DOM stubs so the component can mount under Node
global.window={
  localStorage:{_d:{},getItem(k){return k in this._d?this._d[k]:null},
    setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]}},
  matchMedia:(q)=>({matches:false,addEventListener(){},removeEventListener(){}}),
  addEventListener(){},removeEventListener(){},
  innerWidth:412,
  location:{origin:'https://kenya-pulse-app.vercel.app'},
};
global.navigator={clipboard:{writeText:async()=>{}}};
global.document = { documentElement: { classList: { toggle() {} }, dataset: {}, style: {} },createElement:()=>({style:{},select(){},remove(){},appendChild(){}}),
  body:{appendChild(){},removeChild(){}},execCommand:()=>true};
global.fetch=async()=>({ok:true,status:200,json:async()=>({})});

const src=fs.readFileSync(require('path').resolve(__dirname, '../app/src/App.jsx'),'utf8');
const out=babel.transformSync(src,{presets:[
  ['@babel/preset-env',{targets:{node:'current'},modules:'commonjs'}],
  ['@babel/preset-react',{runtime:'classic'}]],filename:'KenyaPulse.jsx'}).code;
fs.writeFileSync('compiled.js',out);
module.exports={};
