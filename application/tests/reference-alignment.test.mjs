import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ENGINE, isBreath, audit, compatible, mergeReviewed } from '../dist/client/reference-core.js';
import { analyze, warp } from '../dist/client/reference-worker.js';
import { sourceParts } from '../dist/server/alignment-publish.js';
import app from '../dist/server/index.js';

const glyphs=['z','x','.','zz.','cd'],source=glyphs.map(g=>'<span class="CopticFont">pi </span><span class="HazzatFont">'+g+'</span>').join('');
const parts=glyphs.map((glyph,i)=>({glyph,font:'HazzatFont',stack:0,context:'pi',breath:isBreath(glyph)}));
const target={engine:ENGINE,hymnId:'annual/test/hymn',section:'hazzat',parts,expectedSource:source,source:'/api/media/recordings/12345678-1234-1234-1234-123456789012',audioSha256:'a'.repeat(64),duration:15};
const reference={...target,approval:'human-reviewed',times:[1,2,null,4,null]};
test('the independently packaged browser and Worker use identical evidence rules',()=>{
  assert.equal(readFileSync(new URL('../dist/client/reference-core.js',import.meta.url),'utf8'),readFileSync(new URL('../dist/server/reference-core.js',import.meta.url),'utf8'));
});
test('standalone breaths are null; note groups with internal breaths remain eligible',()=>{
  assert.ok(isBreath('. .'));assert.ok(!isBreath('zz.'));assert.ok(!isBreath('z.c.x'));
  assert.deepEqual(audit(reference.times,parts,15),{notes:4,breaths:1,marked:3,unresolved:1});
  assert.throws(()=>audit([1,2,3,4,null],parts,15),/breath/);
  assert.throws(()=>audit([1,1,null,4,null],parts,15),/order/);
  assert.throws(()=>audit([true,2,null,4,null],parts,15),/order/);
});
test('same recording and exact map reuse approved sparse labels without filling nulls',()=>{
  const result=analyze({reference,target});assert.equal(result.method,'exact-reference-reuse');assert.deepEqual(result.times,reference.times);
});
test('hymn, language, approval and full edition identity gate references',()=>{
  for(const change of [{hymnId:'annual/test/another'},{section:'english'},{expectedSource:source+' '},{parts:parts.map((p,i)=>i? p:{...p,font:'HazzatVFont'})}])assert.throws(()=>compatible(reference,{...target,...change}));
  assert.throws(()=>compatible({...reference,approval:'automatic'},target));
});
test('missing reference or silent audio produces no guessed alignment',()=>{
  assert.throws(()=>analyze({target}),/reference/);
  assert.throws(()=>analyze({reference,target:{...target,audioSha256:'b'.repeat(64)},pcm:new Float32Array(60000),referencePcm:new Float32Array(60000)}),/voiced audio/);
});
test('saving merges only reviewed new cues and protects existing manual starts',()=>{
  const merged=mergeReviewed([1.2,null,null,null,9],[1,2,null,4,8],['approved','approved','unreviewed','early','approved'],parts,15,'hazzat');assert.deepEqual(merged,[1.2,2,null,null,9]);
  assert.throws(()=>mergeReviewed([3],reference.times,['approved','approved','unreviewed','approved','unreviewed'],parts,15,'hazzat'),/order/);
});
test('weak acoustic correspondence is rejected rather than replaced by duration guesses',()=>{
  const r=Array.from({length:30},(_,i)=>({p:i%4,voice:1,energy:0}));
  const q=Array.from({length:30},()=>({p:30,voice:1,energy:8}));assert.throws(()=>warp(r,q),/weak/);
});
test('controlled tempo and padding transfer retains only approved cues inside confirmed phrases',()=>{
  const rate=4000,sample=t=>t<1?0:.4*Math.sin(2*Math.PI*([220,277,330,247][Math.min(3,Math.floor(t-1))])*t);
  const pcm=Float32Array.from({length:rate*7},(_,i)=>sample(i/rate));
  const targetPcm=Float32Array.from({length:rate*9},(_,i)=>sample((i/rate-.6)/1.1));
  const ref={...reference,duration:7,times:[1,2,null,3,5]},t={...target,duration:9,audioSha256:'b'.repeat(64)};
  const result=analyze({reference:ref,target:t,pcm:targetPcm,referencePcm:pcm,rate,anchors:[{reference:1,target:1.7},{reference:4,target:5}]});
  assert.equal(result.method,'constrained-reference-transfer');assert.equal(result.times[2],null);assert.equal(result.times[4],null);
  for(const i of [0,1,3])assert.ok(Math.abs(result.times[i]-(ref.times[i]*1.1+.6))<.18);
});
test('bundled Tai and Ten references match exact catalog maps and preserve approved note counts',()=>{
  const refs=JSON.parse(readFileSync(new URL('../dist/client/approved-references.json',import.meta.url)));
  assert.equal(refs.length,2);
  for(const ref of refs){const tokens=sourceParts(ref.expectedSource,'hazzat');assert.deepEqual(tokens,ref.notation);const mapped=tokens.map(glyph=>({glyph}));const result=audit(ref.times,mapped,300);assert.equal(result.marked,ref.key==='tai-shouri'?97:71);}
});
function fixture(){
  const db=new DatabaseSync(':memory:');
  for(const tag of ['0000_complete_caretaker','0001_hymn_text','0002_coptic_text','0003_section_recordings','0004_alignment_suggestions','0005_reference_alignment'])db.exec(readFileSync(new URL('../drizzle/'+tag+'.sql',import.meta.url),'utf8'));
  const wrap=(sql,values=[])=>({bind(...args){return wrap(sql,args);},async first(){return db.prepare(sql).get(...values)||null;},async all(){return {results:db.prepare(sql).all(...values)};},async run(){const r=db.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}};}});
  const env={DB:{prepare:wrap,async batch(stmts){db.exec('BEGIN');try{const out=[];for(const stmt of stmts)out.push(await stmt.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}},BUCKET:{async head(){return {};},async get(){return {body:'archive',writeHttpMetadata(h){h.set('content-type','audio/wav');}};}},ASSETS:{fetch:()=>new Response('asset')}};
  async function request(path,body,options={}){const headers=options.editor===false?{}:{'oai-authenticated-user-email':'mikailzaki48@gmail.com'};if(body)headers['content-type']='application/json';if(options.origin)headers.origin=options.origin;const response=await app.fetch(new Request('https://test.local'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined}),env);return {status:response.status,...await response.json()};}
  const row={hymn_id:target.hymnId,title:'Test',season:'annual',service:'test',owner_email:'mikailzaki48@gmail.com',status:'complete',timings_json:'[0.5,1.5]',coptic_timings_json:'[0.7,1.7]',hazzat_timings_json:'[1.2]',hazzat_line_timings_json:'[1.1]',recording_url:target.source,notation_html:source,updated_at:100,completed_at:100};
  const cols=Object.keys(row);db.prepare('INSERT INTO hymn_projects ('+cols.join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')').run(...Object.values(row));
  const api='/api/reference-alignment?hymnId='+target.hymnId;
  const create=()=>request(api,{action:'create',target,reference,times:reference.times,decisions:parts.map(()=> 'unreviewed'),method:'exact-reference-reuse',expectedUpdatedAt:100});
  return {db,request,create,api};
}
test('reference reviews require editor and same-origin writes',async()=>{
  const f=fixture();assert.equal((await f.request(f.api,null,{editor:false})).status,403);
  assert.equal((await f.request(f.api,{action:'create'},{origin:'https://elsewhere.test'})).status,403);
});
test('prepare saves review and recoverable original without changing live timings',async()=>{
  const f=fixture(),r=await f.create();assert.equal(r.status,200);assert.equal(r.draft.original.hazzat_timings_json,'[1.2]');assert.equal(f.db.prepare('SELECT status FROM hymn_projects').get().status,'complete');assert.equal((await f.request(f.api)).drafts[0].id,r.draft.id);
});
test('review feedback persists independently, including rejected and qualitative starts',async()=>{
  const f=fixture(),{draft}=await f.create();const r=await f.request(f.api,{action:'review',id:draft.id,revision:draft.revision,times:[1,2,null,null,null],decisions:['approved','early','unreviewed','rejected','unsure']});assert.equal(r.status,200);assert.equal(r.draft.decisions[1],'early');assert.equal(f.db.prepare('SELECT hazzat_timings_json FROM hymn_projects').get().hazzat_timings_json,'[1.2]');
});
test('saving approved cues creates a verified private draft preserving every other channel',async()=>{
  const f=fixture(),{draft}=await f.create();const r=await f.request(f.api,{action:'save',id:draft.id,revision:1,times:draft.times,decisions:['approved','approved','unreviewed','late','unreviewed']});assert.equal(r.status,200);assert.equal(r.project.status,'draft');assert.deepEqual(r.project.hazzatTimings,[1.2,2,null,null,null]);assert.deepEqual(r.project.hazzatLineTimings,[1.1]);assert.deepEqual(r.project.timings,[.5,1.5]);assert.deepEqual(r.project.copticTimings,[.7,1.7]);assert.equal(r.project.completedAt,null);assert.equal((await f.request(f.api)).drafts[0].savedTimes[1],2);
});
test('manual edits made after preparation block saving a stale review',async()=>{
  const f=fixture(),{draft}=await f.create();f.db.prepare("UPDATE hymn_projects SET updated_at=101,hazzat_timings_json='[1.3,2.2]'").run();const r=await f.request(f.api,{action:'save',id:draft.id,revision:1,times:draft.times,decisions:parts.map(()=> 'approved')});assert.equal(r.status,409);assert.equal(f.db.prepare('SELECT hazzat_timings_json FROM hymn_projects').get().hazzat_timings_json,'[1.3,2.2]');
});
test('edition mismatch, invalid breath and source checksum mismatch cannot create a reuse review',async()=>{
  const f=fixture(),body={action:'create',target,reference,times:reference.times,decisions:parts.map(()=> 'unreviewed'),method:'exact-reference-reuse',expectedUpdatedAt:100};
  assert.equal((await f.request(f.api,{...body,target:{...target,expectedSource:source+'new'}})).status,409);
  assert.equal((await f.request(f.api,{...body,times:[1,2,3,4,null]})).status,400);
  assert.equal((await f.request(f.api,{...body,target:{...target,audioSha256:'b'.repeat(64)}})).status,400);
});
test('a preparation based on a stale project is rejected before storing results',async()=>{
  const f=fixture();f.db.prepare('UPDATE hymn_projects SET updated_at=101').run();assert.equal((await f.create()).status,409);assert.equal(f.db.prepare('SELECT count(*) AS n FROM reference_alignment_drafts').get().n,0);
});
test('unapproved cues cannot be saved and review revisions prevent lost edits',async()=>{
  const f=fixture(),{draft}=await f.create();assert.equal((await f.request(f.api,{action:'save',id:draft.id,revision:1,times:draft.times,decisions:draft.decisions})).status,400);assert.equal((await f.request(f.api,{action:'review',id:draft.id,revision:0,times:draft.times,decisions:draft.decisions})).status,409);
});

