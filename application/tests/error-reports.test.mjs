import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {errorReports,takeQuota} from '../dist/server/error-reports.js';
function fixture(){
 const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE hymn_projects(hymn_id TEXT,status TEXT)');
 const wrap=(sql,args=[])=>({bind(...a){return wrap(sql,a)},async first(){return db.prepare(sql).get(...args)||null},async all(){return {results:db.prepare(sql).all(...args)}},async run(){return db.prepare(sql).run(...args)}});
 const env={DB:{prepare:wrap,async batch(stmts){for(const s of stmts)await s.run()}},ASSETS:{fetch:async()=>Response.json([{id:'annual/matins/example'}])}};
 const base={hymnId:'annual/matins/example',title:'Example',section:'coptic',kind:'word',position:2,excerpt:'word',message:'Incorrect word here'};
 const request=(body=base,{user='reader',method='POST',origin='https://test.local',editor=false,cursor=null}={})=>errorReports(new Request('https://test.local/api/error-reports'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{method,headers:{'content-type':'application/json',...(origin?{origin}:{}),...(user?{'oai-authenticated-user-id':user}:{})},...(method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),env,{isEditor:()=>editor,validId:id=>id==='annual/matins/example'});
 return {db,env,request,base};
}
test('saves exact part privately, editor inbox and resolution',async()=>{const f=fixture();assert.equal((await f.request()).status,201); const row=f.db.prepare('SELECT * FROM error_reports').get();assert.equal(row.position,2);assert.equal(row.section,'coptic');assert.equal(row.message,f.base.message);assert.equal((await f.request(null,{method:'GET'})).status,403);const inbox=await (await f.request(null,{method:'GET',editor:true})).json();assert.equal(inbox.reports.length,1);assert.equal(inbox.reports[0].reporter,undefined);assert.equal((await f.request({id:row.id},{method:'PATCH'})).status,403);assert.equal((await f.request({id:row.id},{method:'PATCH',editor:true})).status,200);assert.equal(f.db.prepare('SELECT status FROM error_reports').get().status,'resolved');});
test('server quota stops fourth attempt and accounts have separate limits',async()=>{const f=fixture();for(let i=0;i<3;i++)assert.equal((await f.request({...f.base,message:'Issue number '+i})).status,201);const r=await f.request();assert.equal(r.status,429);assert.ok(Number(r.headers.get('retry-after'))>0);assert.equal((await f.request(f.base,{user:'other'})).status,201);assert.equal(f.db.prepare('SELECT count(*) n FROM error_reports').get().n,4);});
test('atomic quota under simultaneous attempts and resets next window',async()=>{const f=fixture();await f.request();const outcomes=await Promise.all(Array.from({length:30},()=>takeQuota(f.env.DB,'parallel',100,3)));assert.equal(outcomes.filter(Boolean).length,3);assert.equal(await takeQuota(f.env.DB,'parallel',101,3),true);});
test('daily and global limits cannot be bypassed by another short window or account',async()=>{const f=fixture();await f.request();const day=Math.floor(Date.now()/86400000),short=Math.floor(Date.now()/600000);f.db.prepare("UPDATE error_report_limits SET count=10 WHERE key LIKE 'user-day:%'").run();assert.equal((await f.request()).status,429);f.db.prepare("INSERT INTO error_report_limits VALUES('site-short',?,100) ON CONFLICT(key) DO UPDATE SET count=100").run(short);assert.equal((await f.request(f.base,{user:'fresh'})).status,429);f.db.prepare("UPDATE error_report_limits SET count=0 WHERE key='site-short'").run();f.db.prepare("INSERT INTO error_report_limits VALUES('site-day',?,1000) ON CONFLICT(key) DO UPDATE SET count=1000").run(day);assert.equal((await f.request(f.base,{user:'fresh2'})).status,429);});
test('authentication, origin, bounded body, validation and deduplication',async()=>{const f=fixture();assert.equal((await f.request(f.base,{user:null})).status,401);assert.equal((await f.request(f.base,{origin:'https://evil.test'})).status,403);assert.equal((await f.request(f.base,{origin:null})).status,403);assert.equal((await f.request('x'.repeat(9000))).status,400);assert.equal((await f.request({...f.base,position:-1})).status,400);assert.equal((await f.request()).status,201);assert.equal((await f.request()).status,200);assert.equal(f.db.prepare('SELECT count(*) n FROM error_reports').get().n,1);});

test('all open reports remain reachable after resolving a page entry',async()=>{
 const f=fixture(); await f.request(); f.db.exec('DELETE FROM error_reports');
 const insert=f.db.prepare("INSERT INTO error_reports(id,hymn_id,title,section,kind,position,excerpt,message,reporter,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
 for(let i=0;i<150;i++) insert.run(crypto.randomUUID(),f.base.hymnId,'Example','coptic','word',i,'word','Issue '+i,'reader',1000);
 const first=await(await f.request(null,{method:'GET',editor:true})).json(); assert.equal(first.reports.length,100); assert.ok(first.nextCursor);
 await f.request({id:first.reports[0].id},{method:'PATCH',editor:true});
 const next=await(await f.request(null,{method:'GET',editor:true,cursor:first.nextCursor})).json(); assert.equal(next.reports.length,50); assert.equal(next.nextCursor,null);
 assert.equal(new Set([...first.reports,...next.reports].map(r=>r.id)).size,150);
 assert.equal((await f.request(null,{method:'GET',editor:true,cursor:'invalid'})).status,400);
});
