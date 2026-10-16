import { ENGINE, audit, compatible, mergeReviewed } from './reference-core.js';
import { sectionConfig, sourceParts, catalogSource } from './alignment-publish.js';

const json = (data,status=200) => Response.json(data,{status,headers:{'cache-control':'no-store'}});
const read = row => row ? { ...JSON.parse(row.payload_json), id:row.id,revision:row.revision,status:row.status } : null;
async function content(request,env,row,section,hymnId) {
  const cfg=sectionConfig(section);
  if (row[cfg.source]) return row[cfg.source];
  const [season,service,id]=hymnId.split('/');
  const response=await env.ASSETS.fetch(new Request(new URL('/catalog/'+season+'.json',request.url)));
  if (!response.ok) throw new Error('The current text or notation could not be loaded.');
  const services=await response.json();
  return catalogSource(services.find(s=>s.id===service)?.hymns?.find(h=>h.id===id),section);
}
function checkParts(parts,source,section) {
  const actual=sourceParts(source,section);
  if (!Array.isArray(parts)||!parts.length||parts.length>12000||parts.length!==actual.length) throw new Error('The current passage count differs from the review.');
  parts.forEach((p,i)=>{
    if (!p || p.glyph!==actual[i] || !['HazzatFont','HazzatVFont','CopticFont','EnglishFont'].includes(p.font) || !Number.isInteger(p.stack) || p.stack<0 || p.stack>12000 || typeof p.context!=='string' || p.context.length>4000) throw new Error('The passage map does not match this edition.');
  });
}
function checkReview(body,parts,duration,section) {
  audit(body.times,parts,duration,section);
  if (!Array.isArray(body.decisions)||body.decisions.length!==parts.length||body.decisions.some((d,i)=>!['unreviewed','approved','rejected','early','late','unsure'].includes(d) || (d==='approved'&&!Number.isFinite(body.times[i])))) throw new Error('Approve only actual note starts after checking their sung phrase.');
}

