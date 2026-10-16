import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import app from '../dist/server/index.js';
const root=new URL('../',import.meta.url);
const context={};runInNewContext(readFileSync(new URL('dist/client/alignment-worker.js',root),'utf8'),context);
const engine=context.RecordingAlignment;
const hymn='annual/test/hymn';
function fixture(){
  const db=new DatabaseSync(':memory:');
  for(const file of ['0000_complete_caretaker','0001_hymn_text','0002_coptic_text','0003_section_recordings','0004_alignment_suggestions'])db.exec(readFileSync(new URL('drizzle/'+file+'.sql',root),'utf8'));
  const wrap=(sql,values=[])=>({bind(...args){return wrap(sql,args)},async first(){return db.prepare(sql).get(...values)||null},async all(){return {results:db.prepare(sql).all(...values)}},async run(){const r=db.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}}}});
  const blobs=new Map();
  const env={DB:{prepare:wrap,async batch(stmts){db.exec('BEGIN');try{const results=[];for(const stmt of stmts)results.push(await stmt.run());db.exec('COMMIT');return results}catch(e){db.exec('ROLLBACK');throw e}}},BUCKET:{async put(key,body){blobs.set(key,await new Response(body).arrayBuffer())},async head(key){return blobs.has(key)?{}:null},async get(key){const data=blobs.get(key);return data?{body:data,writeHttpMetadata:h=>h.set('content-type','audio/wav')}:null}},ASSETS:{fetch:()=>new Response('asset')}};
  async function req(path,method='GET',body,editor=true){
    const headers=editor?{'oai-authenticated-user-email':'mikezaki174@gmail.com'}:{};
    if(body)headers['content-type']=body instanceof Uint8Array?'audio/wav':'application/json';
    const response=await app.fetch(new Request('https://test.local'+path,{method,headers,body:body?(body instanceof Uint8Array?body:JSON.stringify(body)):undefined}),env);
    const data=await response.json();return {status:response.status,...data};
  }
  const project={title:'Test',season:'annual',service:'test',timings:[1,2],copticTimings:[3,4],hazzatTimings:[.5,1.5],hazzatLineTimings:[0,2],textContent:'one two',copticText:'cop one',notationHtml:'one<br><br>two',recordingUrl:'https://media.tasbeha.org/mp3/test.mp3'};
  const save=()=>req('/api/project?hymnId='+hymn,'PUT',project);
  const upload=section=>req('/api/upload/audio?hymnId='+hymn+'&section='+section,'PUT',new Uint8Array([1,2,3]));
  const list=async()=> (await req('/api/alignment-suggestions?hymnId='+hymn)).suggestions;
  const act=(job,action,body={})=>req('/api/alignment-suggestions?hymnId='+hymn,'POST',{id:job.id,version:job.version,action,...body});
  const ready=async(section='hazzat')=>{await save();await upload(section);let job=(await list()).find(j=>j.section===section);job=(await act(job,'prepare',{parts:[{label:'one',weight:1,glyph:'xx',font:'HazzatFont',stack:0},{label:'two',weight:1,glyph:'cc',font:'HazzatFont',stack:0}],signature:'same',granularity:'piece'})).suggestion;return (await act(job,'result',{times:[.25,2.5],duration:5,method:'phrase-estimate'})).suggestion};
  return {db,req,project,save,upload,list,act,ready,env};
}

