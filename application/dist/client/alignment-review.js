/* Private, durable upload suggestions. Timing arrays change only on explicit acceptance. */
(() => {
  const jobs=new Map(),active=new Set(),edits=new Map();
  let shown=null,preview=null,chain=Promise.resolve(),loadSequence=0;
  const names={hazzat:'Hazzat',english:'English words',coptic:'Coptic words'};
  const api=id=>'/api/alignment-suggestions?hymnId='+encodeURIComponent(id);
  const button=(text,action,cls='button button-outline')=>{const b=document.createElement('button');b.type='button';b.className=cls;b.textContent=text;b.addEventListener('click',action);return b;};
  const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
  function partsFor(h,kind){
    if(kind==='hazzat'){
      const html=hazzatHtml(h);
      if(!html)return [];
      return [...safeHazzat(html,{...h}).querySelectorAll('.hazza-mark')].map((mark,i)=>({
        label:'Piece '+(i+1), glyph:(mark.dataset.glyph??mark.textContent.trim()).slice(0,1900),
        font:mark.dataset.font||(mark.querySelector('.HazzatVFont')?'HazzatVFont':'HazzatFont'),
        stack:Number(mark.closest('.hazzat-stack').dataset.position),
        weight:Math.max(1,Array.from(mark.textContent.trim()).length),
      }));
    }
    return words(kind==='coptic'?hymnCopticText(h):hymnText(h)).map(word=>({label:word.slice(0,2000),weight:Math.max(1,Array.from(word.replace(/[^\p{L}]/gu,'')).length/3)}));
  }
  async function signature(parts){
    const data=new TextEncoder().encode(JSON.stringify(parts));
    const hash=await crypto.subtle.digest('SHA-256',data);
    return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  function setJob(job){
    const list=jobs.get(job.hymnId)||[];const at=list.findIndex(x=>x.section===job.section);
    if(at<0)list.push(job);else list[at]=job;jobs.set(job.hymnId,list);return job;
  }
  async function action(job,verb,body={}){
    const response=await fetch(api(job.hymnId),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:job.id,version:job.version,action:verb,...body})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Could not save the suggestion. Your edits are still here.');
    setJob(result.suggestion);return result;
  }
  function showError(error){$('suggestionStatus').textContent=error.message||'Could not save. Please try again.';}
  function stopPreview(){
    preview=null;document.querySelectorAll('.suggestion-active').forEach(e=>e.classList.remove('suggestion-active'));
  }
  function highlight(){
    if(!preview||current()?.id!==preview.hymnId||aligning)return;
    const kind=view==='hazzat'?'hazzat':textLanguage;if(kind!==preview.section)return;
    const time=players[kind].currentTime;let index=-1;
    preview.times.forEach((t,i)=>{if(t<=time)index=i;});
    const parts=[...$('readerContent').querySelectorAll(kind==='hazzat'?'.hazza-mark':'.word')];
    parts.forEach((part,i)=>part.classList.toggle('suggestion-active',i===index));
  }
  function check(job,index,times){
    if(current()?.id!==job.hymnId)return;
    aligning=false;view=job.section==='hazzat'?'hazzat':'words';if(view==='words')textLanguage=job.section;
    renderReader();preview={...job,times};
    const parts=$('readerContent').querySelectorAll(job.section==='hazzat'?'.hazza-mark':'.word');
    parts[index]?.scrollIntoView({block:'center',behavior:'smooth'});
    playFrom(times[index],job.section);highlight();
  }
  function render(){
    if(!canEdit||!shown||current()?.id!==shown.id)return;
    const hymn=shown;
    const list=$('suggestionList');list.replaceChildren();
    const all=jobs.get(shown.id)||[];
    $('suggestionStatus').textContent=all.length?'Suggestions are saved online.':'Upload a new recording to create a suggestion. Manual alignment is available above.';
    for(const job of all){
      const card=el('details',null,'suggestion-card');card.open=job.status==='pending'||active.has(job.id);
      card.append(el('summary',names[job.section]+' · '+({queued:active.has(job.id)?'Preparing…':'Waiting to prepare',needs_content:'Add content',pending:'Ready to review',accepted:'Accepted',rejected:'Rejected',failed:'Needs attention'}[job.status]||job.status)));
      if(['queued','needs_content','failed'].includes(job.status)){
        card.append(el('p',job.status==='needs_content'?'Add this section’s words or Hazzat. Its suggestion will start after the content saves.':job.status==='failed'?job.message:'Analyzing the recording. Keep this page open until the suggestion is saved. If you leave, it resumes when you return to this hymn.','panel-copy'));
        if(job.status==='failed')card.append(button('Try again',()=>retry(job)));
      }
      if(job.status==='accepted')card.append(el('p','Accepted into your hymn draft. You can continue manual alignment, then choose Complete for listeners.','panel-copy'));
      if(job.status==='rejected'){card.append(el('p','Suggestion rejected. Manual timings were kept.','panel-copy'));card.append(button('Prepare again',()=>retry(job)));}
      if(job.section==='hazzat'&&job.granularity!=='piece'&&job.status==='accepted')card.append(button('Guess each Hazzat piece',()=>enqueue(hymn,job)));
      if(job.status==='pending'&&job.section==='hazzat'&&job.granularity!=='piece')card.append(el('p','Preparing a separate guess for each Hazzat piece…','panel-copy'));
      if(job.status==='pending'&&(job.section!=='hazzat'||job.granularity==='piece')){
        card.append(el('p',job.method==='reference'?'Matched with the earlier aligned recording. Review before accepting.':'Estimated alignment — review closely.','suggestion-method'));
        card.append(el('p',job.message,'panel-copy'));
        card.append(el('p',job.parts.length+' individual '+(job.section==='hazzat'?'pieces':'words')+' to review.','panel-copy'));
        const editor=edits.get(job.id)||{times:[...job.times],dirty:false};edits.set(job.id,editor);
        const status=el('p',editor.dirty?'Changes not saved yet.':'Saved online.','panel-copy');status.setAttribute('role','status');
        const rows=el('div',null,'suggestion-rows');
        job.parts.forEach((part,index)=>{
          const row=el('div',null,'suggestion-row');const label=el('label',part.label);
          if(job.section==='hazzat'&&part.glyph)label.append(el('span',part.glyph,part.font==='HazzatVFont'?'HazzatVFont suggestion-glyph':'HazzatFont suggestion-glyph'));
          const input=el('input');input.type='number';input.min='0';input.max=String(Math.max(0,job.duration-.01));input.step='.01';input.value=String(editor.times[index]);input.setAttribute('aria-label',names[job.section]+' part '+(index+1)+' start in seconds');
          const change=()=>{editor.times[index]=input.value===''?NaN:Number(input.value);editor.dirty=true;status.textContent='Changes not saved yet. Use Save changes or Accept.';if(preview?.id===job.id)preview.times=editor.times;};
          input.addEventListener('input',change);
          label.append(input,el('small','seconds'));
          row.append(label,button('Listen',()=>{if(Number.isFinite(editor.times[index]))check(job,index,editor.times);},'suggestion-small'),button('Use player time',()=>{input.value=players[job.section].currentTime.toFixed(2);change();},'suggestion-small'));
          rows.append(row);
        });
        const controls=el('div',null,'suggestion-actions');
        const save=async verb=>{
          controls.querySelectorAll('button').forEach(b=>b.disabled=true);
          try{
            if(!editor.times.every((t,i)=>Number.isFinite(t)&&t>=0&&t<job.duration&&(!i||t>=editor.times[i-1])))throw new Error('Keep times in order and inside the recording.');
            if(hymn.dirty||autosaveTimer||savePromise){clearTimeout(autosaveTimer);autosaveTimer=null;if(!await saveDraft(hymn))throw new Error('Save your hymn edits before accepting.');}
            const sig=await signature(partsFor(hymn,job.section));
            const result=await action(job,verb,{times:editor.times,signature:sig});
            edits.delete(job.id);stopPreview();if(result.project)applyProject(hymn,result.project);render();
          }catch(error){status.textContent=error.message;controls.querySelectorAll('button').forEach(b=>b.disabled=false);}
        };
        controls.append(button('Save changes',()=>save('edit')),button('Accept',()=>save('accept'),'button button-gold'),button('Reject',async()=>{
          controls.querySelectorAll('button').forEach(b=>b.disabled=true);
          try{await action(job,'reject');edits.delete(job.id);stopPreview();render();}catch(error){status.textContent=error.message;controls.querySelectorAll('button').forEach(b=>b.disabled=false);}
        }));
        card.append(rows,status,controls);
      }
      list.append(card);
    }
  }
  async function retry(job){try{await action(job,'retry');await load(shown);}catch(error){showError(error);}}
  async function decode(source){
    const url=source.startsWith('/api/media/')?source:source.startsWith('https://media.tasbeha.org/mp3/')?'/api/analysis-audio?url='+encodeURIComponent(source):null;
    if(!url)throw new Error('This recording source cannot be read. Upload an MP3, WAV, or M4A.');
    const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(90000)});
    if(!response.ok)throw new Error('The recording could not load. Your upload is saved; try preparing it again.');
    const bytes=await response.arrayBuffer();if(bytes.byteLength>100_000_000)throw new Error('This recording exceeds the 100 MB analysis limit.');
    const context=new (window.AudioContext||window.webkitAudioContext)();
    try{
      const buffer=await context.decodeAudioData(bytes);
      if(buffer.duration>3600)throw new Error('Please split recordings longer than one hour before aligning.');
      const renderer=new OfflineAudioContext(1,Math.ceil(buffer.duration*4000),4000);
      const source=renderer.createBufferSource();source.buffer=buffer;source.connect(renderer.destination);source.start();
      return (await renderer.startRendering()).getChannelData(0);
    }catch(error){if(error.name==='EncodingError')throw new Error('This audio format could not be decoded. Try an MP3, WAV, or M4A.');throw error;}
    finally{await context.close().catch(()=>{});}
  }
  function analyze(payload){return new Promise((resolve,reject)=>{
    const worker=new Worker('/alignment-worker.js');
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('Analysis took too long. Your recording is saved; try again.'));},180000);
    const finish=()=>{clearTimeout(timer);worker.terminate();};
    worker.onmessage=event=>{finish();event.data.error?reject(new Error(event.data.error)):resolve(event.data.result);};
    worker.onerror=()=>{finish();reject(new Error('Analysis could not finish. Try again.'));};
    worker.postMessage(payload,[payload.pcm.buffer,...(payload.reference?.pcm?[payload.reference.pcm.buffer]:[])]);
  });}
  function enqueue(h,job){
    if(active.has(job.id))return;active.add(job.id);render();
    chain=chain.catch(()=>{}).then(async()=>{
      let latest=(jobs.get(h.id)||[]).find(x=>x.id===job.id)||job;
      try{
        if(audioFor(h,job.section)!==job.source)return;
        if(job.section==='hazzat'&&latest.granularity!=='piece'&&['pending','accepted'].includes(latest.status))latest=(await action(latest,'refine')).suggestion;
        const parts=partsFor(h,job.section),sig=await signature(parts);
        latest=(await action(latest,'prepare',{parts,signature:sig,granularity:job.section==='hazzat'?'piece':'word'})).suggestion;render();
        if(!parts.length)return;
        const pcm=await decode(latest.source);
        let reference=null;
        if(latest.reference?.source&&latest.reference.times?.length===parts.length&&latest.reference.times.every(Number.isFinite)){
          try{reference={pcm:await decode(latest.reference.source),times:latest.reference.times};}catch{/* Still save a labelled estimate if the reference is unavailable. */}
        }
        const result=await analyze({pcm,rate:4000,parts,reference});
        await action(latest,'result',result);edits.delete(latest.id);
      }catch(error){
        try{await action(latest,'fail',{message:error.message});}catch{if(shown?.id===h.id)showError(error);}
      }finally{active.delete(job.id);render();}
    });
  }
  async function load(h){
    if(!canEdit||!h)return;
    const seq=++loadSequence;
    try{
      const response=await fetch(api(h.id),{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load suggestions.');
      // Do not regress an in-flight version with an older GET response.
      const previous=jobs.get(h.id)||[];
      const merged=data.suggestions.map(job=>{const prior=previous.find(x=>x.id===job.id);return prior?.version>job.version?prior:job;});
      jobs.set(h.id,merged);
      if(current()?.id===h.id&&seq===loadSequence){shown=h;render();}
      for(const job of merged)if((job.status==='pending'&&job.section==='hazzat'&&job.granularity!=='piece')||job.status==='queued'||(job.status==='needs_content'&&partsFor(h,job.section).length))enqueue(h,job);
    }catch(error){if(current()?.id===h.id)showError(error);}
  }
  function leave(){shown=null;stopPreview();$('suggestionList').replaceChildren();$('suggestionStatus').textContent='Loading saved suggestions…';}
  for(const player of Object.values(players))player.addEventListener('timeupdate',highlight);
  $('alignBtn').addEventListener('click',stopPreview);
  window.addEventListener('beforeunload',event=>{if([...edits.values()].some(e=>e.dirty)){event.preventDefault();event.returnValue='';}});
  globalThis.AlignmentReview={load,leave,stopPreview};
})();
