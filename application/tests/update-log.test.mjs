import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import app from '../dist/server/index.js';

const hymn='annual/matins/st-mary-doxology';
function fixture(){
  const db=new DatabaseSync(':memory:');
  const directory=new URL('../drizzle/',import.meta.url);
  for(const file of readdirSync(directory).filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file,directory),'utf8'));
  const wrap=(sql,values=[])=>({bind(...args){return wrap(sql,args)},async first(){return db.prepare(sql).get(...values)||null},async all(){return {results:db.prepare(sql).all(...values)}},async run(){const r=db.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}}}});
  const env={BUCKET:{async head(){return {}}},DB:{prepare:wrap,async batch(stmts){db.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:()=>new Response('asset')}};
  const call=(path,{method='GET',body,editor='mikezaki174@gmail.com',origin='https://test.local'}={})=>{
    const headers={'content-type':'application/json',origin};if(editor)headers['oai-authenticated-user-email']=editor;
    return app.fetch(new Request('https://test.local'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),env);
  };
  const pending=async()=>(await (await call('/api/updates/pending')).json());
  db.prepare("INSERT INTO hymn_projects (hymn_id,title,season,service,owner_email,status,timings_json,text_content,updated_at) VALUES (?,?,?,?,?,'complete','[1,2]','Old words',17)").run(hymn,'Doxology of St. Mary','annual','matins','mikailzaki48@gmail.com');
  return {db,env,call,pending};
}

test('editor changes become pending notes, and repeated edits update one note',async()=>{
  const f=fixture();
  assert.equal((await f.call('/api/library/hymn-state',{method:'POST',body:{action:'rename',hymnId:hymn,title:'Saint Mary Doxology'}})).status,200);
  assert.equal((await f.call('/api/library/hymn-state',{method:'POST',body:{action:'rename',hymnId:hymn,title:'St. Mary Doxology'}})).status,200);
  const {entries,nextVersion}=await f.pending();
  assert.equal(entries.length,1);
  assert.equal(entries[0].summary,'Renamed Doxology of St. Mary to St. Mary Doxology');
  assert.equal(entries[0].editor,'mikezaki174@gmail.com');
  assert.deepEqual(nextVersion,{minor:'1.0',major:'1.0'});
});

test('saving a hymn describes what changed',async()=>{
  const f=fixture();
  const save=body=>f.call('/api/project?hymnId='+hymn,{method:'PUT',body:{title:'Doxology of St. Mary',season:'annual',service:'matins',timings:[1,2],copticTimings:[],hazzatTimings:[],hazzatLineTimings:[],textContent:'Old words',copticText:'',notationHtml:'',...body}});
  assert.equal((await save({textContent:'New words'})).status,200);
  assert.equal((await save({textContent:'New words',timings:[1,3]})).status,200);
  const summaries=(await f.pending()).entries.map(e=>e.summary).sort();
  assert.deepEqual(summaries,['Edited the words of Doxology of St. Mary','Updated the syncing of Doxology of St. Mary']);
});

test('failed or unauthorized edits are not logged',async()=>{
  const f=fixture();
  assert.equal((await f.call('/api/library/hymn-state',{method:'POST',body:{action:'rename',hymnId:hymn,title:' '}})).status,400);
  assert.equal((await f.call('/api/library/hymn-state',{method:'POST',body:{action:'rename',hymnId:hymn,title:'Hacked'},editor:null})).status,403);
  assert.equal((await f.call('/api/library/hymn-state',{method:'POST',body:{action:'rename',hymnId:hymn,title:'Hacked'},origin:'https://evil.test'})).status,403);
  assert.equal((await f.pending()).entries.length,0);
});

test('editors can add, reword and remove notes; edited wording survives later saves',async()=>{
  const f=fixture();
  assert.equal((await f.call('/api/updates/pending',{method:'POST',body:{action:'add',summary:'Renamed seasons (Nayrouz, Theophany, Jonah’s Fast)'}})).status,200);
  await f.call('/api/library/hymn-state',{method:'POST',body:{action:'remove',hymnId:hymn}});
  let {entries}=await f.pending();
  assert.equal(entries.length,2);
  const removal=entries.find(e=>e.kind==='hymn-removed');
  assert.equal((await f.call('/api/updates/pending',{method:'POST',body:{action:'edit',id:removal.id,summary:'Retired the old St. Mary doxology'}})).status,200);
  await f.call('/api/library/hymn-state',{method:'POST',body:{action:'remove',hymnId:hymn}});
  entries=(await f.pending()).entries;
  assert.equal(entries.find(e=>e.kind==='hymn-removed').summary,'Retired the old St. Mary doxology');
  const note=entries.find(e=>e.kind==='note');
  assert.equal((await f.call('/api/updates/pending',{method:'POST',body:{action:'dismiss',id:note.id}})).status,200);
  assert.equal((await f.pending()).entries.length,1);
});

test('approving numbers updates 1.0, 1.1, then 2.0 and publishes them to everyone',async()=>{
  const f=fixture();
  const approve=async(bump,expectedVersion)=>{
    const {entries}=await f.pending();
    return f.call('/api/updates/approve',{method:'POST',body:{entryIds:entries.map(e=>e.id),bump,expectedVersion}});
  };
  await f.call('/api/updates/pending',{method:'POST',body:{action:'add',summary:'Added hymn Tenen'}});
  let r=await approve('minor','1.0');assert.equal(r.status,200);assert.equal((await r.json()).update.version,'1.0');
  assert.equal((await f.pending()).entries.length,0);
  await f.call('/api/updates/pending',{method:'POST',body:{action:'add',summary:'Changed recording of Tenen'}});
  r=await approve('minor','1.1');assert.equal(r.status,200);
  await f.call('/api/updates/pending',{method:'POST',body:{action:'add',summary:'New editor'}});
  r=await approve('major','2.0');assert.equal(r.status,200);
  const pub=await (await f.call('/api/updates',{editor:null})).json();
  assert.deepEqual(pub.updates.map(u=>u.version),['2.0','1.1','1.0']);
  assert.deepEqual(pub.updates[2].notes,['Added hymn Tenen']);
});

test('approval refuses stale reviews, empty updates and non-editors',async()=>{
  const f=fixture();
  await f.call('/api/updates/pending',{method:'POST',body:{action:'add',summary:'First'}});
  const {entries}=await f.pending();
  await f.call('/api/updates/pending',{method:'POST',body:{action:'add',summary:'Added while reviewing'}});
  assert.equal((await f.call('/api/updates/approve',{method:'POST',body:{entryIds:entries.map(e=>e.id),bump:'minor'}})).status,409);
  assert.equal((await f.call('/api/updates/approve',{method:'POST',body:{entryIds:[],bump:'minor'}})).status,400);
  const all=(await f.pending()).entries.map(e=>e.id);
  assert.equal((await f.call('/api/updates/approve',{method:'POST',body:{entryIds:all,bump:'minor',expectedVersion:'1.4'}})).status,409);
  assert.equal((await f.call('/api/updates/approve',{method:'POST',body:{entryIds:all,bump:'minor'},editor:null})).status,403);
  assert.equal((await f.call('/api/updates/pending',{editor:null})).status,403);
  assert.equal((await f.call('/api/updates/approve',{method:'POST',body:{entryIds:all,bump:'minor'},origin:'https://evil.test'})).status,403);
  assert.deepEqual((await (await f.call('/api/updates',{editor:null})).json()).updates,[]);
});