test('review publication preserves other channels and refuses stale, changed, incomplete or unauthorized input', async()=>{
  const f=fixture();f.project.copticRecordingUrl='https://media.tasbeha.org/mp3/coptic.mp3';await f.save();
  const original=(await f.req('/api/project?hymnId='+hymn)).project;
  const payload={section:'coptic',timings:[.3,1.1],recordingUrl:f.project.copticRecordingUrl,expectedSource:f.project.copticText,duration:4,expectedUpdatedAt:original.updatedAt};
  const publish=body=>f.req('/api/project/publish-alignment?hymnId='+hymn,'POST',body);
  assert.equal((await f.req('/api/project/publish-alignment?hymnId='+hymn,'POST',payload,false)).status,403);
  assert.equal((await publish({...payload,expectedUpdatedAt:0})).status,409);
  for(const bad of [{timings:[.3]}, {timings:[.3,null]}, {timings:[2,1]}, {timings:[.3,4]}, {recordingUrl:'https://media.tasbeha.org/other.mp3'}, {expectedSource:'different words'}]) assert.equal((await publish({...payload,...bad})).status,400);
  const cross=await app.fetch(new Request('https://test.local/api/project/publish-alignment?hymnId='+hymn,{method:'POST',headers:{'oai-authenticated-user-email':'mikezaki174@gmail.com','origin':'http://127.0.0.1:1234','sec-fetch-site':'cross-site'},body:JSON.stringify(payload)}),f.env);
  assert.equal(cross.status,403);
  assert.equal((await f.req('/api/project?hymnId='+hymn)).project.status,'draft');
  const result=await publish(payload);assert.equal(result.status,200);assert.equal(result.project.status,'complete');assert.deepEqual(result.project.copticTimings,[.3,1.1]);
  for(const key of ['timings','hazzatTimings','hazzatLineTimings','textContent','notationHtml','recordingUrl','copticRecordingUrl'])assert.deepEqual(result.project[key],original[key]);
  assert.equal((await publish(payload)).status,200);
});

test('review publication preserves Hazzat breath slots and separate stack starts',async()=>{
  const f=fixture();f.project.notationHtml='<span class="CopticFont">Pi</span><span class="HazzatFont">z . x.cd</span>';await f.save();
  const p=(await f.req('/api/project?hymnId='+hymn)).project;
  const body={section:'hazzat',timings:[.1,null,2.3],recordingUrl:p.recordingUrl,expectedSource:p.notationHtml,duration:4,expectedUpdatedAt:p.updatedAt};
  const bad=await f.req('/api/project/publish-alignment?hymnId='+hymn,'POST',{...body,timings:[.1,1,2.3]});assert.equal(bad.status,400);
  const good=await f.req('/api/project/publish-alignment?hymnId='+hymn,'POST',body);assert.equal(good.status,200);assert.deepEqual(good.project.hazzatTimings,body.timings);assert.deepEqual(good.project.hazzatLineTimings,p.hazzatLineTimings);
});

test('review publication detects an edit made during validation without replacing it',async()=>{
  const f=fixture();f.project.copticRecordingUrl='https://media.tasbeha.org/mp3/coptic.mp3';await f.save();
  const p=(await f.req('/api/project?hymnId='+hymn)).project;
  const prepare=f.env.DB.prepare;
  f.env.DB.prepare=sql=>{
    if(sql.startsWith('UPDATE hymn_projects SET coptic_timings_json'))f.db.prepare('UPDATE hymn_projects SET updated_at=updated_at+1,coptic_timings_json=? WHERE hymn_id=?').run('[0.9,1.8]',hymn);
    return prepare(sql);
  };
  const result=await f.req('/api/project/publish-alignment?hymnId='+hymn,'POST',{section:'coptic',timings:[.3,1.1],recordingUrl:p.copticRecordingUrl,expectedSource:p.copticText,duration:4,expectedUpdatedAt:p.updatedAt});
  assert.equal(result.status,409);const current=(await f.req('/api/project?hymnId='+hymn)).project;assert.equal(current.status,'draft');assert.deepEqual(current.copticTimings,[.9,1.8]);
});

