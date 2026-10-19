/* Recording-to-passage suggestions. Runs off the UI thread; never publishes timings. */
(() => {
  const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
  const round = x => Math.round(x*100)/100;
  function fft(re, im) {
    const n=re.length;
    for(let i=1,j=0;i<n;i++) { let bit=n>>1; for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];} }
    for(let len=2;len<=n;len*=2){
      const a=-2*Math.PI/len,wr=Math.cos(a),wi=Math.sin(a);
      for(let i=0;i<n;i+=len){let xr=1,xi=0;for(let j=0;j<len/2;j++){
        const p=i+j,q=p+len/2,tr=re[q]*xr-im[q]*xi,ti=re[q]*xi+im[q]*xr;
        re[q]=re[p]-tr;im[q]=im[p]-ti;re[p]+=tr;im[p]+=ti;
        const next=xr*wr-xi*wi;xi=xr*wi+xi*wr;xr=next;
      }}
    }
  }
  function features(pcm,rate) {
    const duration=pcm.length/rate,hop=Math.max(.16,duration/3000),n=Math.ceil(duration/hop);
    const energy=new Float32Array(n),chroma=new Float32Array(n*12),size=1024;
    const re=new Float32Array(size),im=new Float32Array(size);
    const window=Float32Array.from({length:size},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(size-1)));
    const bins=[];
    for(let k=1;k<size/2;k++){
      const hz=k*rate/size;
      if(hz>=75&&hz<=1800)bins.push([k,((Math.round(69+12*Math.log2(hz/440))%12)+12)%12]);
    }
    for(let t=0;t<n;t++){
      const mid=Math.round(t*hop*rate);let e=0;
      for(let j=0;j<size;j++){const v=pcm[mid+j-size/2]||0;re[j]=v*window[j];im[j]=0;e+=v*v;}
      energy[t]=Math.sqrt(e/size);fft(re,im);
      for(const [k,c] of bins)chroma[t*12+c]+=Math.sqrt(re[k]**2+im[k]**2);
      let norm=0;for(let c=0;c<12;c++)norm+=chroma[t*12+c]**2;
      norm=Math.sqrt(norm)||1;for(let c=0;c<12;c++)chroma[t*12+c]/=norm;
    }
    const sorted=[...energy].sort((a,b)=>a-b),peak=sorted[Math.floor(n*.9)]||0;
    if(peak<.00008)throw new Error('This recording is silent or too quiet to align.');
    const threshold=Math.max(peak*.09,Math.min(peak*.3,(sorted[Math.floor(n*.1)]||0)*2));
    let first=energy.findIndex(e=>e>threshold),last=n-1;
    while(last>first&&energy[last]<threshold)last--;
    return {energy,chroma,hop,duration,peak,threshold,first:Math.max(0,first),last};
  }
  function estimate(f,parts) {
    if(!parts.length)throw new Error('Add words or Hazzat first.');
    const total=parts.reduce((s,p)=>s+p.weight,0),mass=new Float64Array(f.energy.length+1);
    for(let i=f.first;i<=f.last;i++)mass[i+1]=mass[i]+(f.energy[i]>f.threshold?Math.sqrt(f.energy[i]/f.peak):.015);
    const endMass=mass[f.last+1];let weight=0,previous=-1;
    const times=parts.map((part,index)=>{
      const targetMass=endMass*weight/total;weight+=part.weight;
      let lo=f.first,hi=f.last;
      while(lo<hi){const mid=(lo+hi)>>1;if(mass[mid+1]<targetMass)lo=mid+1;else hi=mid;}
      let chosen=lo;
      // Look for nearby phrase boundaries. Word times within a held phrase remain estimates.
      if(index>0){
        const width=Math.max(1,Math.min(25,Math.floor((f.last-f.first)/parts.length*.4)));
        let best=Infinity;
        for(let t=Math.max(f.first,lo-width);t<=Math.min(f.last,lo+width);t++){
          if(t*f.hop<=previous+.025)continue;
          const score=f.energy[t]/f.peak+Math.abs(t-lo)/width*.65;
          if(score<best){best=score;chosen=t;}
        }
      }
      const time=round(clamp(Math.max(chosen*f.hop,previous+.03),0,f.duration-.01));previous=time;return time;
    });
    return times;
  }
  function transfer(ref,target,times) {
    const a=ref.last-ref.first+1,b=target.last-target.first+1;
    if(a<8||b<8)return null;
    // A constrained dynamic-time-warping path compares actual pitch-class spectra.
    // Only earlier marks from this same hymn/section qualify as a reference.
    const aggregate=f=>{const out=new Float64Array(12);for(let i=f.first;i<=f.last;i++)for(let c=0;c<12;c++)out[c]+=f.chroma[i*12+c];return out;};
    const ar=aggregate(ref),at=aggregate(target);let shift=0,best=-Infinity;
    for(let s=0;s<12;s++){let score=0;for(let c=0;c<12;c++)score+=ar[c]*at[(c+s)%12];if(score>best){best=score;shift=s;}}
    const band=Math.ceil(b*.18)+4,width=band*2+1;
    const directions=new Uint8Array(a*width),starts=new Int32Array(a);
    let previous=new Float64Array(b).fill(Infinity);
    for(let i=0;i<a;i++){
      const center=Math.round(i*(b-1)/Math.max(1,a-1)),start=Math.max(0,center-band),end=Math.min(b-1,center+band);
      starts[i]=start;const next=new Float64Array(b).fill(Infinity);
      for(let j=start;j<=end;j++){
        const ri=i+ref.first,tj=j+target.first;
        let similarity=0;for(let c=0;c<12;c++)similarity+=ref.chroma[ri*12+c]*target.chroma[tj*12+(c+shift)%12];
        const cost=1-similarity+.12*Math.min(2,Math.abs(Math.log((ref.energy[ri]+.00001)/ref.peak)-Math.log((target.energy[tj]+.00001)/target.peak)));
        let v=i&&j?previous[j-1]:i===0&&j===0?0:Infinity,d=1;
        if(i&&previous[j]+.055<v){v=previous[j]+.055;d=2;}
        if(j&&next[j-1]+.055<v){v=next[j-1]+.055;d=3;}
        next[j]=cost+v;directions[i*width+j-start]=d;
      }
      previous=next;
    }
    const cost=previous[b-1]/Math.max(a,b);
    if(!Number.isFinite(cost)||cost>.48)return null;
    const map=new Float64Array(a).fill(NaN);let i=a-1,j=b-1,steps=0;
    while(i>=0&&j>=0&&steps++<a+b+2){
      map[i]=j;const d=directions[i*width+j-starts[i]];
      if(d===1){i--;j--;}else if(d===2)i--;else if(d===3)j--;else return null;
    }
    const mapped=times.map(t=>{
      if(!Number.isFinite(t))return null;
      const frame=clamp(t/ref.hop-ref.first,0,a-1),low=Math.floor(frame),high=Math.min(a-1,low+1);
      return round(clamp((map[low]+(map[high]-map[low])*(frame-low)+target.first)*target.hop,0,target.duration-.01));
    });
    return mapped.every(Number.isFinite)?mapped:null;
  }
  function analyze({pcm,rate,parts,reference,glyphs,lineStart,clip}) {
    if(glyphs?.length&&globalThis.HazzatReader){
      const read=globalThis.HazzatReader.read({pcm,rate,glyphs,lineStart,clip});
      return {times:read.times,repeats:read.repeats,duration:read.duration,method:'hazzat-reader',message:read.repeats.length?'Read from the Hazzat, including '+read.repeats.length+' repeated '+(read.repeats.length===1?'section':'sections')+'. Check pieces after long held notes.':'Read from the Hazzat: note lengths from the notation, breaths at line starts and breath marks. Check pieces after long held notes.'};
    }
    const target=features(pcm,rate);
    if(reference?.pcm&&reference.times.length===parts.length&&reference.times.every(Number.isFinite)){
      try {
        const mapped=transfer(features(reference.pcm,rate),target,reference.times);
        if(mapped)return {times:mapped,duration:target.duration,method:'reference',message:'Matched to the earlier aligned recording of this hymn. Check repeated phrases and long held notes.'};
      } catch { /* A reference failure must not prevent a reviewable draft. */ }
    }
    return {times:estimate(target,parts),duration:target.duration,method:'phrase-estimate',message:'Estimated from audible phrases and passage lengths. Words and Hazzat have not been recognized; review every time before accepting.'};
  }
  if(typeof self!=='undefined'&&typeof document==='undefined'&&typeof importScripts==='function'){try{importScripts('/hazzat-reader.js');}catch{/* Fall back to the phrase estimate. */}}
  if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=event=>{try{self.postMessage({result:analyze(event.data)});}catch(error){self.postMessage({error:error.message});}};
  if(typeof module!=='undefined')module.exports={features,estimate,transfer,analyze};
  globalThis.RecordingAlignment={features,estimate,transfer,analyze};
})();