export async function referenceAlignment(request,env,hymnId,helpers) {
  const {isEditor,sameOrigin,validId,getRow,owner,projectWithMedia}=helpers;
  if (!isEditor(request)) return json({error:'Editor access required.'},403);
  if (!validId(hymnId)) return json({error:'Invalid hymn.'},400);
  if (request.method==='GET') {
    const rows=await env.DB.prepare('SELECT * FROM reference_alignment_drafts WHERE hymn_id=? ORDER BY updated_at DESC LIMIT 12').bind(hymnId).all();
    const drafts=(rows.results||[]).map(read);
    // Corrections become recording-specific examples, never model training.
    const references=drafts.filter(d=>d.status==='saved').map(d=>({
      ...d.target,key:'review-'+d.id,title:'Reviewed '+new Date(d.savedAt).toLocaleDateString('en-GB'),
      approval:'human-reviewed',provenance:'Starts explicitly approved and saved in review '+d.id,
      times:d.savedTimes.map((t,i)=>d.decisions[i]==='approved'&&!Number.isFinite(d.baseline[i])?t:null)
    })).filter(r=>r.times.some(Number.isFinite));
    const seen=new Set(),exclusions=[];
    for(const d of drafts){
      const indices=[];
      d.decisions.forEach((decision,i)=>{const key=d.target.audioSha256+':'+d.section+':'+d.target.expectedSource+':'+i;if(seen.has(key)||decision==='unreviewed')return;seen.add(key);if(['rejected','early','late','unsure'].includes(decision))indices.push(i);});
      if(indices.length)exclusions.push({audioSha256:d.target.audioSha256,section:d.section,expectedSource:d.target.expectedSource,indices});
    }
    for(const r of references)for(const e of exclusions)if(e.audioSha256===r.audioSha256&&e.section===r.section&&e.expectedSource===r.expectedSource)e.indices.forEach(i=>{r.times[i]=null;});
    return json({drafts,references:references.filter(r=>r.times.some(Number.isFinite)),exclusions});
  }
  if (!sameOrigin(request)) return json({error:'Invalid request origin.'},403);
  const raw=await request.text();
  if(raw.length>1_800_000) return json({error:'Review data is too large.'},413);
  let body;try{body=JSON.parse(raw);}catch{return json({error:'Invalid review data.'},400);}
  if (!body || typeof body!=='object') return json({error:'Invalid review data.'},400);
  const project=await getRow(env.DB,hymnId);
  if (!project || project.owner_email!==owner) return json({error:'Save this hymn before preparing a review.'},404);
  if(body.action==='create') {
    try {
      const target=body.target,reference=body.reference;
      if (!target || target.hymnId!==hymnId || !sectionConfig(target.section)) throw new Error('Choose this hymn and its language channel.');
      const cfg=sectionConfig(target.section),source=await content(request,env,project,target.section,hymnId);
      if (body.expectedUpdatedAt!==project.updated_at) return json({error:'The hymn changed during analysis. Prepare a new review to protect those edits.'},409);
      if (target.expectedSource!==source || target.source!==project[cfg.recording]) return json({error:'The recording or passage map changed. Prepare a new review.'},409);
      checkParts(target.parts,source,target.section);if(body.method!=='notation-preparation')compatible(reference,target);
      if (!/^[a-f0-9]{64}$/u.test(target.audioSha256||'')) throw new Error('The target recording fingerprint is missing.');
      checkReview(body,target.parts,target.duration,target.section);
      if (!['exact-reference-reuse','constrained-reference-transfer','automatic-reference-transfer','notation-preparation'].includes(body.method)) throw new Error('Only approved-reference reuse or phrase transfer is supported.');
      if(body.method==='notation-preparation'&&(reference!==null||body.times.some(t=>t!==null)))throw new Error('Preparation without a reviewed reference must not invent timings.');
      if (body.method==='exact-reference-reuse' && (reference.audioSha256!==target.audioSha256 || JSON.stringify(reference.times)!==JSON.stringify(body.times))) throw new Error('Exact reuse requires identical recording bytes and approved boundaries.');
      if (body.method==='constrained-reference-transfer') {
        if (!Array.isArray(body.anchors)||body.anchors.length<2||body.anchors.length>24) throw new Error('Corresponding sung phrase landmarks are required.');
        body.anchors.forEach((a,i)=>{ if(!Number.isFinite(a.reference)||!Number.isFinite(a.target)||a.reference<0||a.target<0||a.reference>=reference.duration||a.target>=target.duration||(i&&(a.reference<=body.anchors[i-1].reference||a.target<=body.anchors[i-1].target||a.reference-body.anchors[i-1].reference>90||a.target-body.anchors[i-1].target>90))) throw new Error('Invalid corresponding phrase landmarks.'); });
        body.times.forEach((t,i)=>{if(Number.isFinite(t)&&(!Number.isFinite(reference.times[i]) || !body.anchors.slice(1).some((a,k)=>reference.times[i]>=body.anchors[k].reference&&reference.times[i]<=a.reference&&t>=body.anchors[k].target&&t<=a.target+.04))) throw new Error('Candidates must come from approved notes within corresponding phrases.');});
      }
      if(body.method==='automatic-reference-transfer') {
        if(!Array.isArray(body.diagnostics)||body.diagnostics.length>49)throw new Error('Automatic search evidence is missing.');
        let previousReference=-1,previousTarget=-1;
        const ranges=body.diagnostics.filter(d=>d.status==='candidate');
        for(const d of ranges){
          const r=d.referenceBounds,t=d.targetBounds;
          if(!Array.isArray(r)||!Array.isArray(t)||r.length!==2||t.length!==2||![...r,...t].every(Number.isFinite)||r[0]<0||t[0]<0||r[1]<=r[0]||t[1]<=t[0]||r[1]>=reference.duration||t[1]>=target.duration||r[1]-r[0]>30||t[1]-t[0]>50||r[0]<previousReference||t[0]<previousTarget-.001||!Number.isFinite(d.cost)||d.cost<0||d.cost>.6||!Number.isFinite(d.edgeFraction)||d.edgeFraction<0||d.edgeFraction>.12)throw new Error('Invalid automatic phrase evidence.');
          if(d.alternativeCost!==null&&(!Number.isFinite(d.alternativeCost)||d.alternativeCost<=d.cost*1.2+.04))throw new Error('Ambiguous repeats cannot supply candidate cues.');
          if(d.negativeCost!==null&&(!Number.isFinite(d.negativeCost)||d.negativeCost<=d.cost*1.15+.04))throw new Error('Reordered phrase controls invalidate this match.');
          previousReference=r[1];previousTarget=t[1];
        }
        body.times.forEach((t,i)=>{if(Number.isFinite(t)&&(!Number.isFinite(reference.times[i])||!ranges.some(d=>reference.times[i]>=d.referenceBounds[0]&&reference.times[i]<=d.referenceBounds[1]&&t>=d.targetBounds[0]&&t<=d.targetBounds[1]+.04)))throw new Error('Automatic cues must remain inside distinct matched phrases with approved reference labels.');});
      }
      const now=Date.now(),id=crypto.randomUUID();
      const payload={engine:ENGINE,hymnId,section:target.section,target,reference,times:body.times,decisions:body.decisions,method:body.method,anchors:body.anchors||[],diagnostics:body.diagnostics||[],baseline:JSON.parse(project[cfg.times]||'[]'),original:project,expectedUpdatedAt:project.updated_at,createdAt:now};
      await env.DB.prepare("INSERT INTO reference_alignment_drafts (id,hymn_id,section,payload_json,revision,status,created_at,updated_at) VALUES (?,?,?,?,1,'review',?,?)").bind(id,hymnId,target.section,JSON.stringify(payload),now,now).run();
      return json({draft:{...payload,id,revision:1,status:'review'}});
    } catch(error) {return json({error:error.message},400);}
  }
  const row=await env.DB.prepare('SELECT * FROM reference_alignment_drafts WHERE id=? AND hymn_id=?').bind(body.id||'',hymnId).first();
  if(!row||row.revision!==body.revision) return json({error:'This review changed in another window. Reload it before saving.'},409);
  if(row.status==='saved') return json({error:'This review was already saved. Prepare a new review for further changes.'},409);
  const draft=read(row),cfg=sectionConfig(draft.section);
  const source=await content(request,env,project,draft.section,hymnId);
  if(project.updated_at!==draft.expectedUpdatedAt||project[cfg.recording]!==draft.target.source||source!==draft.target.expectedSource) return json({error:'The hymn changed since this review began. Your current manual timings are protected. Prepare a new review.'},409);
  if(!['review','save'].includes(body.action)) return json({error:'Unknown review action.'},400);
  try{checkReview(body,draft.target.parts,draft.target.duration,draft.section);}catch(error){return json({error:error.message},400);}
  const now=Math.max(Date.now(),project.updated_at+1);
  const next={...draft,times:body.times,decisions:body.decisions};delete next.id;delete next.status;delete next.revision;
  if(body.action==='review') {
    const changed=await env.DB.prepare('UPDATE reference_alignment_drafts SET payload_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(JSON.stringify(next),now,row.id,row.revision).run();
    if(changed.meta?.changes!==1)return json({error:'This review changed. Reload it.'},409);
    return json({draft:{...next,id:row.id,revision:row.revision+1,status:'review'}});
  }
  let merged;
  try {merged=mergeReviewed(draft.baseline,body.times,body.decisions,draft.target.parts,draft.target.duration,draft.section);}catch(error){return json({error:error.message},400);}
  if(!body.decisions.some((d,i)=>d==='approved'&&Number.isFinite(body.times[i])&&!Number.isFinite(draft.baseline[i]))) return json({error:'Approve at least one new cue. Existing manual timings stay unchanged.'},400);
  next.savedTimes=merged;next.savedAt=now;
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE hymn_projects SET ${cfg.times}=?,status='draft',completed_at=NULL,updated_at=? WHERE hymn_id=? AND owner_email=? AND updated_at=? AND EXISTS (SELECT 1 FROM reference_alignment_drafts WHERE id=? AND revision=? AND status='review')`).bind(JSON.stringify(merged),now,hymnId,owner,draft.expectedUpdatedAt,row.id,row.revision),
    env.DB.prepare("UPDATE reference_alignment_drafts SET payload_json=?,status='saved',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM hymn_projects WHERE hymn_id=? AND updated_at=?)").bind(JSON.stringify(next),now,row.id,row.revision,hymnId,now)
  ]);
  if(results[0].meta?.changes!==1)return json({error:'The hymn changed while saving. Reload to verify the stored draft.'},409);
  // Read back; a successful write alone is insufficient evidence of persistence.
  const persisted=await getRow(env.DB,hymnId);
  if(persisted.status!=='draft'||persisted[cfg.times]!==JSON.stringify(merged))return json({error:'Could not verify the saved draft. Reload before retrying.'},409);
  return json({draft:{...next,id:row.id,revision:row.revision+1,status:'saved'},project:await projectWithMedia(env.DB,persisted)});
}
