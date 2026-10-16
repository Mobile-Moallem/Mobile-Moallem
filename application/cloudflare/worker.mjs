import app from '../dist/server/index.js';
const cache=new Map();
const decode=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const parse=s=>JSON.parse(new TextDecoder().decode(decode(s)));
function config(env){
 const issuer=env.ACCESS_TEAM_DOMAIN;
 if(typeof issuer!=='string'||!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)||!env.ACCESS_AUD)throw new Error('Configure ACCESS_TEAM_DOMAIN and ACCESS_AUD');
 return {issuer,audience:env.ACCESS_AUD};
}
export async function verifyAccess(token,env,fetchKeys=fetch,now=Date.now()/1000){
 const {issuer,audience}=config(env);
 if(typeof token!=='string'||token.length>16384)return null;
 try{
 const parts=token.split('.');if(parts.length!==3)return null;
 const header=parse(parts[0]),claims=parse(parts[1]);
 if(header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid||header.crit)return null;
 if(claims.iss!==issuer||!Array.isArray(claims.aud)||!claims.aud.includes(audience)||claims.type!=='app')return null;
 if(!Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now+30||!Number.isFinite(claims.nbf)||claims.nbf>now+30)return null;
 if(typeof claims.email!=='string'||!claims.email.includes('@')||claims.email.length>320)return null;
 let keys=cache.get(issuer);
 if(!keys||keys.until<now||!keys.value.some(k=>k.kid===header.kid)){
  const response=await fetchKeys(issuer+'/cdn-cgi/access/certs',{redirect:'error'});
  if(!response.ok)return null;
  const body=await response.json();if(!Array.isArray(body.keys))return null;
  keys={value:body.keys,until:now+300};cache.set(issuer,keys);
 }
 const jwk=keys.value.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig'));
 if(!jwk)return null;
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])))return null;
 return claims;
 }catch{return null;}
}
function cookieToken(request){
 return (request.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('CF_Authorization='))?.slice('CF_Authorization='.length);
}
export async function authenticatedRequest(request,env,fetchKeys=fetch){
 const headers=new Headers(request.headers);
 for(const key of [...headers.keys()])if(key.startsWith('oai-authenticated-'))headers.delete(key);
 // JWT identity only; the old Sites account ID is deliberately never injected.
 const token=request.headers.get('cf-access-jwt-assertion')||cookieToken(request);
 let claims=null;try{claims=await verifyAccess(token,env,fetchKeys);}catch{}
 if(claims)headers.set('oai-authenticated-user-email',claims.email.toLowerCase());
 return {request:new Request(request,{headers}),claims};
}
export default {
 async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname==='/signout-with-chatgpt')return Response.redirect(new URL('/cdn-cgi/access/logout',url).href,303);
  if(url.pathname==='/signin-with-chatgpt'){
   try{config(env);}catch{return new Response('Team sign-in is not configured. Ask the site owner to complete the Cloudflare Access setup.',{status:503});}
   const auth=await authenticatedRequest(request,env);
   if(!auth.claims)return new Response('Team sign-in requires the Cloudflare Access policy for this path.',{status:403});
   const session=await app.fetch(new Request(new URL('/api/session',url),{headers:auth.request.headers}),env,ctx);
   if(!(await session.json()).canEdit)return new Response('This account is not an approved Mobile Moallem editor.',{status:403});
   return new Response(null,{status:303,headers:{location:'/#/projects','cache-control':'no-store'}});
  }
  const auth=await authenticatedRequest(request,env);
  return app.fetch(auth.request,env,ctx);
 }
};
