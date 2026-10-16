import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import app from '../dist/server/index.js';
const source=readFileSync(new URL('../dist/client/site.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('async function readProjectResponse('),source.indexOf('async function saveDraft('));
const context={Error};runInNewContext(helper,context);
test('HTML errors give recovery instructions instead of JSON parser errors',async()=>{
 await assert.rejects(context.readProjectResponse(new Response('<!DOCTYPE html>',{status:503})),/changes are still on this page/);
 await assert.rejects(context.readProjectResponse(new Response('<!DOCTYPE html>',{status:413})),/smaller file/);
 await assert.rejects(context.readProjectResponse(new Response('<!DOCTYPE html>',{status:401})),/Sign in again/);
 const project={hymnId:'annual/test/example'};assert.deepEqual(await context.readProjectResponse(Response.json({project})),{project});
});
test('save and complete storage rejections stay inside the JSON error handler',async()=>{
 const env={DB:{prepare(){return {bind(){return this},first:async()=>{throw new Error('D1_ERROR: Network connection lost.')},run:async()=>{throw new Error('D1_ERROR: Network connection lost.')}}}},BUCKET:{}};
 for(const [path,method] of [['/api/project','PUT'],['/api/project/complete','POST']]){
 const response=await app.fetch(new Request('https://test.local'+path+'?hymnId=annual/test/example',{method,headers:{'oai-authenticated-user-email':'mikailzaki48@gmail.com','content-type':'application/json'},body:method==='PUT'?JSON.stringify({title:'Example',season:'annual',service:'test',timings:[],copticTimings:[],hazzatTimings:[],hazzatLineTimings:[]}):undefined}),env);
 assert.equal(response.status,503);assert.match((await response.json()).error,/Cloud storage/);
 }
});
test('schema setup recovers from a temporary storage disconnect',async()=>{
 const server=readFileSync(new URL('../dist/server/index.js',import.meta.url),'utf8');
 const functions=server.slice(server.indexOf('async function ensureLibrarySchema('),server.indexOf('async function projectWithMedia('));
 const c={setTimeout:resolve=>resolve()};runInNewContext(functions,c);
 let failures=0,successful=0;const db={prepare(){return {async run(){if(failures++===0)throw new Error('D1_ERROR: Network connection lost.');successful++;}}}};
 await c.ensureLibrarySchema(db);assert.ok(successful>0);assert.equal(failures,successful+1);
});
