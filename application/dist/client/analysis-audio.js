// Deterministic low-pass analysis copy. Media timestamps and bytes stay intact.
// Native playback-rate conversion varies between browsers, so it is not used
// to choose the pitch track for alignment.
export function analysisPcm(pcm) {
  if(!(pcm instanceof Float32Array)||!pcm.length)throw new Error('Invalid decoded analysis audio.');
  const kernel=[];
  for(let x=-48;x<=48;x++)kernel.push((x===0?1:Math.sin(Math.PI*x*.225)/(Math.PI*x*.225))*(.54+.46*Math.cos(Math.PI*x/48)));
  const sum=kernel.reduce((a,b)=>a+b,0);for(let i=0;i<kernel.length;i++)kernel[i]/=sum;
  const out=new Float32Array(Math.ceil(pcm.length/4));
  for(let i=0;i<out.length;i++){let value=0;for(let k=0;k<kernel.length;k++)value+=(pcm[i*4+k-48]||0)*kernel[k];out[i]=value;}
  return out;
}
