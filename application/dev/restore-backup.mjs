// Restores only a verified complete backup into an empty LOCAL preview directory.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const backup=path.resolve(process.argv[2]||path.join(root,'../live-backup'));
const destination=process.env.LOCAL_DATA_DIR?path.resolve(process.env.LOCAL_DATA_DIR):path.join(root,'.local');
if(destination===backup||destination.startsWith(backup+path.sep))throw new Error('Restore target must be separate from the backup.');
let entries=[];try{entries=await fs.readdir(destination);}catch(error){if(error.code!=='ENOENT')throw error;}
if(entries.length)throw new Error('Local target is not empty. Preserve or move your existing .local directory first.');
const manifest=JSON.parse(await fs.readFile(path.join(backup,'COMPLETE.json'),'utf8'));
if(manifest.complete!==true||!Array.isArray(manifest.objects)||manifest.objectCount!==manifest.objects.length)throw new Error('Complete verified backup required.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const dbBytes=await fs.readFile(path.join(backup,'mobile-moallem.sqlite'));
if(sha(dbBytes)!==manifest.databaseSha256)throw new Error('Backup database checksum does not match.');
const verified=new DatabaseSync(path.join(backup,'mobile-moallem.sqlite'),{readOnly:true});
if(verified.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Database integrity failed.');
for(const [table,meta] of Object.entries(manifest.tables)){
 if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table))throw new Error('Invalid table name');
 if(verified.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n!==meta.rows)throw new Error('Backup row count mismatch: '+table);
}
verified.close();
for(const object of manifest.objects){
 if(!object.key||object.key.includes('\\')||object.key.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('Unsafe media key');
 const file=path.join(backup,'media',object.key),stat=await fs.stat(file);
 if(stat.size!==object.size||sha(await fs.readFile(file))!==object.sha256)throw new Error('Media checksum mismatch: '+object.key);
 await fs.access(file+'.metadata.json');
}
const staging=destination+'.restore-'+crypto.randomUUID();
await fs.mkdir(staging,{recursive:true});
try{
 await fs.writeFile(path.join(staging,'mobile-moallem.sqlite'),dbBytes);
 await fs.cp(path.join(backup,'media'),path.join(staging,'media'),{recursive:true,errorOnExist:true});
 const local=new DatabaseSync(path.join(staging,'mobile-moallem.sqlite'));
 local.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)');
 const insert=local.prepare('INSERT OR IGNORE INTO _local_migrations (name) VALUES (?)');
 const migrationNames=(await fs.readdir(path.join(root,'drizzle'))).filter(x=>x.endsWith('.sql')).sort();
 if(manifest.tables.__appgarden_migrations?.rows!==migrationNames.length)throw new Error('Source migrations do not match this backup; reconcile them before restoring.');
 for(const name of migrationNames)insert.run(name);
 local.close();
 try{await fs.rmdir(destination);}catch(error){if(error.code!=='ENOENT')throw error;}
 await fs.rename(staging,destination);
}catch(error){await fs.rm(staging,{recursive:true,force:true});throw error;}
console.log(JSON.stringify({restored:true,localDirectory:destination,tables:Object.keys(manifest.tables).length,objects:manifest.objectCount,productionChanged:false}));
