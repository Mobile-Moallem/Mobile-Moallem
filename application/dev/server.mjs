// Local preview only. Production identity is supplied by ChatGPT Sites.
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import app from '../dist/server/index.js';
import {database,bucket} from './storage.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const state=process.env.LOCAL_DATA_DIR ? path.resolve(process.env.LOCAL_DATA_DIR) : path.join(root,'.local');
await fs.mkdir(state,{recursive:true});
const migrations=[];
for(const name of (await fs.readdir(path.join(root,'drizzle'))).filter(x=>x.endsWith('.sql')).sort())migrations.push([name,await fs.readFile(path.join(root,'drizzle',name),'utf8')]);
const DB=database(path.join(state,'mobile-moallem.sqlite'),migrations);
const BUCKET=bucket(path.join(state,'media'));
const port=Number(process.env.PORT||8787);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
const origin='http://127.0.0.1:'+port;
const password=process.env.LOCAL_EDITOR_PASSWORD||'';
if(password&&password.length<16)throw new Error('LOCAL_EDITOR_PASSWORD must have at least 16 characters');
const signingKey=randomBytes(32);
const hash=value=>createHmac('sha256',signingKey).update(value).digest();
const equal=(a,b)=>timingSafeEqual(hash(a),hash(b));
const sessionToken=()=>{const p=Buffer.from(JSON.stringify({exp:Date.now()+8*3600_000})).toString('base64url');return p+'.'+createHmac('sha256',signingKey).update(p).digest('base64url');};
function signedIn(request) {
  const token=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('mm_local='))?.slice(9);
  if(!token)return false;
  const [p,sig,extra]=token.split('.');if(!p||!sig||extra)return false;
  const expected=createHmac('sha256',signingKey).update(p).digest('base64url');
  if(!equal(sig,expected))return false;
  try{return JSON.parse(Buffer.from(p,'base64url')).exp>Date.now();}catch{return false;}
}
const html=content=>new Response(content,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
const signInPage=error=>html('<!doctype html><meta charset="utf-8"><title>Mobile Moallem local editor</title><main style="font:18px system-ui;max-width:32rem;margin:10vh auto;padding:1rem"><h1>Local editor preview</h1><p>This preview uses a local password. The live site still uses ChatGPT sign-in.</p>'+ (error?'<p>Sign-in failed.</p>':'') +'<form method="post" action="/signin"><label>Local editor password <input name="password" type="password" required autocomplete="current-password"></label><p><button>Sign in</button></p></form><a href="/">Open public reader</a></main>');
const failures=new Map();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.ttf':'font/ttf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webp':'image/webp','.xml':'application/xml','.txt':'text/plain; charset=utf-8'};
const ASSETS={async fetch(request){
  const url=new URL(request.url),client=path.join(root,'dist/client');
  let name;try{name=decodeURIComponent(url.pathname);}catch{return new Response('Bad path',{status:400});}
  if(name.includes('\\'))return new Response('Not found',{status:404});
  const file=path.resolve(client,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(client+path.sep))return new Response('Not found',{status:404});
  try{const bytes=await fs.readFile(file);return new Response(request.method==='HEAD'?null:bytes,{headers:{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':'no-store'}});}catch{return new Response('Not found',{status:404});}
}};
async function route(request) {
  const url=new URL(request.url);
  if(url.origin!==origin)return new Response('Invalid host',{status:400});
  if(url.pathname==='/signin'||url.pathname==='/signin-with-chatgpt') {
    if(!password)return html('<h1>Local editor disabled</h1><p>Set LOCAL_EDITOR_PASSWORD in .env.local to preview editor access. Use / for the reader.</p>');
    if(request.method==='GET')return signInPage(false);
    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    if(request.headers.get('origin')!==origin)return new Response('Forbidden',{status:403});
    const now=Date.now(),recent=failures.get('local')||[];
    const tries=recent.filter(t=>now-t<60_000);failures.set('local',tries);
    if(tries.length>=5)return new Response('Try again in a minute.',{status:429});
    const form=await request.formData();
    if(!equal(String(form.get('password')||''),password)){tries.push(now);return signInPage(true);}
    failures.delete('local');
    return new Response(null,{status:303,headers:{location:'/#/projects','set-cookie':'mm_local='+sessionToken()+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800','cache-control':'no-store'}});
  }
  if(url.pathname==='/signout'||url.pathname==='/signout-with-chatgpt')return new Response(null,{status:303,headers:{location:'/', 'set-cookie':'mm_local=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0','cache-control':'no-store'}});
  const headers=new Headers(request.headers);
  for(const key of [...headers.keys()])if(key.startsWith('oai-authenticated-'))headers.delete(key);
  if(signedIn(request))headers.set('oai-authenticated-user-email','mikailzaki48@gmail.com');
  return app.fetch(new Request(request,{headers}),{DB,BUCKET,ASSETS});
}
const server=http.createServer(async(req,res)=>{
  try {
    if(req.headers.host!=='127.0.0.1:'+port){res.writeHead(400);res.end('Invalid host');return;}
    const method=req.method||'GET',headers=new Headers();
    for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
    const input={method,headers};
    if(!['GET','HEAD'].includes(method)){input.body=Readable.toWeb(req);input.duplex='half';}
    const response=await route(new Request(origin+req.url,input));
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
  }catch(error){console.error(error);if(!res.headersSent)res.writeHead(500);res.end('Local preview error');}
});
server.listen(port,'127.0.0.1',()=>{
  console.log('Mobile Moallem preview: '+origin);
  console.log('Local database and media are separate from production.');
  console.log(password?'Local editor sign-in enabled.':'Reader preview enabled; set LOCAL_EDITOR_PASSWORD for editor sign-in.');
});
