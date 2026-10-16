#!/usr/bin/env python3
"""Run only after explicit approval and deployment of the temporary exporter.
The 64-character export secret is read from hidden stdin, never arguments or disk.
This downloads a database copy and every R2 object, with two-pass data comparison.
"""
import concurrent.futures, hashlib, json, os, pathlib, sqlite3, sys, time, urllib.parse, urllib.request
BASE='https://mobilemoallem.com/api/__migration-export/'
DEST=pathlib.Path(__file__).resolve().parent.parent/'live-backup'

def main():
    if DEST.exists():
        raise SystemExit('live-backup already exists; move it aside before a fresh verified export.')
    print('Ready for export key on stdin (input hidden).',flush=True)
    import getpass
    key=getpass.getpass('') if sys.stdin.isatty() else sys.stdin.readline().strip()
    if len(key)!=64 or any(c not in '0123456789abcdef' for c in key):
        raise SystemExit('Invalid export secret format.')
    DEST.mkdir(mode=0o700)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise RuntimeError('Refusing redirect while carrying the private export secret.')
    urllib.request.install_opener(urllib.request.build_opener(NoRedirect))
    def request(route,params=None):
        url=BASE+route+('?' + urllib.parse.urlencode(params) if params else '')
        req=urllib.request.Request(url,headers={'x-mobile-moallem-export-key':key,'User-Agent':'Mozilla/5.0 (compatible; MobileMoallemBackup/1.0)'})
        for attempt in range(4):
            try:return urllib.request.urlopen(req,timeout=120)
            except Exception:
                if attempt==3:raise
                time.sleep(2**attempt)
    def get_json(route,params=None):
        with request(route,params) as response:return json.load(response)
    def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')
    def digest(value):return hashlib.sha256(canonical(value)).hexdigest()
    schema=get_json('schema')
    tables=[row['name'] for row in schema['schema'] if row['type']=='table']
    def collect_tables():
        contents={}
        for table in tables:
            rows=[];offset=0;total=None
            while True:
                page=get_json('table',{'name':table,'offset':offset})
                if page['table']!=table or page['offset']!=offset:raise RuntimeError('Unexpected table cursor')
                if total is None:total=page['total']
                if page['total']!=total:raise RuntimeError('Database changed during export; retry with no editing.')
                rows.extend(page['rows'])
                if page['nextOffset'] is None:break
                if page['nextOffset']<=offset:raise RuntimeError('Non-advancing table cursor')
                offset=page['nextOffset']
            if len(rows)!=total:raise RuntimeError('Incomplete '+table)
            contents[table]=rows
        return contents
    def collect_objects():
        objects=[];cursor=None;seen=set()
        while True:
            page=get_json('objects',{'cursor':cursor} if cursor else None)
            objects.extend(page['objects'])
            if not page['truncated']:break
            if not page['cursor'] or page['cursor'] in seen:raise RuntimeError('Non-advancing object cursor')
            cursor=page['cursor'];seen.add(cursor)
        if len(set(x['key'] for x in objects))!=len(objects):raise RuntimeError('Duplicate objects')
        return sorted(objects,key=lambda x:x['key'])
    def object_identity(objects):
        return [{k:v for k,v in o.items() if k not in ('uploaded',)} for o in objects]
    first=collect_tables();objects=collect_objects()
    import shutil
    required=sum(item['size'] for item in objects)+256*1024*1024
    available=shutil.disk_usage(str(DEST)).free
    if required>available:raise RuntimeError('Insufficient disk space for complete media export: need '+str(required)+' bytes, have '+str(available))
    (DEST/'objects.json').write_bytes(canonical(objects))
    print(json.dumps({'phase':'downloading','tables':len(first),'rows':sum(len(rows) for rows in first.values()),'objects':len(objects),'mediaBytes':sum(item['size'] for item in objects)}),flush=True)
    (DEST/'schema.json').write_bytes(canonical(schema))
    dbdir=DEST/'tables';dbdir.mkdir()
    for table,rows in first.items():(dbdir/(table+'.json')).write_bytes(canonical(rows))
    media=DEST/'media';media.mkdir()
    def download(item):
        key=item['key'];parts=pathlib.PurePosixPath(key).parts
        if not parts or pathlib.PurePosixPath(key).is_absolute() or any(x in ('.','..') for x in parts) or '\\' in key:raise RuntimeError('Unsafe object path')
        file=media.joinpath(*parts);file.parent.mkdir(parents=True,exist_ok=True)
        h=hashlib.sha256();count=0
        with request('object',{'key':key}) as response, file.open('wb') as output:
            headers=getattr(response,'headers',None)
            fetched_etag=headers.get('etag','').strip(chr(34)) if headers else ''
            if fetched_etag and fetched_etag!=item.get('etag'):raise RuntimeError('Object changed since listing: '+key)
            while True:
                chunk=response.read(1024*1024)
                if not chunk:break
                output.write(chunk);h.update(chunk);count+=len(chunk)
        if count!=item['size']:raise RuntimeError('Object size mismatch: '+key)
        file.with_name(file.name+'.metadata.json').write_bytes(canonical({'httpMetadata':item.get('httpMetadata',{}),'customMetadata':item.get('customMetadata',{})}))
        print(json.dumps({'downloaded':key,'bytes':count}),flush=True)
        return {'key':key,'size':count,'sha256':h.hexdigest()}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        downloaded=list(pool.map(download,objects))
    second=collect_tables();objects_after=collect_objects()
    if digest(first)!=digest(second):raise RuntimeError('Database changed during backup; incomplete backup retained without completion manifest.')
    if digest(object_identity(objects))!=digest(object_identity(objects_after)):raise RuntimeError('Media changed during backup; retry.')
    if digest(schema['schema'])!=digest(get_json('schema')['schema']):raise RuntimeError('Schema changed during backup; retry.')
    # Build a separate, inspectable restore target, never the live database.
    target=DEST/'mobile-moallem.sqlite';db=sqlite3.connect(str(target))
    db.execute('PRAGMA foreign_keys=OFF')
    for entry in schema['schema']:
        if entry['type']=='table':db.execute(entry['sql'])
    for table,rows in first.items():
        if not rows:continue
        quote=lambda name:'"'+name.replace('"','""')+'"'
        columns=list(rows[0]);sql='INSERT INTO '+quote(table)+' ('+','.join(map(quote,columns))+') VALUES ('+','.join('?' for _ in columns)+')'
        db.executemany(sql,[[row[col] for col in columns] for row in rows])
    for entry in schema['schema']:
        if entry['type']!='table':db.execute(entry['sql'])
    db.commit()
    if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('SQLite integrity check failed')
    foreign_keys=db.execute('PRAGMA foreign_key_check').fetchall()
    if foreign_keys:raise RuntimeError('Foreign key validation failed')
    for table,rows in first.items():
        count=db.execute('SELECT COUNT(*) FROM "'+table.replace('"','""')+'"').fetchone()[0]
        if count!=len(rows):raise RuntimeError('SQLite row count mismatch')
    db.close()
    manifest={'complete':True,'exportedAt':time.time(),'databaseConsistency':'Two complete identical passes; not a transactional platform snapshot.','tables':{table:{'rows':len(rows),'sha256':digest(rows)} for table,rows in first.items()},'objects':downloaded,'objectCount':len(downloaded),'databaseSha256':hashlib.sha256(target.read_bytes()).hexdigest()}
    (DEST/'COMPLETE.json').write_bytes(canonical(manifest))
    print(json.dumps({'complete':True,'tables':len(tables),'objects':len(objects),'destination':str(DEST)}))
if __name__=='__main__':main()
