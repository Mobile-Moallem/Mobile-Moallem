import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function database(filename, migrations) {
  const raw = new DatabaseSync(filename);
  raw.exec('PRAGMA foreign_keys=ON');
  raw.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)');
  for (const [name, sql] of migrations) {
    if (raw.prepare('SELECT name FROM _local_migrations WHERE name=?').get(name)) continue;
    raw.exec('BEGIN');
    try {
      raw.exec(sql);
      raw.prepare('INSERT INTO _local_migrations VALUES (?)').run(name);
      raw.exec('COMMIT');
    } catch (error) { raw.exec('ROLLBACK'); throw error; }
  }
  const wrap = (sql, args=[]) => ({
    bind(...values) { return wrap(sql, values); },
    async first(column) { const row=raw.prepare(sql).get(...args); return column ? row?.[column] ?? null : row ?? null; },
    async all() { return {results:raw.prepare(sql).all(...args),success:true}; },
    async run() { const r=raw.prepare(sql).run(...args); return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}; }
  });
  return {raw, prepare:wrap, async batch(items) {
    raw.exec('BEGIN');
    try { const results=[]; for (const item of items) results.push(await item.run()); raw.exec('COMMIT'); return results; }
    catch (error) {raw.exec('ROLLBACK');throw error;}
  }};
}

export function bucket(directory) {
  const location = key => {
    if (typeof key!=='string'||!key||key.includes('\\')||key.split('/').some(x=>!x||x==='.'||x==='..')) throw new Error('Invalid media key');
    const result=path.resolve(directory,key);
    if (!result.startsWith(path.resolve(directory)+path.sep)) throw new Error('Invalid media key');
    return result;
  };
  const load = async key => {
    const file=location(key);
    try {
      const stat=await fs.stat(file);
      if(!stat.isFile())return null;
      let metadata={};try {metadata=JSON.parse(await fs.readFile(file+'.metadata.json','utf8'));}catch{}
      return {file,stat,metadata};
    }catch(e){if(e.code==='ENOENT')return null;throw e;}
  };
  const describe = (key, item) => ({key,size:item.stat.size,uploaded:new Date(item.stat.mtimeMs),httpMetadata:item.metadata.httpMetadata||{},customMetadata:item.metadata.customMetadata||{}});
  return {
    async head(key) { const item=await load(key);return item?describe(key,item):null; },
    async get(key, options={}) {
      const item=await load(key);if(!item)return null;
      let bytes=await fs.readFile(item.file);
      const etag=createHash('sha256').update(bytes).digest('hex');
      const original=bytes;
      const rangeHeader=options.range instanceof Headers ? options.range.get('range'):null;
      let range;
      if(rangeHeader) {
        const match=/^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if(match && original.length) {
          let start=match[1]?Number(match[1]):Math.max(0,original.length-Number(match[2]));
          let end=match[1]?(match[2]?Math.min(Number(match[2]),original.length-1):original.length-1):original.length-1;
          if(start<=end&&start<original.length){bytes=original.subarray(start,end+1);range={offset:start,length:bytes.length};}
        }
      }
      return {...describe(key,item),etag,httpEtag:'"'+etag+'"',range,body:new Blob([bytes]).stream(),
        async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);},
        async text(){return bytes.toString('utf8');},
        writeHttpMetadata(headers){for(const [key,value] of Object.entries(item.metadata.httpMetadata||{})) {
          const name={contentType:'content-type',contentEncoding:'content-encoding',contentDisposition:'content-disposition',contentLanguage:'content-language',cacheControl:'cache-control'}[key];
          if(name&&value)headers.set(name,value);
        }}
      };
    },
    async put(key, body, metadata={}) {
      const file=location(key);await fs.mkdir(path.dirname(file),{recursive:true});
      const bytes=await new Response(body).arrayBuffer();
      const temp=file+'.'+crypto.randomUUID()+'.tmp';
      await fs.writeFile(temp,Buffer.from(bytes));await fs.rename(temp,file);
      await fs.writeFile(file+'.metadata.json',JSON.stringify(metadata));
      return this.head(key);
    },
    async delete(key){const file=location(key);await fs.rm(file,{force:true});await fs.rm(file+'.metadata.json',{force:true});},
    async list({prefix='',limit=100,cursor,include=[]}={}) {
      const keys=[];
      async function walk(dir,base='') {
        let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
        for(const entry of entries) {
          const key=base+entry.name;
          if(entry.isDirectory())await walk(path.join(dir,entry.name),key+'/');
          else if(entry.isFile()&&!key.endsWith('.metadata.json')&&!key.endsWith('.tmp')&&key.startsWith(prefix))keys.push(key);
        }
      }
      await walk(directory);keys.sort();
      const offset=cursor?Number(cursor):0;
      if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid media cursor');
      const selected=keys.slice(offset,offset+limit),objects=[];
      for(const key of selected)objects.push(describe(key,await load(key)));
      const truncated=offset+selected.length<keys.length;
      return {objects,truncated,cursor:truncated?String(offset+selected.length):undefined};
    }
  };
}
