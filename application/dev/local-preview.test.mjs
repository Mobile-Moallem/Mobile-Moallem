import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bucket} from './storage.mjs';
test('local sessions reject forged identities, cross-origin edits and private draft access',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mm-preview-')),port=18872,origin='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,[new URL('./server.mjs',import.meta.url).pathname],{env:{...process.env,PORT:String(port),LOCAL_EDITOR_PASSWORD:'test-only-password-293739',LOCAL_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',x=>errors+=x);
 try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Preview did not start: '+errors)),10000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Preview exited '+code+': '+errors));});child.stdout.on('data',data=>{if(String(data).includes('Mobile Moallem preview:')){clearTimeout(timer);resolve();}});});
 const forged={'oai-authenticated-user-email':'mikailzaki48@gmail.com','oai-authenticated-user-id':'60371ed2-84d3-452f-adf4-74c24c065784'};
 assert.equal((await fetch(origin+'/')).status,200);
 assert.deepEqual(await(await fetch(origin+'/api/session',{headers:forged})).json(),{canEdit:false});
 assert.equal((await fetch(origin+'/api/projects',{headers:forged})).status,403);
 const form=new URLSearchParams({password:'test-only-password-293739'});
 assert.equal((await fetch(origin+'/signin-with-chatgpt',{method:'POST',headers:{origin:'https://evil.test'},body:form,redirect:'manual'})).status,403);
 const login=await fetch(origin+'/signin-with-chatgpt',{method:'POST',headers:{origin},body:form,redirect:'manual'});
 assert.equal(login.status,303);const setCookie=login.headers.get('set-cookie');assert.match(setCookie,/HttpOnly; SameSite=Strict/);
 const cookie=setCookie.split(';')[0],headers={cookie,origin,'content-type':'application/json'};
 assert.deepEqual(await(await fetch(origin+'/api/session',{headers})).json(),{canEdit:true});
 assert.equal((await fetch(origin+'/api/projects',{headers})).status,200);
 const id='annual/test/migration-preview',payload={title:'Local test',season:'annual',service:'test',textContent:'Test text',copticText:'Ⲁ',notationHtml:'',timings:[],copticTimings:[],hazzatTimings:[],hazzatLineTimings:[]};
 assert.equal((await fetch(origin+'/api/project?hymnId='+id,{method:'PUT',headers,body:JSON.stringify(payload)})).status,200);
 assert.equal((await(await fetch(origin+'/api/project?hymnId='+id)).json()).project,null);
 assert.equal((await(await fetch(origin+'/api/project?hymnId='+id,{headers})).json()).project.title,'Local test');
 assert.equal((await fetch(origin+'/api/project?hymnId='+id,{method:'PUT',headers:{...headers,origin:'https://evil.test'},body:JSON.stringify(payload)})).status,403);
 assert.deepEqual(await(await fetch(origin+'/api/session',{headers:{cookie:cookie+'tamper'}})).json(),{canEdit:false});
 assert.match((await fetch(origin+'/signout-with-chatgpt',{redirect:'manual'})).headers.get('set-cookie'),/Max-Age=0/);
 }finally{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
test('local media preserves bytes, metadata and ranges while rejecting unsafe keys',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mm-media-'));
 try{const media=bucket(dir),key='recordings/00000000-0000-0000-0000-000000000000';
 await media.put(key,new Blob(['abcdef']).stream(),{httpMetadata:{contentType:'audio/mpeg'},customMetadata:{hymn:'test'}});
 assert.equal((await media.head(key)).size,6);
 const object=await media.get(key,{range:new Headers({range:'bytes=2-4'})});assert.equal(await object.text(),'cde');assert.deepEqual(object.range,{offset:2,length:3});
 const headers=new Headers();object.writeHttpMetadata(headers);assert.equal(headers.get('content-type'),'audio/mpeg');
 assert.equal((await media.list({prefix:'recordings/'})).objects[0].customMetadata.hymn,'test');
 await assert.rejects(()=>media.get('../private'));await media.delete(key);assert.equal(await media.head(key),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