test('automatic search separates repeat ambiguity from a distinct transformed phrase',async()=>{
  const {findPhrase}=await import('../dist/client/phrase-search.js');
  const shape=t=>({p:Math.sin(t*2.1)*3+Math.sin(t*4.7),voice:.8+.1*Math.sin(t),energy:Math.sin(t*3.2)});
  const r=Array.from({length:251},(_,i)=>({t:i*.04,...shape(i*.04)}));
  const make=repeat=>Array.from({length:1001},(_,i)=>{const t=i*.04;let x=null;if(t>=3&&t<=14)x=(t-3)/1.1;else if(repeat&&t>=23&&t<=34)x=(t-23)/1.1;return {t,...(x===null?{p:12,voice:0,energy:-2}:shape(x))};});
  const unique=findPhrase(r,make(false),[0,10],warp);assert.equal(unique.status,'candidate');assert.ok(Math.abs(unique.targetBounds[0]-3)<.4);
  const ambiguous=findPhrase(r,make(true),[0,10],warp);assert.equal(ambiguous.status,'unresolved');assert.match(ambiguous.reason,/ambiguous/);
});
test('phrase extraction respects breath and sparse evidence and never invents durations',async()=>{
  const {referencePhrases}=await import('../dist/client/phrase-search.js');
  const r={section:'hazzat',parts:['z','x','c','.','z','x','c','d','v'].map(glyph=>({glyph})),times:[1,3,5,null,7,8,null,12,16]};
  assert.deepEqual(referencePhrases(r),[{referenceBounds:[1,5],indices:[0,1,2]}]);
});
test('automatic review stores only candidates inside distinct evidenced spans',async()=>{
  const f=fixture(),t={...target,audioSha256:'b'.repeat(64)};
  const body={action:'create',expectedUpdatedAt:100,target:t,reference,times:[1,2,null,4,null],decisions:parts.map(()=> 'unreviewed'),method:'automatic-reference-transfer',diagnostics:[{status:'candidate',referenceBounds:[1,4],targetBounds:[1,4],cost:.2,edgeFraction:0,alternativeCost:null,negativeCost:.6}]};
  assert.equal((await f.request(f.api,body)).status,200);
  assert.equal((await f.request(f.api,{...body,diagnostics:[{...body.diagnostics[0],alternativeCost:.23}]})).status,400);
  assert.equal((await f.request(f.api,{...body,times:[1,2,null,5,null]})).status,400);
  assert.equal(f.db.prepare('SELECT status FROM hymn_projects').get().status,'complete');
});
test('saved approved corrections are available as sparse fingerprinted references',async()=>{
  const f=fixture(),{draft}=await f.create();
  await f.request(f.api,{action:'save',id:draft.id,revision:1,times:draft.times,decisions:['unreviewed','approved','unreviewed','late','unreviewed']});
  const data=await f.request(f.api);assert.equal(data.references.length,1);assert.deepEqual(data.references[0].times,[null,2,null,null,null]);assert.equal(data.references[0].audioSha256,target.audioSha256);
});

