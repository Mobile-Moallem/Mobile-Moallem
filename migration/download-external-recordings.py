#!/usr/bin/env python3
"""Optional external-audio download. Does not rewrite app references or grant publication rights."""
import concurrent.futures,hashlib,json,pathlib,urllib.parse,urllib.request
root=pathlib.Path(__file__).resolve().parent.parent
items=json.loads((root/'external-recording-urls.json').read_text())
out=root/'external-recordings';out.mkdir(exist_ok=True)
def download(item):
 url=item['url'];name=hashlib.sha256(url.encode()).hexdigest()+'.mp3';target=out/name
 try:
  req=urllib.request.Request(url,headers={'User-Agent':'MobileMoallemBackup/1.0'})
  h=hashlib.sha256();size=0
  with urllib.request.urlopen(req,timeout=60) as response,target.with_suffix('.part').open('wb') as f:
   kind=response.headers.get('content-type','')
   if 'text/html' in kind:raise ValueError('Received HTML instead of recording')
   while True:
    data=response.read(1024*1024)
    if not data:break
    f.write(data);h.update(data);size+=len(data)
  target.with_suffix('.part').replace(target)
  return {'url':url,'file':name,'bytes':size,'sha256':h.hexdigest(),'contentType':kind,'downloaded':True}
 except Exception as e:
  target.with_suffix('.part').unlink(missing_ok=True)
  return {'url':url,'downloaded':False,'error':type(e).__name__}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:results=list(pool.map(download,items))
(out/'manifest.json').write_text(json.dumps(results,indent=2))
print(json.dumps({'downloaded':sum(x['downloaded'] for x in results),'failed':sum(not x['downloaded'] for x in results),'manifest':str(out/'manifest.json')}))