test('catalog notation publication checks the actual Shere Maria passage map',async()=>{
  const f=fixture();const services=JSON.parse(readFileSync(new URL('dist/client/catalog/annual.json',root),'utf8'));
  const h=services.find(s=>s.id==='liturgy-of-the-word').hymns.find(h=>h.id==='shere-maria');
  const source=h.formats['2'][0].content.copticHazzat;
  const {sourceParts}=await import('../dist/server/alignment-publish.js');const parts=sourceParts(source,'hazzat');assert.equal(parts.length,424);
  const target='annual/liturgy-of-the-word/shere-maria';
  await f.req('/api/project?hymnId='+target,'PUT',{...f.project,notationHtml:''});
  f.env.ASSETS.fetch=async()=>Response.json(services);
  const p=(await f.req('/api/project?hymnId='+target)).project;
  const times=parts.map((part,i)=>/^\.+$/.test(part)?null:i/2);
  const result=await f.req('/api/project/publish-alignment?hymnId='+target,'POST',{section:'hazzat',timings:times,recordingUrl:p.recordingUrl,expectedSource:source,duration:240,expectedUpdatedAt:p.updatedAt});
  assert.equal(result.status,200);assert.equal(result.project.status,'complete');assert.equal(result.project.hazzatTimings.filter(t=>t===null).length,14);
});
test('upload queues a durable private suggestion and keeps other sections',async()=>{
  const f=fixture();await f.save();const r=await f.upload('hazzat');assert.equal(r.status,200);assert.deepEqual(r.project.hazzatLineTimings,[]);assert.deepEqual(r.project.hazzatTimings,[]);assert.deepEqual(r.project.timings,[1,2]);
  const job=(await f.list())[0];assert.equal(job.status,'queued');assert.deepEqual(job.reference.times,[.5,1.5]);assert.equal(job.source,r.project.recordingUrl);
  assert.equal((await f.req('/api/alignment-suggestions?hymnId='+hymn,'GET',null,false)).status,403);
  assert.equal((await f.req('/api/alignment-suggestions?hymnId='+hymn,'POST',{id:job.id,version:1,action:'reject'},false)).status,403);
});
test('review changes persist, acceptance saves draft and replay conflicts',async()=>{
  const f=fixture();let job=await f.ready();const before=await f.req('/api/project?hymnId='+hymn);assert.deepEqual(before.project.hazzatLineTimings,[]);
  job=(await f.act(job,'edit',{times:[.5,2.9],signature:'same'})).suggestion;assert.deepEqual((await f.list())[0].times,[.5,2.9]);
  const result=await f.act(job,'accept',{times:job.times,signature:'same'});assert.equal(result.status,200);assert.equal(result.project.status,'draft');assert.deepEqual(result.project.hazzatTimings,[.5,2.9]);assert.deepEqual(result.project.hazzatLineTimings,[.5]);assert.equal(result.suggestion.status,'accepted');
  assert.equal((await f.act(job,'accept',{times:job.times,signature:'same'})).status,409);
});
test('rejection never installs times; replacement invalidates the prior job',async()=>{
  const f=fixture();let job=await f.ready('english');assert.equal((await f.act(job,'reject')).suggestion.status,'rejected');assert.deepEqual((await f.req('/api/project?hymnId='+hymn)).project.timings,[]);
  await f.upload('english');assert.equal((await f.act(job,'accept',{times:job.times,signature:'same'})).status,409);assert.notEqual((await f.list())[0].id,job.id);
});
test('manual marks, changed text, and invalid input cannot be overwritten',async()=>{
  const f=fixture();let job=await f.ready();assert.equal((await f.act(job,'edit',{times:[4,2],signature:'same'})).status,400);
  assert.equal((await f.act(job,'accept',{times:[0,2],signature:'different'})).status,409);
  f.db.prepare('UPDATE hymn_projects SET hazzat_timings_json = ? WHERE hymn_id = ?').run('[1.75]',hymn);
  assert.equal((await f.act(job,'accept',{times:[0,2],signature:'same'})).status,409);
  assert.deepEqual((await f.req('/api/project?hymnId='+hymn)).project.hazzatTimings,[1.75]);
  f.db.prepare('UPDATE hymn_projects SET notation_html = ? WHERE hymn_id = ?').run('changed',hymn);
  assert.equal((await f.act(job,'edit',{times:[0,2],signature:'same'})).status,409);
});
test('missing content and failures are saved and can resume',async()=>{
  const f=fixture();await f.save();await f.upload('coptic');let job=(await f.list())[0];
  job=(await f.act(job,'prepare',{parts:[],signature:'empty'})).suggestion;assert.equal(job.status,'needs_content');
  job=(await f.act(job,'prepare',{parts:[{label:'one',weight:1}],signature:'added'})).suggestion;assert.equal(job.status,'queued');
  job=(await f.act(job,'fail',{message:'Decode failed'})).suggestion;assert.equal((await f.list())[0].message,'Decode failed');
  assert.equal((await f.act(job,'retry')).suggestion.status,'queued');
});
function song(lengths,offset=0){
  const rate=4000,notes=[220,277,330,247,370,294,415,262],duration=lengths.reduce((a,b)=>a+b,offset),pcm=new Float32Array(Math.ceil(duration*rate));let from=offset;
  for(let k=0;k<lengths.length;k++){
    for(let i=Math.ceil(from*rate);i<Math.min(pcm.length,(from+lengths[k])*rate);i++){
      const t=i/rate-from,amp=Math.min(1,t/.04,(lengths[k]-t)/.08);pcm[i]=amp*(.4*Math.sin(2*Math.PI*notes[k%notes.length]*i/rate)+.14*Math.sin(4*Math.PI*notes[k%notes.length]*i/rate));
    }from+=lengths[k];
  }return pcm;
}
test('audio estimates are ordered, bounded and silence is rejected',()=>{
  const pcm=song([1,2,1.5,2]);const result=engine.analyze({pcm,rate:4000,parts:[{weight:1},{weight:2},{weight:1},{weight:2}]});
  assert.equal(result.times.length,4);assert.ok(result.times.every((t,i)=>t>=0&&t<result.duration&&(!i||t>=result.times[i-1])));assert.equal(result.method,'phrase-estimate');
  assert.throws(()=>engine.analyze({pcm:new Float32Array(8000),rate:4000,parts:[{weight:1}]}),/silent/);
});
test('reference mapping follows a changed tempo rather than distributing uniformly',()=>{
  const reference=song([1,1,1,1,1,1,1,1]);const pcm=song([1,1.5,.8,1.4,1,1.3,.9,1.1],.4);
  const times=[0,1,2,3,4,5,6,7],expected=[.4,1.4,2.9,3.7,5.1,6.1,7.4,8.3];
  const result=engine.analyze({pcm,rate:4000,parts:times.map(()=>({weight:1})),reference:{pcm:reference,times}});
  assert.equal(result.method,'reference');for(let i=1;i<times.length;i++)assert.ok(Math.abs(result.times[i]-expected[i])<.55,`${i}: ${result.times[i]} expected ${expected[i]}`);
});

