import { discover } from './phrase-search.js';
import { audit, compatible } from './reference-core.js';

const median = xs => { const a = [...xs].sort((x,y) => x-y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const clamp = (x,a,b) => Math.max(a, Math.min(b,x));

// Relative pitch, voicing, and energy support matching; they do not identify lyrics.
export function features(pcm, rate = 4000, bounds = [0, pcm.length / rate]) {
  if (!(pcm instanceof Float32Array) || ![4000,8000,16000].includes(rate)) throw new Error('Invalid analysis audio.');
  const [start,end] = bounds;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > pcm.length / rate + .001 || end <= start || end - start > 3600) throw new Error('Phrase bounds are outside the recording.');
  const hop = .04, size = Math.round(rate * .08), lo = Math.round(rate / 400), hi = Math.round(rate / 70);
  const frames = [], raw = new Float64Array(size), pitch = [];
  for (let t = start; t <= end + 1e-6; t += hop) {
    const center = Math.round(t * rate); let energy = 0, mean = 0;
    for (let k = 0; k < size; k++) { const v = pcm[center+k-size/2] || 0; raw[k] = v; mean += v; energy += v*v; }
    mean /= size;
    for (let k = 0; k < size; k++) raw[k] -= mean;
    let best = 0, lag = lo;
    const correlations = new Float64Array(hi+2);
    for (let l = lo-1; l <= hi+1; l++) {
      let cross = 0, a = 0, b = 0;
      for (let k = 0; k < size-l; k++) { cross += raw[k]*raw[k+l]; a += raw[k]**2; b += raw[k+l]**2; }
      const similarity = cross / (Math.sqrt(a*b) + 1e-12);
      correlations[l]=similarity;
      if (l>=lo && l<=hi && similarity > best) { best = similarity; lag = l; }
    }
    // Follow the skill's earliest strong autocorrelation-peak rule to reduce
    // octave jumps. This remains a supporting estimate, not a melody decoder.
    for(let l=lo;l<=hi;l++)if(correlations[l]>correlations[l-1]&&correlations[l]>=correlations[l+1]&&correlations[l]>=best*.93){lag=l;best=correlations[l];break;}
    const rms = Math.sqrt(energy/size), voiced = best >= .55 && rms >= .0001;
    const p = voiced ? 69 + 12*Math.log2(rate/lag/440) : null;
    frames.push({ t, p, voice: voiced ? best : 0, energy: rms });
    if (p !== null) pitch.push(p);
  }
  if (pitch.length < 10) throw new Error('There is too little reliable voiced audio in this phrase. Choose a sung phrase with more context.');
  const centerPitch = median(pitch), centerEnergy = median(frames.map(f => f.energy));
  const energies = frames.map(f => Math.log1p(f.energy / (centerEnergy+1e-8)));
  const m = median(energies), sd = Math.sqrt(energies.reduce((sum,e) => sum+(e-m)**2,0)/energies.length)+1e-8;
  frames.forEach((f,i) => { f.p = f.p === null ? 0 : f.p-centerPitch; f.energy = (energies[i]-m)/sd; });
  return frames;
}

export function warp(r,q, band = .12) {
  const n = r.length, m = q.length;
  if (n < 10 || m < 10 || n > 30000 || m > 30000 || m/n < .4 || m/n > 2.5) throw new Error('Split this into shorter corresponding phrases; their lengths differ too much.');
  const width = Math.ceil(band*m)+3;
  if (n*(2*width+1) > 45_000_000) throw new Error('This matching range is too long. Split it into shorter phrases.');
  const starts = new Int32Array(n), directions = new Uint8Array(n*(2*width+1));
  let prev = new Float64Array(m).fill(Infinity);
  for (let i=0;i<n;i++) {
    const center = Math.round(i*(m-1)/(n-1)), first = Math.max(0,center-width), last = Math.min(m-1,center+width);
    starts[i] = first; const next = new Float64Array(m).fill(Infinity);
    for (let j=first;j<=last;j++) {
      const a=r[i], b=q[j], voice=Math.min(a.voice,b.voice);
      const cost=voice*Math.min(12,Math.abs(a.p-b.p))/3+Math.abs(a.voice-b.voice)+.25*Math.abs(a.energy-b.energy);
      let v=i&&j?prev[j-1]:i===0&&j===0?0:Infinity, d=1;
      if (i&&prev[j]+.08<v) { v=prev[j]+.08; d=2; }
      if (j&&next[j-1]+.08<v) { v=next[j-1]+.08; d=3; }
      next[j]=v+cost; directions[i*(2*width+1)+j-first]=d;
    }
    prev=next;
  }
  if (!Number.isFinite(prev[m-1])) throw new Error('No consistent match inside the phrase bounds.');
  const bins=Array.from({length:n},()=>[]); let i=n-1,j=m-1,steps=0,edge=0;
  while (i>=0&&j>=0&&steps++<n+m+2) {
    bins[i].push(j);
    if (Math.abs(j-i*(m-1)/(n-1)) >= width-1) edge++;
    const d=directions[i*(2*width+1)+j-starts[i]];
    if (d===1) { i--;j--; } else if (d===2) i--; else if (d===3) j--; else throw new Error('The matching path is incomplete.');
  }
  const map=bins.map(xs=>median(xs)), cost=prev[m-1]/steps;
  // A low cost is a diagnostic, never a confidence percentage or musical approval.
  if (cost>.85 || edge/steps>.12) throw new Error('The acoustic match is weak or stretches against its limits. Check phrase identity and repeats.');
  return { map, cost, pathFrames:steps, edgeFraction:edge/steps };
}

export function analyze(job) {
  const { reference, target, pcm, referencePcm, rate=4000, anchors=[] } = job;
  compatible(reference,target);
  if (reference.audioSha256 === target.audioSha256) {
    audit(reference.times, target.parts, target.duration, target.section);
    return { times:[...reference.times], method:'exact-reference-reuse', diagnostics:[], message:'Reused approved boundaries from identical recording bytes and the same passage map. This is reference reuse.' };
  }
  if (!pcm || !referencePcm) throw new Error('Both recordings are required for matching.');
  if (!anchors.length) return automatic(reference,target,pcm,referencePcm,rate);
  if (anchors.length < 2 || anchors.length > 24) throw new Error('Mark the beginning and end of the same sung phrase in both recordings.');
  anchors.forEach((a,i)=>{
    if (!Number.isFinite(a.reference) || !Number.isFinite(a.target) || a.reference<0 || a.target<0 || a.reference>=reference.duration || a.target>=target.duration || (i && (a.reference<=anchors[i-1].reference || a.target<=anchors[i-1].target))) throw new Error('Phrase landmarks must increase in both recordings.');
  });
  const times=target.parts.map(()=>null), diagnostics=[];
  for (let k=1;k<anchors.length;k++) {
    const from=anchors[k-1],to=anchors[k];
    if (to.reference-from.reference>90 || to.target-from.target>90) throw new Error('Choose corresponding phrases up to 90 seconds long. Split at repeats or section changes.');
    const rf=features(referencePcm,rate,[from.reference,to.reference]),tf=features(pcm,rate,[from.target,to.target]);
    const result=warp(rf,tf); diagnostics.push({ referenceBounds:[from.reference,to.reference],targetBounds:[from.target,to.target],cost:result.cost,edgeFraction:result.edgeFraction });
    reference.times.forEach((t,index)=>{
      if (!Number.isFinite(t) || t<from.reference || t>to.reference || (target.section==='hazzat' && /^\.+$/u.test(target.parts[index].glyph))) return;
      const frame=clamp((t-from.reference)/.04,0,rf.length-1),low=Math.floor(frame),high=Math.min(low+1,rf.length-1),f=frame-low;
      const mapped=result.map[low]*(1-f)+result.map[high]*f;
      const mappedTime=from.target+mapped*.04;
      if (mappedTime>=to.target+.04) return;
      times[index]=Math.round(mappedTime*1000)/1000;
    });
  }
  // Collapsed cues are unresolved, rather than being fabricated with a minimum gap.
  let prev=-1;
  times.forEach((t,i)=>{ if (Number.isFinite(t)) { if (t<=prev || t>=target.duration) times[i]=null; else prev=t; } });
  const summary=audit(times,target.parts,target.duration,target.section);
  if (!summary.marked) throw new Error('No approved reference notes lie inside those phrase bounds.');
  return { times, method:'constrained-reference-transfer', diagnostics, message:'Candidates matched within your corresponding phrases. Sung-word identity and exact note starts still need review.' };
}
export function automatic(reference,target,pcm,referencePcm,rate) {
  if (target.duration>600 || reference.duration>600) throw new Error('Automatic phrase search supports recordings up to ten minutes. Use optional phrase ranges for longer recordings.');
  const rf=features(referencePcm,rate),tf=features(pcm,rate);
  const {matches,diagnostics}=discover(reference,rf,tf,warp),times=target.parts.map(()=>null),unstable=[];
  for(const match of matches){
    const [start,end]=match.referenceBounds;
    reference.times.forEach((time,index)=>{
      if(!Number.isFinite(time)||time<start||time>end)return;
      const frames=match.referenceFrames,position=clamp((time-frames[0].t)/.04,0,frames.length-1),low=Math.floor(position),high=Math.min(low+1,frames.length-1);
      // Free-search endpoints and unstable warp positions do not establish exact note starts.
      if(time-start<.25||end-time<.25||Math.max(match.uncertainty[low],match.uncertainty[high])>.2){unstable.push(index);return;}
      const mapped=match.map[low]+(match.map[high]-match.map[low])*(position-low);
      times[index]=Math.round((match.targetFrames[0].t+mapped*.04)*1000)/1000;
    });
  }
  diagnostics.push({status:'unresolved-cues',indices:[...new Set(unstable)],reason:'Phrase-edge or unstable starts remain untimed; nearby plausible paths differ by more than 0.2 seconds.'});
  let previous=-1;
  times.forEach((time,i)=>{if(Number.isFinite(time)){if(time<=previous||time>=target.duration)times[i]=null;else previous=time;}});
  const summary=audit(times,target.parts,target.duration,target.section);
  return {times,method:'automatic-reference-transfer',diagnostics,anchors:[],message:summary.marked
    ? 'Automatically found '+matches.length+' candidate phrase matches. Repeats and weak matches stay unresolved. Musical identity and exact starts need review.'
    : 'No distinct phrase match passed the checks. Prepared the complete passage map and rejection evidence; no starts were invented.'};
}
if (typeof self !== 'undefined' && typeof document === 'undefined') self.onmessage=event=>{
  try { self.postMessage({ result:analyze(event.data) }); } catch(error) { self.postMessage({ error:error.message }); }
};
