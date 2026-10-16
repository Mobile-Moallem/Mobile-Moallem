#!/usr/bin/env python3
"""Validate locally by default; --upload writes verified files to an EMPTY R2 bucket.
Install boto3 only when using --upload. Credentials come from environment, never this file.
"""
import argparse,datetime,hashlib,json,os,pathlib,re
p=argparse.ArgumentParser();p.add_argument('--upload',action='store_true');a=p.parse_args()
backup=pathlib.Path(__file__).resolve().parent.parent/'live-backup'
complete=json.loads((backup/'COMPLETE.json').read_text());objects=json.loads((backup/'objects.json').read_text())
assert complete['complete'] and len(objects)==complete['objectCount']
hashes={o['key']:o for o in complete['objects']};files={}
for obj in objects:
 key=obj['key'];parts=pathlib.PurePosixPath(key).parts
 if not parts or key.startswith('/') or '\\' in key or any(x in ('.','..') for x in parts):raise SystemExit('Unsafe object key')
 f=backup/'media'/key;data=f.read_bytes()
 if len(data)!=obj['size'] or hashlib.sha256(data).hexdigest()!=hashes[key]['sha256']:raise SystemExit('Backup validation failed')
 files[key]=f
print(json.dumps({'validatedObjects':len(files),'bytes':sum(o['size'] for o in objects),'mode':'upload' if a.upload else 'local validation only'}))
if a.upload:
 import boto3
 endpoint=os.environ['R2_ENDPOINT_URL'];bucket=os.environ['R2_BUCKET_NAME']
 if not re.fullmatch(r'https://[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com',endpoint):raise SystemExit('Use your account R2 S3 endpoint')
 s3=boto3.client('s3',endpoint_url=endpoint,region_name='auto',aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'])
 if s3.list_objects_v2(Bucket=bucket,MaxKeys=1).get('Contents'):raise SystemExit('Target bucket must be empty. Use a new staging bucket; do not overwrite production.')
 fields={'contentType':'ContentType','contentLanguage':'ContentLanguage','contentDisposition':'ContentDisposition','contentEncoding':'ContentEncoding','cacheControl':'CacheControl','cacheExpiry':'Expires'}
 for obj in objects:
  key=obj['key'];metadata=obj.get('httpMetadata',{});extra={fields[k]:v for k,v in metadata.items() if k in fields}
  if 'Expires' in extra:extra['Expires']=datetime.datetime.fromisoformat(extra['Expires'].replace('Z','+00:00'))
  with files[key].open('rb') as f:s3.put_object(Bucket=bucket,Key=key,Body=f,Metadata=obj.get('customMetadata',{}),**extra)
  restored=s3.get_object(Bucket=bucket,Key=key)
  h=hashlib.sha256();count=0
  while True:
   chunk=restored['Body'].read(1024*1024)
   if not chunk:break
   h.update(chunk);count+=len(chunk)
  restored['Body'].close()
  if count!=obj['size'] or h.hexdigest()!=hashes[key]['sha256']:raise SystemExit('Remote object verification failed: '+key)
  if restored.get('Metadata',{})!={k.lower():v for k,v in obj.get('customMetadata',{}).items()}:raise SystemExit('Remote custom metadata mismatch: '+key)
  for name,value in extra.items():
   if restored.get(name)!=value:raise SystemExit('Remote HTTP metadata mismatch: '+key)
  print(json.dumps({'uploadedAndVerified':key,'bytes':count}))
 print(json.dumps({'complete':True,'objects':len(objects),'bucket':bucket}))
