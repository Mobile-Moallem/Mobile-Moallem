// Autonomous phrase proposals. These diagnostics support review; they cannot
// establish sung syllable identity or turn mnemonic notation into a melody.
import { isBreath } from './reference-core.js';
const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return a[Math.floor(a.length/2)]||0;};
export function referencePhrases(reference) {
  const groups=[];let notes=[];
  function flush(){if(notes.length>=3){const start=notes[0].time,end=notes.at(-1).time;if(end-start>=3)groups.push({referenceBounds:[start,end],indices:notes.map(n=>n.index)});}notes=[];}
  reference.parts.forEach((p,index)=>{
    const time=reference.times[index];
    if(reference.section==='hazzat'&&isBreath(p.glyph)){flush();return;}
    if(!Number.isFinite(time)){flush();return;}
    // Only reference starts define analysis spans. No glyph duration is inferred.
    if(notes.length&&time-notes[0].time>24){const last=notes.at(-1);flush();notes=[last];}
    notes.push({time,index});
  });flush();return groups.slice(0,48);
}
function normalized(frames) {
  const voiced=frames.filter(f=>f.voice>=.55);if(voiced.length<10)throw new Error('Insufficient voiced context.');
  const p=median(voiced.map(f=>f.p)),e=median(frames.map(f=>f.energy));
  const sd=Math.sqrt(frames.reduce((s,f)=>s+(f.energy-e)**2,0)/frames.length)+1e-8;
  return frames.map(f=>({...f,p:f.voice?f.p-p:0,energy:(f.energy-e)/sd}));
}
const distance=(a,b)=>Math.min(a.voice,b.voice)*Math.min(12,Math.abs(a.p-b.p))/3+Math.abs(a.voice-b.voice)+.25*Math.abs(a.energy-b.energy);
const slice=(frames,a,b)=>frames.filter(f=>f.t>=a-.001&&f.t<=b+.001);
function score(r,q){let sum=0;for(let i=0;i<r.length;i++)sum+=distance(r[i],q[Math.round(i*(q.length-1)/(r.length-1))]);return sum/r.length;}
function attempt(r,q,warp){try{return warp(normalized(r),normalized(q));}catch{return null;}}
export function findPhrase(referenceFrames,targetFrames,bounds,warp,minimumTarget=0) {
  if(bounds[0]<referenceFrames[0].t-.001||bounds[1]>referenceFrames.at(-1).t+.001)return {status:'unresolved',reason:'The reference audio does not cover these approved starts.'};
  const full=slice(referenceFrames,...bounds),r=normalized(full.filter((_,i)=>i%5===0)),duration=bounds[1]-bounds[0],end=targetFrames.at(-1).t;
  if(duration<3||duration>30)return {status:'unresolved',reason:'Too little reference context or a range that needs splitting.'};
  const candidates=[];
  // Search the complete target, rather than presuming that its intro, repeats,
  // tempo or final cadence use the reference recording's positions.
  for(const factor of Array.from({length:21},(_,i)=>.6+i*.05))for(let start=minimumTarget;start+duration*factor<=end;start+=.4){
    const stop=start+duration*factor;
    const raw=[];for(let i=0;i<r.length;i++){const time=start+i*(stop-start)/(r.length-1);raw.push(targetFrames[Math.min(targetFrames.length-1,Math.round(time/.04))]);}
    try{candidates.push({start,end:stop,coarse:score(r,normalized(raw))});}catch{}
  }
  candidates.sort((a,b)=>a.coarse-b.coarse);
  const seeds=[];
  for(const c of candidates){if(!seeds.some(s=>Math.abs(s.start-c.start)<.8&&Math.abs(s.end-c.end)<1)){seeds.push(c);if(seeds.length>=18)break;}}
  const matches=[];
  for(const c of seeds){const q=slice(targetFrames,c.start,c.end),result=attempt(full,q,warp);if(result)matches.push({...c,...result});}
  matches.sort((a,b)=>a.cost-b.cost);if(!matches.length)return {status:'unresolved',reason:'No consistent acoustic path.'};
  let best=matches[0];const localPaths=[];
  // Refine the proposed endpoints locally; do not change the approved labels.
  for(const ds of [-.24,-.12,0,.12,.24])for(const de of [-.24,-.12,0,.12,.24]){
    const start=matches[0].start+ds,stop=matches[0].end+de;if(start<minimumTarget||stop>end)continue;
    const result=attempt(full,slice(targetFrames,start,stop),warp);if(result){const path={start,end:stop,...result};localPaths.push(path);if(result.cost<best.cost)best=path;}
  }
  const alternate=matches.find(c=>Math.abs(c.start-best.start)>duration*.55);
  if(best.cost>.6)return {status:'unresolved',reason:'Weak acoustic correspondence.',cost:best.cost};
  if(alternate&&alternate.cost<=best.cost*1.2+.04)return {status:'unresolved',reason:'More than one section matches; repeat identity is ambiguous.',cost:best.cost,alternativeCost:alternate.cost};
  const q=slice(targetFrames,best.start,best.end);
  const reverse=attempt([...full].reverse(),q,warp),mid=Math.floor(full.length/2),scramble=attempt([...full.slice(mid),...full.slice(0,mid)],q,warp);
  const negativeCost=Math.min(reverse?.cost??Infinity,scramble?.cost??Infinity);
  if(negativeCost<=best.cost*1.15+.04)return {status:'unresolved',reason:'Reordered phrase controls match almost as well.',cost:best.cost,negativeCost};
  const stablePaths=[...matches,...localPaths].filter(c=>Math.abs(c.start-best.start)<duration*.55&&c.cost<=best.cost*1.15+.03);
  const uncertainty=best.map.map((_,i)=>{const values=stablePaths.map(c=>c.start+c.map[i]*.04);return Math.max(...values)-Math.min(...values);});
  return {status:'candidate',uncertainty,referenceBounds:bounds,targetBounds:[q[0].t,q.at(-1).t],cost:best.cost,edgeFraction:best.edgeFraction,alternativeCost:alternate?.cost??null,negativeCost:Number.isFinite(negativeCost)?negativeCost:null,map:best.map,referenceFrames:full,targetFrames:q};
}
export function discover(reference,rf,tf,warp) {
  const diagnostics=[],matches=[];let minimumTarget=0;
  for(const phrase of referencePhrases(reference)){
    let result;try{result=findPhrase(rf,tf,phrase.referenceBounds,warp,minimumTarget);}catch(error){result={status:'unresolved',reason:error.message};}
    const {map,uncertainty,referenceFrames,targetFrames,...diagnostic}=result;diagnostics.push({...diagnostic,referenceBounds:phrase.referenceBounds,indices:phrase.indices});
    if(result.status==='candidate'){matches.push(result);minimumTarget=result.targetBounds[1]+.001;}
  }
  return {matches,diagnostics};
}