test('no-reference preparation records a full map with no manufactured cues',async()=>{
 const f=fixture(),body={action:'create',target,reference:null,times:parts.map(()=>null),decisions:parts.map(()=> 'unreviewed'),method:'notation-preparation',expectedUpdatedAt:100};
 assert.equal((await f.request(f.api,body)).status,200);
 assert.equal((await f.request(f.api,{...body,times:reference.times})).status,400);
 assert.equal(f.db.prepare('SELECT status FROM hymn_projects').get().status,'complete');
});
test('negative feedback withdraws recording-specific positive examples',async()=>{
 const f=fixture(),{draft}=await f.create();
 await f.request(f.api,{action:'review',id:draft.id,revision:1,times:[1,null,null,4,null],decisions:['unreviewed','rejected','unreviewed','unreviewed','unreviewed']});
 const data=await f.request(f.api);assert.deepEqual(data.exclusions[0].indices,[1]);assert.equal(data.exclusions[0].audioSha256,target.audioSha256);
});

test('analysis conversion keeps media positions and rejects frequencies above its new Nyquist limit',async()=>{
 const {analysisPcm}=await import('../dist/client/analysis-audio.js');
 const impulse=new Float32Array(16001);impulse[8000]=1;
 const down=analysisPcm(impulse);assert.equal(down.length,4001);assert.equal(down.indexOf(Math.max(...down)),2000);
 const rms=a=>Math.sqrt(a.slice(100,-100).reduce((s,x)=>s+x*x,0)/(a.length-200));
 const tone=frequency=>Float32Array.from({length:16000},(_,i)=>Math.sin(2*Math.PI*frequency*i/16000));
 assert.ok(rms(analysisPcm(tone(300)))>.65);assert.ok(rms(analysisPcm(tone(3000)))<.01);
});
