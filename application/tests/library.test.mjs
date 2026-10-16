import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import app from '../dist/server/index.js';
function fixture(){
  const db=new DatabaseSync(':memory:');
  const directory=new URL('../drizzle/',import.meta.url);
  for(const file of readdirSync(directory).filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file,directory),'utf8'));
  const wrap=(sql,values=[])=>({bind(...args){return wrap(sql,args)},async first(){return db.prepare(sql).get(...values)||null},async all(){return {results:db.prepare(sql).all(...values)}},async run(){return db.prepare(sql).run(...values)}});
  const env={BUCKET:{},DB:{prepare:wrap,async batch(stmts){db.exec('BEGIN');try{for(const s of stmts)await s.run();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:()=>new Response('asset')}};
  async function request(body,editor=true,origin='https://test.local'){
    const headers={'content-type':'application/json',origin};if(editor)headers['oai-authenticated-user-email']='mikezaki174@gmail.com';
    return app.fetch(new Request('https://test.local/api/library/hymn-state',{method:'POST',headers,body:JSON.stringify(body)}),env);
  }
  async function library(){return (await app.fetch(new Request('https://test.local/api/library'),env)).json();}
  return {db,request,library,env};
}
const a='annual/matins/st-mary-doxology',b='annual/recordings/st-mark-doxology',c='annual/matins/st-george-doxology';
test('replacement doxologies do not inherit an old same-title project',async()=>{
  const f=fixture(),title='Doxology for St. Mark the Evangelist',id='annual/doxologies/doxology-for-st-mark-the-evangelist';
  f.db.prepare("INSERT INTO hymn_projects (hymn_id,title,season,service,owner_email,status,timings_json,text_content,coptic_text,notation_html,updated_at) VALUES (?,?,?,?,?,'complete','[1,2]',?,?,?,17)").run(b,title,'annual','recordings','mikailzaki48@gmail.com','Old English','Old Coptic','Old notation');
  const headers={'content-type':'application/json',origin:'https://test.local','oai-authenticated-user-email':'mikezaki174@gmail.com'};
  const get=await app.fetch(new Request('https://test.local/api/project?'+new URLSearchParams({hymnId:id,title,season:'annual',service:'Doxologies'}),{headers}),f.env);
  assert.equal((await get.json()).project,null);
  const saved=await app.fetch(new Request('https://test.local/api/project?hymnId='+id,{method:'PUT',headers,body:JSON.stringify({title,season:'annual',service:'Doxologies',textContent:'New English',copticText:'Ⲙⲁⲣⲕⲟⲥ',notationHtml:'',timings:[],copticTimings:[],hazzatTimings:[],hazzatLineTimings:[]})}),f.env);
  assert.equal(saved.status,200);const project=(await saved.json()).project;
  assert.equal(project.textContent,'New English');assert.equal(project.copticText,'Ⲙⲁⲣⲕⲟⲥ');assert.ok(!project.notationHtml);assert.deepEqual(project.timings,[]);
});
test('titles and cross-section folder order survive readback without changing hymn projects or season order',async()=>{
  const f=fixture();
  f.db.prepare("INSERT INTO hymn_projects (hymn_id,title,season,service,owner_email,status,timings_json,updated_at) VALUES (?,?,?,?,?,'complete','[1,2]',17)").run(a,'Original','annual','matins','mikailzaki48@gmail.com');
  const original=f.db.prepare('SELECT * FROM hymn_projects').get();
  assert.equal((await f.request({action:'reorder',seasonId:'annual',categoryId:'matins',hymnIds:[a,c]})).status,200);
  assert.equal((await f.request({action:'remove',hymnId:b})).status,200);
  assert.equal((await f.request({action:'rename',hymnId:a,title:'  Saint Mary  Ⲙⲁⲣⲓⲁ  '})).status,200);
  assert.equal((await f.request({action:'reorder',seasonId:'annual',folderId:'doxologies',hymnIds:[b,c,a]})).status,200);
  const state=(await f.library()).hymnState;
  assert.equal(state[a].title,'Saint Mary Ⲙⲁⲣⲓⲁ');assert.equal(state[a].order,0);assert.equal(state[a].folderOrder,2);assert.equal(state[b].removed,true);
  assert.deepEqual(f.db.prepare('SELECT * FROM hymn_projects').get(),original);
  assert.equal((await f.request({action:'rename',hymnId:a,title:'Renamed again'})).status,200);
  assert.equal((await f.library()).hymnState[a].folderOrder,2);
});
test('viewers and cross-site requests cannot edit titles or order',async()=>{
  const f=fixture();
  for(const body of [{action:'rename',hymnId:a,title:'New'},{action:'reorder',seasonId:'annual',folderId:'doxologies',hymnIds:[a,b]}]){
    assert.equal((await f.request(body,false)).status,403);
    assert.equal((await f.request(body,true,'https://other.local')).status,403);
  }
  assert.deepEqual((await f.library()).hymnState,{});
});
test('invalid titles and invalid order lists leave saved data intact',async()=>{
  const f=fixture();await f.request({action:'rename',hymnId:a,title:'Kept'});
  for(const body of [null,[],{action:'rename',hymnId:a,title:' '},{action:'rename',hymnId:a,title:'x'.repeat(241)},{action:'rename',hymnId:'bad',title:'New'},
    {action:'reorder',seasonId:'annual',folderId:'doxologies',hymnIds:[a,a]},
    {action:'reorder',seasonId:'annual',folderId:'doxologies',hymnIds:[a,'lent/matins/doxology']},
    {action:'reorder',seasonId:'annual',categoryId:'matins',hymnIds:[a,b]}])assert.equal((await f.request(body)).status,400);
  assert.deepEqual((await f.library()).hymnState[a],{title:'Kept',folderOrder:null});
});
