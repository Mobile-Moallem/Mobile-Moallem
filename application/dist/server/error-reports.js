const reply = (data, status=200, headers={}) => Response.json(data,{status,headers:{'cache-control':'no-store',...headers}});
const initialized = new WeakMap();
async function schema(db) {
  if (!initialized.has(db)) initialized.set(db, db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS error_reports (id TEXT PRIMARY KEY, hymn_id TEXT NOT NULL, title TEXT NOT NULL, section TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL, excerpt TEXT NOT NULL, message TEXT NOT NULL, reporter TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open')`),
    db.prepare(`CREATE INDEX IF NOT EXISTS error_reports_status_date ON error_reports(status, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS error_report_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)`)
  ]).catch(error=>{initialized.delete(db);throw error;}));
  await initialized.get(db);
}
// Read incrementally: Content-Length alone can be absent or false.
async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return null;
  const reader = request.body?.getReader(); if (!reader) return null;
  let size=0; const chunks=[];
  while(true) { const {value,done}=await reader.read(); if(done) break; size+=value.byteLength; if(size>8192){await reader.cancel(); return null;} chunks.push(value); }
  const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch {return null;}
}
export async function takeQuota(db, key, window, maximum) {
  // Atomic conditional update also holds across Workers and concurrent requests.
  const row = await db.prepare(`INSERT INTO error_report_limits(key,window,count) VALUES(?,?,1)
    ON CONFLICT(key) DO UPDATE SET window=excluded.window,
      count=CASE WHEN error_report_limits.window=excluded.window THEN error_report_limits.count+1 ELSE 1 END
    WHERE error_report_limits.window<>excluded.window OR error_report_limits.count<? RETURNING count`).bind(key,window,maximum).first();
  return Boolean(row);
}
export async function errorReports(request,env,{isEditor,validId}) {
  const user = request.headers.get('oai-authenticated-user-id') || request.headers.get('oai-authenticated-user-email')?.toLowerCase();
  if(!user) return reply({error:'Sign in to report an error.'},401);
  if(request.method==='GET') {
    if(!isEditor(request)) return reply({error:'Editor access required.'},403);
    await schema(env.DB);
    const url = new URL(request.url);
    let cursor = null;
    if (url.searchParams.has('cursor')) {
      try { cursor = JSON.parse(url.searchParams.get('cursor')); } catch { return reply({error:'Invalid report cursor.'},400); }
      if (!Array.isArray(cursor) || cursor.length!==2 || !Number.isSafeInteger(cursor[0]) || typeof cursor[1]!=='string' || !/^[a-f0-9-]{36}$/.test(cursor[1])) return reply({error:'Invalid report cursor.'},400);
    }
    const select = "SELECT id,hymn_id,title,section,kind,position,excerpt,message,created_at FROM error_reports WHERE status='open'";
    const query = cursor ? env.DB.prepare(select + " AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT 101").bind(cursor[0],cursor[0],cursor[1]) : env.DB.prepare(select + " ORDER BY created_at DESC,id DESC LIMIT 101");
    const rows = (await query.all()).results || [];
    const reports = rows.slice(0,100), last = reports.at(-1);
    return reply({reports,nextCursor:rows.length>100 ? JSON.stringify([last.created_at,last.id]) : null});
  }
  if(!['POST','PATCH'].includes(request.method)) return reply({error:'Method not allowed.'},405,{Allow:'GET, POST, PATCH'});
  const origin = request.headers.get('origin');
  if(origin!==new URL(request.url).origin || request.headers.get('sec-fetch-site')==='cross-site') return reply({error:'Please send reports from this site.'},403);
  if(request.method==='PATCH' && !isEditor(request)) return reply({error:'Editor access required.'},403);
  const body=await readBody(request);
  if(!body || typeof body!=='object' || Array.isArray(body)) return reply({error:'Invalid report or report too large.'},400);
  await schema(env.DB);
  if(request.method==='PATCH') {
    if(typeof body.id!=='string' || !/^[a-f0-9-]{36}$/.test(body.id)) return reply({error:'Invalid report.'},400);
    await env.DB.prepare("UPDATE error_reports SET status='resolved' WHERE id=?").bind(body.id).run(); return reply({ok:true});
  }
  const now=Date.now(), minuteWindow=Math.floor(now/600000), dayWindow=Math.floor(now/86400000);
  // Count attempts before content lookups, including invalid targets and repeats.
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(user)))).map(n=>n.toString(16).padStart(2,'0')).join('');
  const limits=[['user-short:'+digest,minuteWindow,3,600],['user-day:'+digest,dayWindow,10,86400],['site-short',minuteWindow,100,600],['site-day',dayWindow,1000,86400]];
  for(const [key,window,max,seconds] of limits) if(!await takeQuota(env.DB,key,window,max)) return reply({error:'Report limit reached. Please try again later.'},429,{'Retry-After':String(seconds-Math.floor(now/1000)%seconds)});
  const {hymnId,title,section,kind,position,excerpt,message}=body;
  if(!validId(hymnId) || !['english','coptic','hazzat'].includes(section) || !['word','passage','stack'].includes(kind) || (section!=='hazzat' && kind!=='word') || !Number.isInteger(position) || position<0 || position>12000 || typeof title!=='string' || !title.trim() || title.length>300 || typeof excerpt!=='string' || excerpt.length>500 || typeof message!=='string' || message.trim().length<5 || message.length>2000) return reply({error:'Choose a part and write 5–2,000 characters describing the error.'},400);
  const project=await env.DB.prepare('SELECT hymn_id FROM hymn_projects WHERE hymn_id=? AND status=\'complete\'').bind(hymnId).first();
  let exists=Boolean(project);
  if(!exists){const response=await env.ASSETS.fetch(new Request(new URL('/catalog/'+hymnId.split('/')[0]+'.json',request.url))); if(response.ok){const catalog=await response.json();exists=JSON.stringify(catalog).includes('"'+hymnId+'"');}}
  if(!exists) return reply({error:'This hymn is unavailable. Reload and try again.'},404);
  const duplicate=await env.DB.prepare('SELECT id FROM error_reports WHERE reporter=? AND hymn_id=? AND section=? AND kind=? AND position=? AND message=? AND created_at>? LIMIT 1').bind(digest,hymnId,section,kind,position,message.trim(),now-86400000).first();
  if(duplicate) return reply({ok:true,duplicate:true});
  const id=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO error_reports(id,hymn_id,title,section,kind,position,excerpt,message,reporter,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,hymnId,title.trim(),section,kind,position,excerpt,message.trim(),digest,now).run();
  return reply({ok:true},201);
}
