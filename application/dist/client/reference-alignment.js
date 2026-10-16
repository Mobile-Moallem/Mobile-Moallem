import { analysisPcm } from './analysis-audio.js';
import { ENGINE, fields, isBreath, audit, digest, compatible } from './reference-core.js';

const ui=id=>document.getElementById(id),status=message=>{ui('referenceStatus').textContent=message;};
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
const button=(label,fn)=>{const b=el('button',label,'reference-small');b.type='button';b.addEventListener('click',fn);return b;};
const channel=()=>ui('referenceSection').value;
const endpoint=h=>'/api/reference-alignment?hymnId='+encodeURIComponent(h.id);
const listenSource=source=>source.startsWith('https://media.tasbeha.org/mp3/')?'/api/listen-audio?url='+encodeURIComponent(source):source;
let shownId='',draft=null,refs=[],savedRefs=[],exclusions=[],imported=null,anchors=[],busy=false,dirty=false,sequence=0,clipStop=null,worker=null;
const sessions=new Map();
function keepSession(){if(draft)sessions.set(draft.hymnId+':'+draft.section,{draft,dirty});}
const labels={hazzat:'Hazzat',coptic:'Coptic words',english:'English words'};
function mapFor(h,section,sourceOverride) {
  const expectedSource=sourceOverride??(section==='hazzat'?hazzatHtml(h):section==='coptic'?hymnCopticText(h):hymnText(h));
  if(!expectedSource)throw new Error('Add this channel’s text or notation first. Scanned scores need a passage map before reference matching.');
  let parts;
  if(section==='hazzat') {
    const map=safeHazzat(expectedSource,{...h});
    const lyricNodes=[...map.querySelectorAll('.CopticFont')];
    const printed=lyricNodes.map(n=>n.textContent).join(''),lyric=hymnCopticText(h),writtenWords=words(lyric);
    const exactAttachment=Boolean(lyric)&&printed.replace(/\s/gu,'')===lyric.replace(/\s/gu,'');
    const ends=[];let total=0;writtenWords.forEach(w=>{total+=w.length;ends.push(total);});
    let cursor=0,pending='';parts=[];
    for(const node of map.querySelectorAll('.CopticFont,.hazza-mark')) {
      if(node.classList.contains('CopticFont')){const fragment=node.textContent.replace(/\s/gu,'');cursor+=fragment.length;pending+=fragment;continue;}
      const i=Number(node.dataset.position),glyph=node.textContent.trim(),font=node.firstElementChild.className;
      const wi=exactAttachment&&cursor?ends.findIndex(end=>end>=cursor):-1;
      const context=wi>=0?writtenWords.slice(Math.max(0,wi-1),wi+2).join(' '):[...node.closest('.hazzat-stack').querySelectorAll('.CopticFont')].map(n=>n.textContent).join('');
      const previous=parts[parts.length-1];
      parts.push({index:i,glyph,font,stack:Number(node.closest('.hazzat-stack').dataset.position),word:wi>=0?writtenWords[wi]:'',context,printedFragment:pending||previous?.printedFragment||'',attachment:exactAttachment?'exact-printed-word':'printed-fragment-only',continuesPrevious:!pending,breath:isBreath(glyph),wordIndex:wi});
      pending='';
    }
    if(parts.some((p,i)=>p.index!==i))throw new Error('The passage order could not be checked.');
  } else {
    const list=words(expectedSource);
    parts=list.map((glyph,index)=>({index,glyph,font:section==='coptic'?'CopticFont':'EnglishFont',stack:Math.floor(index/6),context:list.slice(Math.max(0,index-2),index+3).join(' '),word:glyph,breath:false}));
  }
  if(!parts.length)throw new Error('This channel has no selectable parts.');
  return {engine:ENGINE,hymnId:h.id,section,expectedSource,parts,source:audioFor(h,section)};
}
async function audio(source,decode=true) {
  if(!source||(!source.startsWith('/api/media/recordings/')&&!source.startsWith('https://media.tasbeha.org/mp3/')))throw new Error('Choose an uploaded recording or a supported library recording.');
  const url=source.startsWith('https://')?'/api/analysis-audio?url='+encodeURIComponent(source):source;
  const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error('The recording could not load. Check that you can play it.');
  const bytes=await response.arrayBuffer();if(bytes.byteLength>100_000_000)throw new Error('Use a recording smaller than 100 MB.');
  const audioSha256=await digest(bytes);
  const context=new (window.AudioContext||window.webkitAudioContext)({sampleRate:16000});
  try {
    const buffer=await context.decodeAudioData(bytes);
    if(buffer.duration>3600)throw new Error('Use a recording shorter than one hour.');
    if(!decode)return {audioSha256,duration:buffer.duration};
    const renderer=new OfflineAudioContext(1,Math.ceil(buffer.duration*16000),16000),sourceNode=renderer.createBufferSource();
    sourceNode.buffer=buffer;sourceNode.connect(renderer.destination);sourceNode.start();
    return {audioSha256,duration:buffer.duration,pcm:analysisPcm((await renderer.startRendering()).getChannelData(0))};
  } finally {await context.close();}
}
function download(value,name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function post(h,body) {
  const response=await fetch(endpoint(h),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),data=await response.json();
  if(!response.ok)throw new Error(data.error||'Could not save this review.');return data;
}
function stopPreview() {
  ui('referenceReviewAudio').pause();ui('referenceListen').pause();clipStop=null;
  document.querySelectorAll('.reference-active,.reference-note-active').forEach(n=>n.classList.remove('reference-active','reference-note-active'));
}
function highlight() {
  if(!draft||current()?.id!==draft.hymnId||aligning)return;
  const time=ui('referenceReviewAudio').currentTime;let index=-1;
  draft.times.forEach((t,i)=>{if(Number.isFinite(t)&&t<=time)index=i;});
  ui('referenceReview').querySelectorAll('[data-reference-index]').forEach(n=>n.classList.toggle('reference-active',Number(n.dataset.referenceIndex)===index));
  const kind=view==='hazzat'?'hazzat':textLanguage;
  if(kind===draft.section)$('readerContent').querySelectorAll(kind==='hazzat'?'.hazza-mark':'.word').forEach(n=>n.classList.toggle('reference-note-active',Number(n.dataset.position)===index));
  if(clipStop!==null&&time>=clipStop){ui('referenceReviewAudio').pause();clipStop=null;}
}
async function listen(indices) {
  if(!draft)return;
  const finite=indices.map(i=>draft.times[i]).filter(Number.isFinite);if(!finite.length)return;
  aligning=false;pausePlayers();view=draft.section==='hazzat'?'hazzat':'words';if(view==='words')textLanguage=draft.section;renderReader();
  const player=ui('referenceReviewAudio');player.hidden=false;
  const url=listenSource(draft.target.source);
  if(player.getAttribute('src')!==url||player.readyState<1){
    player.src=url;
    await new Promise((resolve,reject)=>{
      const finish=error=>{clearTimeout(timer);player.removeEventListener('loadedmetadata',loaded);player.removeEventListener('error',failed);error?reject(error):resolve();};
      const loaded=()=>finish(),failed=()=>finish(new Error('The review recording could not load.'));
      const timer=setTimeout(()=>finish(new Error('The review recording is taking too long. Try its Play control, then Listen again.')),20000);
      player.addEventListener('loadedmetadata',loaded,{once:true});player.addEventListener('error',failed,{once:true});player.load();
    });
  }
  player.playbackRate=players[draft.section].playbackRate;
  player.currentTime=Math.max(0,finite[0]-1.5);clipStop=Math.min(draft.target.duration,finite[finite.length-1]+4);
  await player.play();highlight();
}
function renderPhrases() {
  const box=ui('referencePhrases');box.replaceChildren();
  for(let i=1;i<anchors.length;i++) {
    const p=el('div','Reference '+clipTimeText(anchors[i-1].reference)+'–'+clipTimeText(anchors[i].reference)+' · Current '+clipTimeText(anchors[i-1].target)+'–'+clipTimeText(anchors[i].target),'reference-phrase');box.append(p);
  }
  if(anchors.length)box.append(button('Clear phrase ranges',()=>{anchors=[];renderPhrases();}));
}
function refreshChoices(h) {
  const select=ui('referencePicker'),value=select.value;select.replaceChildren(new Option('Automatically choose the best reviewed reference',''));
  for(const ref of [...refs,...savedRefs].filter(r=>r.hymnId===h.id&&r.section===channel()))select.add(new Option(ref.title+' · approved starts',ref.key));
  if(imported?.hymnId===h.id&&imported.section===channel())select.add(new Option('Imported reviewed reference','imported'));
  if([...select.options].some(o=>o.value===value))select.value=value;
  else select.value='';
  const ref=select.value==='imported'?imported:[...refs,...savedRefs].find(r=>r.key===select.value);
  if(ref)ui('referenceListen').src=listenSource(ref.source);
  else ui('referenceListen').removeAttribute('src');
}
function render() {
  const box=ui('referenceReview');box.replaceChildren();if(!draft)return;
  const {parts,duration}=draft.target,summary=audit(draft.times,parts,duration,draft.section);
  box.append(el('p',summary.marked+' proposed starts · '+summary.unresolved+' unresolved · '+summary.breaths+' untimed breaths. '+(draft.method==='notation-preparation'?'Passage map prepared; a reviewed musical reference is unavailable.':draft.method==='exact-reference-reuse'?'Approved starts reused from the same recording.':'Matched candidates need phrase and note-start review.')));
  if(draft.method==='automatic-reference-transfer'){
    const evidence=el('details',null,'reference-group');evidence.append(el('summary','Automatic phrase search evidence'));
    for(const d of draft.diagnostics){const range=d.referenceBounds?.map(clipTimeText).join('–')||'';evidence.append(el('p',d.status==='candidate'?'Reference '+range+' → current '+d.targetBounds.map(clipTimeText).join('–')+' · candidate only; syllable identity unverified.':'Reference '+range+' · unresolved: '+d.reason));}
    box.append(evidence);
  }
  if(draft.status==='saved')box.append(el('p','Reviewed cues saved as a private draft. Existing manual cues and other channels were preserved.'));
  const groups=[];
  parts.forEach((p,i)=>{let g=groups[groups.length-1];if(!g||g.stack!==p.stack||g.indices.length>=8){g={stack:p.stack,indices:[]};groups.push(g);}g.indices.push(i);});
  for(const group of groups) {
    const indices=group.indices,card=el('details',null,'reference-group'),first=parts[indices[0]];card.open=groups.length<4;
    card.append(el('summary',(draft.section==='hazzat'?'Passages ':'Words ')+(indices[0]+1)+'–'+(indices[indices.length-1]+1)));
    const context=el('p',first.context||'No printed Coptic attachment is available in this map. Review with the surrounding notation.',first.font==='EnglishFont'?'reference-context':'reference-context CopticFont');card.append(context);
    if(draft.section==='hazzat')card.append(el('small','Printed attachment helps identify the phrase; it does not verify what is sung.'));
    const groupActions=el('div',null,'reference-actions');
    groupActions.append(button('Listen with context',()=>void listen(indices).catch(e=>status(e.message))),button('Approve these starts',()=>{
      indices.forEach(i=>{if(Number.isFinite(draft.times[i])&&!Number.isFinite(draft.baseline[i]))draft.decisions[i]='approved';});dirty=true;render();status('Starts approved for this group. Save your review or save the reviewed cues as a private draft.');
    }));card.append(groupActions);
    for(const i of indices) {
      const part=parts[i],row=el('div',null,'reference-row');row.dataset.referenceIndex=String(i);
      const glyph=el('span',part.glyph,part.font+' reference-glyph');row.append(glyph);
      if(part.word||part.printedFragment)row.append(el('span',part.word||part.printedFragment,part.font==='EnglishFont'?'reference-context':'CopticFont reference-context'));
      if(part.attachment==='printed-fragment-only')row.append(el('small','Printed fragment only — the Words text differs from this notation edition.'));
      if(part.breath){row.append(el('small','Breath — always untimed.'));card.append(row);continue;}
      if(Number.isFinite(draft.baseline[i])){row.append(el('small','Existing manual start '+clipTimeText(draft.baseline[i])+' — kept unchanged.','reference-original'));card.append(row);continue;}
      const label=el('label','Start (seconds)'),input=el('input');input.type='number';input.step='.001';input.min='0';input.max=String(duration-.001);input.value=Number.isFinite(draft.times[i])?String(draft.times[i]):'';input.setAttribute('aria-label',labels[draft.section]+' part '+(i+1)+' start in seconds');
      input.addEventListener('change',()=>{draft.times[i]=input.value===''?null:Number(input.value);draft.decisions[i]='unreviewed';dirty=true;status('Start changed. Check its phrase and note onset, then approve it.');});label.append(input);row.append(label);
      row.append(el('small',Number.isFinite(draft.times[i])?(draft.decisions[i]==='approved'?'Approved by you':draft.decisions[i]==='unreviewed'?'Needs musical review':draft.decisions[i]):'Unresolved — no timing invented.'));
      const controls=el('div',null,'reference-actions');
      controls.append(button('Listen',()=>void listen([i]).catch(e=>status(e.message))),button('Use player time',()=>{draft.times[i]=Math.round(ui('referenceReviewAudio').currentTime*1000)/1000;draft.decisions[i]='unreviewed';dirty=true;render();}),button('Right',()=>{if(!Number.isFinite(draft.times[i])){status('Set an exact start before approving it.');return;}draft.decisions[i]='approved';dirty=true;render();}));
      for(const [name,decision]of[['Too early','early'],['Too late','late'],['Wrong notes / part','rejected'],['Not sure','unsure']])controls.append(button(name,()=>{draft.decisions[i]=decision;if(decision==='rejected')draft.times[i]=null;dirty=true;render();}));
      row.append(controls);card.append(row);
    }
    box.append(card);
  }
  const footer=el('div',null,'reference-save'),actions=el('div',null,'reference-actions');
  if(draft.status!=='saved')actions.append(button('Save review progress',()=>void persist(false)),button('Save reviewed cues to private draft',()=>void persist(true)));
  actions.append(button('Download review and original',()=>download(draft,'alignment-review-'+draft.section+'.json')));footer.append(actions);box.append(footer);
}
async function persist(apply) {
  if(!draft||busy||current()?.id!==draft.hymnId)return;busy=true;status('Saving and checking stored data…');
  try {
    const h=current();if(h.dirty||autosaveTimer||savePromise)throw new Error('Manual changes are pending. Save them, then prepare a new review.');
    const data=await post(h,{action:apply?'save':'review',id:draft.id,revision:draft.revision,times:draft.times,decisions:draft.decisions});
    draft=data.draft;dirty=false;
    if(data.project){const keep=draft;applyProject(h,data.project);draft=keep;}
    render();status(apply?'Reviewed cues saved and read back as a private draft. Choose Complete for listeners only after you approve the whole hymn.':'Review progress saved online. Hymn timings have not changed.');
  }catch(error){status(error.message+' Reload the saved review before retrying an uncertain write.');}finally{busy=false;}
}
async function reference(h,target) {
  const key=ui('referencePicker').value;
  const pool=[...refs,...savedRefs,...(imported?[{...imported,key:'imported'}]:[])].filter(r=>r.hymnId===h.id&&r.section===channel()&&r.expectedSource===target.expectedSource);
  const choices=key?pool.filter(r=>r.key===key):pool.sort((a,b)=>Number(b.source===target.source)-Number(a.source===target.source)||b.times.filter(Number.isFinite).length-a.times.filter(Number.isFinite).length);
  if(!choices.length)return null;
  const ready=[];let failure;
  for(const ref of choices){
    try{
      const decoded=ref.source===target.source?target:await audio(ref.source);
      if(ref.audioSha256&&decoded.audioSha256!==ref.audioSha256)throw new Error('The reference recording bytes changed.');
      const map=mapFor(h,channel(),ref.expectedSource),value={...ref,...map,source:ref.source,times:ref.times,approval:ref.approval,duration:decoded.duration,audioSha256:decoded.audioSha256,pcm:decoded.pcm};
      value.times=[...value.times];for(const e of exclusions)if(e.audioSha256===value.audioSha256&&e.section===value.section&&e.expectedSource===value.expectedSource)e.indices.forEach(i=>{value.times[i]=null;});
      compatible(value,target);
      if(value.audioSha256===target.audioSha256)return value;
      ready.push(value);
    }catch(error){failure=error;}
  }
  if(ready.length)return ready[0];throw failure||new Error('No usable reviewed recording could be loaded.');
}
async function prepare() {
  if(busy||!current())return;busy=true;ui('referencePrepare').disabled=true;status('Checking the reference, passage map, and recordings…');
  const h=current(),hymnId=h.id;
  try {
    if(dirty)throw new Error('Save your current review progress before preparing another one.');
    if(h.dirty||autosaveTimer||savePromise){
      clearTimeout(autosaveTimer);autosaveTimer=null;
      if(!await saveDraft(h))throw new Error('Your manual hymn edits could not be saved.');
    }
    let before=await fetch('/api/project?hymnId='+encodeURIComponent(h.id),{cache:'no-store'}).then(r=>r.json());
    if(!before.project){
      if(!await saveDraft(h))throw new Error('Save the hymn before analyzing.');
      before=await fetch('/api/project?hymnId='+encodeURIComponent(h.id),{cache:'no-store'}).then(r=>r.json());
    }
    if(!before.project)throw new Error('The saved project could not be checked.');
    const latest=await fetch(endpoint(h),{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Reviewed examples could not load.');return r.json();});savedRefs=latest.references||[];exclusions=latest.exclusions||[];refreshChoices(h);
    const map=mapFor(h,channel()),decoded=await audio(map.source),target={...map,duration:decoded.duration,audioSha256:decoded.audioSha256};
    const ref=await reference(h,{...target,pcm:decoded.pcm});
    if(current()?.id!==hymnId)throw new Error('The selected hymn changed.');
    status(!ref?'Preparing the complete passage map and recording identity…':ref.audioSha256===target.audioSha256?'Reusing approved starts after exact recording and map checks…':anchors.length?'Comparing the selected corresponding phrases…':'Finding candidate phrases across the recording and checking repeats and reordered controls…');
    const result=ref?await new Promise((resolve,reject)=>{
      worker=new Worker('/reference-worker.js',{type:'module'});
      const timer=setTimeout(()=>{worker.terminate();worker=null;reject(new Error('Matching took too long. Try a shorter phrase.'));},180000);
      const end=()=>{clearTimeout(timer);worker?.terminate();worker=null;};
      worker.onmessage=event=>{end();event.data.error?reject(new Error(event.data.error)):resolve(event.data.result);};
      worker.onerror=()=>{end();reject(new Error('Matching could not finish. Try a shorter phrase.'));};
      const {pcm:referencePcm,...approved}=ref;
      worker.postMessage({reference:approved,target,pcm:decoded.pcm,referencePcm,rate:4000,anchors});
    }):{times:target.parts.map(()=>null),method:'notation-preparation',diagnostics:[],message:'Prepared the full passage and printed-word map. No reviewed reference matches this hymn and edition; acoustic features cannot identify its sung syllables. No timing guesses were added.'};
    if(current()?.id!==hymnId)throw new Error('The selected hymn changed.');
    const {pcm,...approved}=ref||{};
    const created=await post(h,{action:'create',expectedUpdatedAt:before.project.updatedAt,target,reference:ref?approved:null,...result,anchors,decisions:target.parts.map(()=> 'unreviewed')});
    draft=created.draft;dirty=false;render();status(result.message+' Review is saved online; hymn timings stay unchanged until you save reviewed cues.');
  }catch(error){status(error.message);}finally{busy=false;ui('referencePrepare').disabled=false;}
}
async function load(h) {
  if(!canEdit||!h)return;
  const seq=++sequence,newHymn=shownId!==h.id;
  if(newHymn){keepSession();stopPreview();draft=null;dirty=false;anchors=[];imported=null;shownId=h.id;ui('referenceAttestation').checked=false;ui('referenceSection').value=view==='hazzat'?'hazzat':textLanguage;renderPhrases();const session=sessions.get(h.id+':'+channel());if(session){draft=session.draft;dirty=session.dirty;render();}}
  try {
    if(!refs.length)refs=await fetch('/approved-references.json').then(r=>r.json());
    if(seq!==sequence||current()?.id!==h.id)return;refreshChoices(h);
    {const response=await fetch(endpoint(h),{cache:'no-store'});if(!response.ok)throw new Error('Saved reviews could not load.');const data=await response.json();if(seq!==sequence||current()?.id!==h.id)return;savedRefs=data.references||[];exclusions=data.exclusions||[];refreshChoices(h);if(newHymn||!draft){draft=data.drafts.find(d=>d.section===channel())||null;render();}}
    if(!busy&&!dirty)status(draft?(draft.status==='saved'?'Saved private-draft review loaded. Existing manual cues were kept.':'Saved review loaded. Check the sung phrases and exact starts before saving cues.'):'Ready to automatically select a compatible reviewed reference and find candidate phrases. Start Auto align to prepare a review.');
  }catch(error){status(error.message);}
}
ui('referencePrepare').addEventListener('click',()=>void prepare());
ui('referenceSection').addEventListener('change',()=>{if(dirty){status('Save the current review before changing channels.');ui('referenceSection').value=draft.section;return;}keepSession();const session=sessions.get(current().id+':'+channel());draft=session?.draft||null;dirty=session?.dirty||false;anchors=[];renderPhrases();refreshChoices(current());render();void load(current());});
ui('referencePicker').addEventListener('change',()=>{anchors=[];renderPhrases();refreshChoices(current());});
ui('referenceAddPhrase').addEventListener('click',()=>{
  const a={reference:parseClipTime(ui('referenceStart').value),target:parseClipTime(ui('referenceTargetStart').value)},b={reference:parseClipTime(ui('referenceEnd').value),target:parseClipTime(ui('referenceTargetEnd').value)};
  if(![a.reference,a.target,b.reference,b.target].every(Number.isFinite)||a.reference<0||a.target<0||b.reference<=a.reference||b.target<=a.target||b.reference-a.reference>90||b.target-a.target>90){status('Enter the beginning and end of the same phrase, up to 90 seconds long.');return;}
  if(anchors.length){const last=anchors[anchors.length-1];if(Math.abs(last.reference-a.reference)>.001||Math.abs(last.target-a.target)>.001){status('The next phrase must start at the previous ending. For a separate section, prepare a separate review.');return;}anchors.push(b);}else anchors=[a,b];renderPhrases();
});
ui('referenceExport').addEventListener('click',async()=>{
  if(busy||!current())return;
  if(!ui('referenceAttestation').checked){status('Confirm that you checked the sung phrases and exact starts before exporting a reference.');return;}
  busy=true;status('Fingerprinting the reviewed recording…');
  try{const h=current(),map=mapFor(h,channel()),data=await audio(map.source,false);const times=map.parts.map((p,i)=>p.breath?null:Number.isFinite(h[fields[channel()]]?.[i])?h[fields[channel()]][i]:null);audit(times,map.parts,data.duration,map.section);if(!times.some(Number.isFinite))throw new Error('This channel has no reviewed manual starts to keep.');imported={...map,...data,title:h.name,times,approval:'human-reviewed',provenance:'Editor explicitly confirmed sung-phrase identity and exact starts.'};download(imported,'reviewed-reference-'+map.section+'.json');refreshChoices(h);ui('referencePicker').value='imported';status('Reviewed reference downloaded. Keep it before choosing another performance.');}catch(error){status(error.message);}finally{busy=false;}
});
ui('referenceImport').addEventListener('change',async event=>{
  try{const file=event.target.files[0];if(!file)return;if(file.size>1_500_000)throw new Error('This reference is too large.');const value=JSON.parse(await file.text()),target=mapFor(current(),channel());compatible(value,{...target,duration:value.duration});if(typeof value.source!=='string'||(!value.source.startsWith('/api/media/recordings/')&&!value.source.startsWith('https://media.tasbeha.org/mp3/')))throw new Error('This reference recording source is unsupported.');imported=value;refreshChoices(current());ui('referencePicker').value='imported';ui('referenceListen').src=listenSource(value.source);status('Reviewed reference loaded. Recording and edition checks run before reuse or transfer.');}catch(error){status(error.message);}finally{event.target.value='';}
});
ui('referenceReviewAudio').addEventListener('timeupdate',highlight);
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
globalThis.AlignmentReview={load,stopPreview,syncChannel:()=>{if(!draft&&!busy){ui('referenceSection').value=view==='hazzat'?'hazzat':textLanguage;anchors=[];renderPhrases();refreshChoices(current());}},leave:()=>{sequence++;keepSession();stopPreview();shownId='';draft=null;dirty=false;render();}};
if(typeof current==='function'&&current())void load(current());
