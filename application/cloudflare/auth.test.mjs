import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyAccess,authenticatedRequest} from './worker.mjs';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
const env={ACCESS_TEAM_DOMAIN:'https://mobile-moallem-test.cloudflareaccess.com',ACCESS_AUD:'test-audience'};
const now=Math.floor(Date.now()/1000);
const claims={iss:env.ACCESS_TEAM_DOMAIN,aud:[env.ACCESS_AUD],type:'app',iat:now,nbf:now,exp:now+3600,email:'mikailzaki48@gmail.com'};
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function sign(payload,header={alg:'RS256',kid:'test-key'}){const input=b64(header)+'.'+b64(payload);return input+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(input))).toString('base64url');}
const fetchKeys=async(url,init)=>{assert.equal(url,env.ACCESS_TEAM_DOMAIN+'/cdn-cgi/access/certs');assert.ok(['follow','manual'].includes(init?.redirect),'Workers rejects other redirect modes');return Response.json({keys:[jwk]});};
test('Cloudflare identities require valid signature, issuer, audience and active human session',async()=>{
 assert.equal((await verifyAccess(await sign(claims),env,fetchKeys)).email,claims.email);
 for(const override of [{iss:'https://evil.test'},{aud:['another']},{exp:now-1},{nbf:now+300},{iat:now+300},{type:'org'},{email:null},{exp:'tomorrow'}])assert.equal(await verifyAccess(await sign({...claims,...override}),env,fetchKeys),null);
 assert.equal(await verifyAccess(await sign(claims,{alg:'none',kid:'test-key'}),env,fetchKeys),null);
 const valid=await sign(claims);const parts=valid.split('.');parts[1]=b64({...claims,email:'forged@example.com'});assert.equal(await verifyAccess(parts.join('.'),env,fetchKeys),null);
});
test('standalone adapter strips forged Sites identity, accepts verified header/cookie and fails closed',async()=>{
 const forged={'oai-authenticated-user-id':'60371ed2-84d3-452f-adf4-74c24c065784','oai-authenticated-user-email':claims.email};
 let result=await authenticatedRequest(new Request('https://example.com/api/projects',{headers:forged}),env,fetchKeys);
 assert.equal(result.request.headers.get('oai-authenticated-user-email'),null);assert.equal(result.request.headers.get('oai-authenticated-user-id'),null);
 for(const headers of [{'cf-access-jwt-assertion':await sign(claims)},{cookie:'CF_Authorization='+await sign(claims)}]){
 result=await authenticatedRequest(new Request('https://example.com/api/projects',{headers:{...forged,...headers}}),env,fetchKeys);
 assert.equal(result.request.headers.get('oai-authenticated-user-email'),claims.email);assert.equal(result.request.headers.get('oai-authenticated-user-id'),null);
 }
 result=await authenticatedRequest(new Request('https://example.com/api/projects',{headers:forged}),{},fetchKeys);assert.equal(result.claims,null);
});

test('clean /signin and /signout paths; old ChatGPT-era paths forward to them',async()=>{
 const {default:worker}=await import('./worker.mjs');
 const env={ACCESS_TEAM_DOMAIN:'https://team.cloudflareaccess.com',ACCESS_AUD:'aud'};
 const go=async path=>(await worker.fetch(new Request('https://example.com'+path,{redirect:'manual'}),env,{}));
 assert.equal((await go('/signin-with-chatgpt')).headers.get('location'),'https://example.com/signin');
 assert.equal((await go('/signout-with-chatgpt')).headers.get('location'),'https://example.com/signout');
 assert.equal((await go('/signout')).headers.get('location'),'https://example.com/cdn-cgi/access/logout');
 assert.equal((await go('/signin')).status,403); // no Access token: refused, never a session
});