test('legacy stack suggestions regenerate as separate pieces without losing accepted marks',async()=>{
  const f=fixture();const job=await f.ready();
  const legacy={...JSON.parse(f.db.prepare('SELECT payload_json FROM alignment_suggestions WHERE id = ?').get(job.id).payload_json),granularity:'stack',times:[.2,2.4],baseline:'[]',baselineMarks:'[]'};
  f.db.prepare("UPDATE alignment_suggestions SET payload_json = ?, status = 'accepted' WHERE id = ?").run(JSON.stringify(legacy),job.id);
  f.db.prepare('UPDATE hymn_projects SET hazzat_line_timings_json = ? WHERE hymn_id = ?').run('[0.2,2.4]',hymn);
  let next=(await f.act(job,'refine')).suggestion;assert.equal(next.status,'queued');
  assert.deepEqual((await f.req('/api/project?hymnId='+hymn)).project.hazzatLineTimings,[.2,2.4]);
  const parts=['xx','cc','zz','xx'].map((glyph,i)=>({label:'Piece '+(i+1),glyph,font:'HazzatFont',stack:Math.floor(i/2),weight:2}));
  next=(await f.act(next,'prepare',{parts,signature:'pieces',granularity:'piece'})).suggestion;
  assert.equal(next.reference,null);assert.equal(next.parts.length,4);
  next=(await f.act(next,'result',{times:[.2,1.1,2.4,3.2],duration:5})).suggestion;
  const accepted=await f.act(next,'accept',{times:next.times,signature:'pieces'});
  assert.equal(accepted.status,200);assert.deepEqual(accepted.project.hazzatTimings,[.2,1.1,2.4,3.2]);assert.deepEqual(accepted.project.hazzatLineTimings,[.2,2.4]);
});
