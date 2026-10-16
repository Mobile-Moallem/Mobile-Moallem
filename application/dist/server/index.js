import { sectionConfig, validateAlignment, catalogSource } from './alignment-publish.js';
import { errorReports } from './error-reports.js';
import { referenceAlignment } from './reference-alignment.js';
const EDITOR_EMAIL = "mikailzaki48@gmail.com";
const EDITOR_EMAILS = new Set([EDITOR_EMAIL, "mikezaki174@gmail.com", "jghali514@gmail.com", "davidzaki654@gmail.com", "chrisaawad@gmail.com", "gmmh2006@gmail.com"]);
const EDITOR_ACCOUNT_ID = "60371ed2-84d3-452f-adf4-74c24c065784";
const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const isEditor = request => {
  const accountId = request.headers.get("oai-authenticated-user-id") || "";
  const email = request.headers.get("oai-authenticated-user-email")?.toLowerCase() || "";
  return accountId === EDITOR_ACCOUNT_ID || EDITOR_EMAILS.has(email);
};
const sameOrigin = request => {
  const origin = request.headers.get("origin");
  return (!origin || origin === new URL(request.url).origin) && request.headers.get("sec-fetch-site") !== "cross-site";
};
const validId = id => typeof id === "string" && id.length > 3 && id.length < 240 && /^[a-z0-9-]+(?:\/[a-z0-9-]+){2}$/u.test(id);
const parseTimes = value => Array.isArray(value) && value.length <= 12000 && value.every(t => t == null || (Number.isFinite(t) && t >= 0 && t <= 86400)) ? value : null;
const cleanString = (value, max = 300) => typeof value === "string" ? value.trim().slice(0, max) : "";
const mediaKey = value => typeof value === "string" && /^(recordings|hazzat)\/[a-f0-9-]{36}$/u.test(value) ? value : null;
const escapeHtml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const ownMediaUrl = url => {
  if (typeof url !== "string" || !url.startsWith("/api/media/")) return null;
  return mediaKey(url.slice("/api/media/".length));
};

function projectFromRow(row) {
  if (!row) return null;
  return {
    hymnId: row.hymn_id,
    title: row.title,
    season: row.season,
    service: row.service,
    status: row.status,
    timings: JSON.parse(row.timings_json || "[]"),
    copticTimings: JSON.parse(row.coptic_timings_json || "[]"),
    hazzatTimings: JSON.parse(row.hazzat_timings_json || "[]"),
    hazzatLineTimings: JSON.parse(row.hazzat_line_timings_json || "[]"),
    recordingUrl: row.recording_url || "",
    englishRecordingUrl: row.english_recording_url || "",
    copticRecordingUrl: row.coptic_recording_url || "",
    notationHtml: row.notation_html || "",
    textContent: row.text_content || "",
    copticText: row.coptic_text || "",
    notationKey: row.notation_key || "",
    recordingClips: {},
    hazzatPages: [],
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function getRow(db, hymnId) {
  return db.prepare("SELECT * FROM hymn_projects WHERE hymn_id = ?").bind(hymnId).first();
}

async function ensureLibrarySchema(db) {
  for (let attempt = 0; ; attempt++) {
    try { return await initializeLibrarySchema(db); }
    catch (error) {
      if (attempt >= 2 || !/network connection lost/i.test(String(error?.message))) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function initializeLibrarySchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS hymn_repeat_sections (hymn_id TEXT PRIMARY KEY NOT NULL, sections_json TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hymn_library_presentation (
    hymn_id TEXT PRIMARY KEY NOT NULL,
    title TEXT,
    folder_order INTEGER,
    updated_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS library_nodes (
    node_id TEXT PRIMARY KEY NOT NULL,
    node_type TEXT NOT NULL,
    season_id TEXT,
    category_id TEXT,
    name TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    status TEXT DEFAULT 'draft' NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_library_nodes_owner ON library_nodes (owner_email, node_type, updated_at)").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hymn_library_state (
    hymn_id TEXT PRIMARY KEY NOT NULL,
    sort_order INTEGER,
    is_removed INTEGER DEFAULT 0 NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hymn_recording_clips (
    hymn_id TEXT NOT NULL,
    section TEXT NOT NULL,
    clip_start REAL NOT NULL,
    clip_end REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (hymn_id,section)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hazzat_score_pages (
    hymn_id TEXT NOT NULL,
    score_version TEXT NOT NULL,
    page_index INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    lines_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (hymn_id,score_version,page_index)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hazzat_score_active (
    hymn_id TEXT PRIMARY KEY NOT NULL,
    score_version TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS hymn_title_inheritance (
    target_hymn_id TEXT PRIMARY KEY NOT NULL,
    source_hymn_id TEXT NOT NULL,
    title_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
}

async function projectWithMedia(db, row) {
  if (!row) return null;
  await ensureLibrarySchema(db);
  const [clips, pages, repeats] = await Promise.all([
    db.prepare("SELECT section,clip_start,clip_end FROM hymn_recording_clips WHERE hymn_id = ? ORDER BY section").bind(row.hymn_id).all(),
    db.prepare(`SELECT p.page_index,p.object_key,p.lines_json FROM hazzat_score_pages p
      JOIN hazzat_score_active a ON a.hymn_id=p.hymn_id AND a.score_version=p.score_version
      WHERE p.hymn_id = ? ORDER BY p.page_index`).bind(row.hymn_id).all(),
    db.prepare("SELECT sections_json FROM hymn_repeat_sections WHERE hymn_id = ?").bind(row.hymn_id).first()
  ]);
  const recordingClips = Object.fromEntries((clips.results || []).map(item => [item.section, { start: item.clip_start, end: item.clip_end }]));
  const hazzatPages = row.notation_html ? [] : (pages.results || []).map(item => ({ page: item.page_index, imageUrl: "/api/media/" + item.object_key, lines: JSON.parse(item.lines_json || "[]") }));
  return { ...projectFromRow(row), recordingClips, hazzatPages, repeatSections: JSON.parse(repeats?.sections_json || "[]") };
}

const normalizedHymnTitle = value => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hasTimedValues = value => JSON.parse(value || "[]").some(Number.isFinite);
const normalizedText = value => String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();

async function bestMatchingHymn(db, targetId, title) {
  const key = normalizedHymnTitle(title);
  if (!key) return null;
  const candidates = (await db.prepare(`SELECT hymn_id,title,status,updated_at FROM hymn_projects
    WHERE owner_email = ? AND hymn_id != ? ORDER BY updated_at DESC LIMIT 2000`).bind(EDITOR_EMAIL, targetId).all()).results || [];
  const matches = candidates.filter(row => normalizedHymnTitle(row.title) === key).slice(0, 50);
  const projects = await Promise.all(matches.map(row => getRow(db, row.hymn_id)));
  const score = row => (row.status === "complete" ? 4 : 0) +
    (row.text_content ? 3 : 0) + (row.coptic_text ? 3 : 0) +
    (row.notation_html || row.notation_key ? 4 : 0) +
    (hasTimedValues(row.timings_json) ? 2 : 0) + (hasTimedValues(row.coptic_timings_json) ? 2 : 0) +
    (hasTimedValues(row.hazzat_timings_json) ? 2 : 0) + (hasTimedValues(row.hazzat_line_timings_json) ? 2 : 0);
  return projects.filter(Boolean).filter(row => score(row) > 0).sort((a, b) => score(b) - score(a) || Number(b.updated_at || 0) - Number(a.updated_at || 0))[0] || null;
}

async function activeScorePages(db, hymnId) {
  const rows = (await db.prepare(`SELECT p.page_index,p.object_key,p.lines_json FROM hazzat_score_pages p
    JOIN hazzat_score_active a ON a.hymn_id=p.hymn_id AND a.score_version=p.score_version
    WHERE p.hymn_id=? ORDER BY p.page_index`).bind(hymnId).all()).results || [];
  return rows;
}

async function inheritMatchingHymn(db, targetId, title, season = "", service = "", createIfMissing = false, initialMedia = {}) {
  // The replacement collection has its own source text and must not inherit the old doxologies.
  if (targetId.startsWith("annual/doxologies/")) return await getRow(db, targetId);
  await ensureLibrarySchema(db);
  let target = await getRow(db, targetId);
  if (!target && createIfMissing && validNodeId(season) && service && targetId.startsWith(season + "/")) {
    const source = await bestMatchingHymn(db, targetId, title);
    if (!source) return null;
    const now = Date.now();
    const recordingUrl = cleanString(initialMedia.recordingUrl, 1200), englishRecordingUrl = cleanString(initialMedia.englishRecordingUrl, 1200), copticRecordingUrl = cleanString(initialMedia.copticRecordingUrl, 1200);
    await db.prepare(`INSERT OR IGNORE INTO hymn_projects
      (hymn_id,title,season,service,owner_email,status,timings_json,coptic_timings_json,hazzat_timings_json,hazzat_line_timings_json,recording_url,recording_key,english_recording_url,english_recording_key,coptic_recording_url,coptic_recording_key,updated_at)
      VALUES (?,?,?,?,?,'draft','[]','[]','[]','[]',?,?,?,?,?,?,?)`).bind(targetId,title,season,service,EDITOR_EMAIL,recordingUrl || null,ownMediaUrl(recordingUrl),englishRecordingUrl || null,ownMediaUrl(englishRecordingUrl),copticRecordingUrl || null,ownMediaUrl(copticRecordingUrl),now).run();
    target = await getRow(db, targetId);
  }
  if (!target) return null;
  const marker = await db.prepare("SELECT source_hymn_id FROM hymn_title_inheritance WHERE target_hymn_id=?").bind(targetId).first();
  if (marker) return target;
  const source = await bestMatchingHymn(db, targetId, title || target.title);
  if (!source) return target;

  const [targetPages, sourcePages] = await Promise.all([activeScorePages(db, targetId), activeScorePages(db, source.hymn_id)]);
  const targetHasNotation = Boolean(target.notation_html || target.notation_key || targetPages.length);
  const sourceHasNotation = Boolean(source.notation_html || source.notation_key || sourcePages.length);
  const sameNotation = (!targetHasNotation && !sourceHasNotation) ||
    (Boolean(target.notation_html && target.notation_html === source.notation_html) && !targetPages.length && !sourcePages.length) ||
    (Boolean(target.notation_key && target.notation_key === source.notation_key) && targetPages.length === sourcePages.length && targetPages.every((page, index) => page.object_key === sourcePages[index]?.object_key));
  const take = (existing, incoming) => existing || incoming || null;
  const canCopyEnglish = !target.text_content || normalizedText(target.text_content) === normalizedText(source.text_content);
  const canCopyCoptic = !target.coptic_text || normalizedText(target.coptic_text) === normalizedText(source.coptic_text);
  const canCopyNotation = !targetHasNotation || sameNotation;
  const next = {
    text_content: take(target.text_content, source.text_content),
    coptic_text: take(target.coptic_text, source.coptic_text),
    notation_html: canCopyNotation ? take(target.notation_html, source.notation_html) : target.notation_html,
    notation_key: canCopyNotation ? take(target.notation_key, source.notation_key) : target.notation_key,
    timings_json: Boolean(source.text_content) && canCopyEnglish && !hasTimedValues(target.timings_json) && hasTimedValues(source.timings_json) ? source.timings_json : target.timings_json,
    coptic_timings_json: Boolean(source.coptic_text) && canCopyCoptic && !hasTimedValues(target.coptic_timings_json) && hasTimedValues(source.coptic_timings_json) ? source.coptic_timings_json : target.coptic_timings_json,
    hazzat_timings_json: sourceHasNotation && canCopyNotation && !hasTimedValues(target.hazzat_timings_json) && hasTimedValues(source.hazzat_timings_json) ? source.hazzat_timings_json : target.hazzat_timings_json,
    hazzat_line_timings_json: sourceHasNotation && canCopyNotation && !hasTimedValues(target.hazzat_line_timings_json) && hasTimedValues(source.hazzat_line_timings_json) ? source.hazzat_line_timings_json : target.hazzat_line_timings_json
  };
  const copied = Object.keys(next).some(key => next[key] !== target[key]) || (canCopyNotation && !targetPages.length && sourcePages.length > 0);
  if (copied) {
    const now = Date.now();
    await db.prepare(`UPDATE hymn_projects SET text_content=?,coptic_text=?,notation_html=?,notation_key=?,timings_json=?,coptic_timings_json=?,hazzat_timings_json=?,hazzat_line_timings_json=?,updated_at=? WHERE hymn_id=?`)
      .bind(next.text_content,next.coptic_text,next.notation_html,next.notation_key,next.timings_json,next.coptic_timings_json,next.hazzat_timings_json,next.hazzat_line_timings_json,now,targetId).run();
    if (canCopyNotation && !targetPages.length && sourcePages.length) {
      const scoreVersion = crypto.randomUUID();
      const statements = sourcePages.map(page => db.prepare("INSERT INTO hazzat_score_pages (hymn_id,score_version,page_index,object_key,lines_json,updated_at) VALUES (?,?,?,?,?,?)")
        .bind(targetId,scoreVersion,page.page_index,page.object_key,page.lines_json,now));
      statements.push(db.prepare(`INSERT INTO hazzat_score_active (hymn_id,score_version,updated_at) VALUES (?,?,?)
        ON CONFLICT(hymn_id) DO UPDATE SET score_version=excluded.score_version,updated_at=excluded.updated_at`).bind(targetId,scoreVersion,now));
      await db.batch(statements);
    }
  }
  await db.prepare("INSERT OR IGNORE INTO hymn_title_inheritance (target_hymn_id,source_hymn_id,title_key,updated_at) VALUES (?,?,?,?)")
    .bind(targetId,source.hymn_id,normalizedHymnTitle(source.title),Date.now()).run();
  return await getRow(db, targetId);
}

const validNodeId = id => typeof id === "string" && /^[a-z0-9-]{2,100}$/u.test(id);
const makeNodeId = (prefix, name) => prefix + "-" + (cleanString(name, 60).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "item") + "-" + crypto.randomUUID().slice(0, 8);

async function listLibrary(request, env) {
  await ensureLibrarySchema(env.DB);
  const editor = isEditor(request);
  const rows = (await env.DB.prepare(`SELECT n.node_id,n.node_type,n.season_id,n.category_id,n.name,n.status,n.updated_at,
      p.status AS hymn_status,p.hymn_id,p.title,p.season,p.service,p.timings_json,p.coptic_timings_json,p.hazzat_timings_json,p.hazzat_line_timings_json,
      p.recording_url,p.english_recording_url,p.coptic_recording_url,p.notation_html,p.text_content,p.coptic_text,p.notation_key,p.updated_at AS project_updated_at,p.completed_at
      FROM library_nodes n LEFT JOIN hymn_projects p ON p.hymn_id = n.node_id
      WHERE n.owner_email = ? ORDER BY n.updated_at DESC`).bind(EDITOR_EMAIL).all()).results || [];
  const hymnStateRows = (await env.DB.prepare("SELECT hymn_id,sort_order,is_removed FROM hymn_library_state").all()).results || [];
  const presentationRows = (await env.DB.prepare("SELECT hymn_id,title,folder_order FROM hymn_library_presentation").all()).results || [];
  const hymnState = Object.fromEntries(hymnStateRows.map(row => [row.hymn_id, { order: row.sort_order, removed: Boolean(row.is_removed) }]));
  for (const row of presentationRows) hymnState[row.hymn_id] = { ...hymnState[row.hymn_id], title: row.title, folderOrder: row.folder_order };
  const visibleHymns = rows.filter(row => row.node_type === "hymn" && (editor || row.hymn_status === "complete"));
  const visibleSeasons = new Set(visibleHymns.map(row => row.season_id));
  const visibleCategories = new Set(visibleHymns.map(row => row.category_id));
  return json({
    seasons: rows.filter(row => row.node_type === "season" && (editor || visibleSeasons.has(row.node_id))).map(row => ({ id: row.node_id, name: row.name, custom: true, status: row.status })),
    categories: rows.filter(row => row.node_type === "category" && (editor || visibleCategories.has(row.node_id))).map(row => ({ id: row.node_id, season: row.season_id, name: row.name, custom: true, status: row.status })),
    hymnState,
    hymns: visibleHymns.map(row => ({
      id: row.node_id, name: row.name, season: row.season_id, category: row.category_id, source: "Custom", custom: true,
      project: row.hymn_id ? { hymnId: row.hymn_id, title: row.title, season: row.season, service: row.service, status: row.hymn_status,
        timings: JSON.parse(row.timings_json || "[]"), copticTimings: JSON.parse(row.coptic_timings_json || "[]"), hazzatTimings: JSON.parse(row.hazzat_timings_json || "[]"), hazzatLineTimings: JSON.parse(row.hazzat_line_timings_json || "[]"),
        recordingUrl: row.recording_url || "", englishRecordingUrl: row.english_recording_url || "", copticRecordingUrl: row.coptic_recording_url || "", notationHtml: row.notation_html || "", notationKey: row.notation_key || "", textContent: row.text_content || "", copticText: row.coptic_text || "", updatedAt: row.project_updated_at, completedAt: row.completed_at } : null
    }))
  });
}

async function updateHymnLibraryState(request, env) {
  if (!isEditor(request)) return json({ error: "Only an editor can organize hymns." }, 403);
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  await ensureLibrarySchema(env.DB);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid library change." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid library change." }, 400);
  const now = Date.now();
  if (body.action === "rename") {
    const title = typeof body.title === "string" ? body.title.replace(/\s+/gu, " ").trim() : "";
    if (!validId(body.hymnId) || !title || title.length > 240) return json({ error: "Enter a hymn title between 1 and 240 characters." }, 400);
    await env.DB.prepare(`INSERT INTO hymn_library_presentation (hymn_id,title,updated_at) VALUES (?,?,?)
      ON CONFLICT(hymn_id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`).bind(body.hymnId,title,now).run();
    return json({ saved: true, hymnId: body.hymnId, title });
  }
  if (body.action === "reorder" && body.folderId === "doxologies") {
    const ids = body.hymnIds;
    if (body.seasonId !== "annual" || !Array.isArray(ids) || !ids.length || ids.length > 500 ||
      !ids.every((id,index) => validId(id) && id.startsWith("annual/") && ids.indexOf(id) === index)) return json({ error: "Choose a valid order of doxologies." }, 400);
    await env.DB.batch(ids.map((id,index) => env.DB.prepare(`INSERT INTO hymn_library_presentation (hymn_id,folder_order,updated_at) VALUES (?,?,?)
      ON CONFLICT(hymn_id) DO UPDATE SET folder_order=excluded.folder_order,updated_at=excluded.updated_at`).bind(id,index,now)));
    return json({ saved: true, hymnIds: ids });
  }
  if (body.action === "remove" || body.action === "restore") {
    if (!validId(body.hymnId)) return json({ error: "Choose a valid hymn." }, 400);
    await env.DB.prepare(`INSERT INTO hymn_library_state (hymn_id,sort_order,is_removed,updated_at) VALUES (?,NULL,?,?)
      ON CONFLICT(hymn_id) DO UPDATE SET is_removed=excluded.is_removed,updated_at=excluded.updated_at`)
      .bind(body.hymnId, body.action === "remove" ? 1 : 0, now).run();
    return json({ saved: true, hymnId: body.hymnId, removed: body.action === "remove" });
  }
  if (body.action === "reorder") {
    const seasonId = cleanString(body.seasonId, 100), categoryId = cleanString(body.categoryId, 100), hymnIds = body.hymnIds;
    if (!validNodeId(seasonId) || !validNodeId(categoryId) || !Array.isArray(hymnIds) || hymnIds.length > 500 ||
      !hymnIds.every((id, index) => validId(id) && id.startsWith(seasonId + "/" + categoryId + "/") && hymnIds.indexOf(id) === index)) {
      return json({ error: "Choose one category and a valid order of hymns." }, 400);
    }
    const statements = hymnIds.map((id, index) => env.DB.prepare(`INSERT INTO hymn_library_state (hymn_id,sort_order,is_removed,updated_at) VALUES (?,?,0,?)
      ON CONFLICT(hymn_id) DO UPDATE SET sort_order=excluded.sort_order,updated_at=excluded.updated_at`).bind(id, index, now));
    if (statements.length) await env.DB.batch(statements);
    return json({ saved: true, hymnIds });
  }
  return json({ error: "Unknown library change." }, 400);
}

async function createLibraryNode(request, env, type) {
  if (!isEditor(request)) return json({ error: "Only the project editor can add library content." }, 403);
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  await ensureLibrarySchema(env.DB);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid library data." }, 400); }
  const name = cleanString(body.name, 240);
  if (!name) return json({ error: "Enter a name." }, 400);
  const now = Date.now();
  if (type === "season") {
    const id = makeNodeId("custom-season", name);
    await env.DB.prepare("INSERT INTO library_nodes (node_id,node_type,name,owner_email,status,updated_at) VALUES (?,?,?,?,'draft',?)").bind(id, type, name, EDITOR_EMAIL, now).run();
    return json({ node: { id, type, name, custom: true } });
  }
  const seasonId = cleanString(body.seasonId, 100);
  if (!validNodeId(seasonId)) return json({ error: "Choose a valid season." }, 400);
  if (type === "category") {
    const id = makeNodeId("custom-category", name);
    await env.DB.prepare("INSERT INTO library_nodes (node_id,node_type,season_id,name,owner_email,status,updated_at) VALUES (?,?,?,?,?,'draft',?)").bind(id, type, seasonId, name, EDITOR_EMAIL, now).run();
    return json({ node: { id, type, season: seasonId, name, custom: true } });
  }
  const categoryId = cleanString(body.categoryId, 100);
  if (!validNodeId(categoryId)) return json({ error: "Choose a valid category." }, 400);
  const id = seasonId + "/" + categoryId + "/" + makeNodeId("custom-hymn", name);
  const textContent = typeof body.textContent === "string" ? body.textContent.slice(0, 100_000) : "";
  const copticText = typeof body.copticText === "string" ? body.copticText.slice(0, 100_000) : "";
  const notationHtml = typeof body.notationHtml === "string" ? body.notationHtml.slice(0, 1_000_000) : "";
  await env.DB.prepare("INSERT INTO library_nodes (node_id,node_type,season_id,category_id,name,owner_email,status,updated_at) VALUES (?,?,?,?,?,?,'draft',?)").bind(id, type, seasonId, categoryId, name, EDITOR_EMAIL, now).run();
  await env.DB.prepare(`INSERT INTO hymn_projects
    (hymn_id,title,season,service,owner_email,status,timings_json,coptic_timings_json,hazzat_timings_json,hazzat_line_timings_json,notation_html,text_content,coptic_text,updated_at)
    VALUES (?,?,?,?,?,'draft','[]','[]','[]','[]',?,?,?,?)`).bind(id, name, seasonId, categoryId, EDITOR_EMAIL, notationHtml || null, textContent || null, copticText || null, now).run();
  await inheritMatchingHymn(env.DB, id, name, seasonId, categoryId);
  return json({ node: { id, type, season: seasonId, category: categoryId, name, custom: true }, project: projectFromRow(await getRow(env.DB, id)) });
}

async function saveProject(request, env, hymnId) {
  if (!isEditor(request)) return json({ error: "Only the project editor can save hymns." }, 403);
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  if (!validId(hymnId)) return json({ error: "Invalid hymn." }, 400);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 2_000_000) return json({ error: "Project data is too large." }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid project data." }, 400); }
  const title = cleanString(body.title);
  const season = cleanString(body.season, 100);
  const service = cleanString(body.service, 200);
  const timings = parseTimes(body.timings);
  const copticTimings = parseTimes(body.copticTimings ?? []);
  const hazzatTimings = parseTimes(body.hazzatTimings);
  const hazzatLineTimings = parseTimes(body.hazzatLineTimings);
  if (!title || !season || !service || !timings || !copticTimings || !hazzatTimings || !hazzatLineTimings) return json({ error: "Incomplete or invalid timing data." }, 400);
  if (!hymnId.startsWith(season + "/")) return json({ error: "Season does not match hymn." }, 400);
  const recordingUrl = cleanString(body.recordingUrl, 1200);
  const englishRecordingUrl = cleanString(body.englishRecordingUrl, 1200);
  const copticRecordingUrl = cleanString(body.copticRecordingUrl, 1200);
  for (const url of [recordingUrl, englishRecordingUrl, copticRecordingUrl]) {
    if (url && !/^https:\/\//u.test(url) && !ownMediaUrl(url)) return json({ error: "Recording URL must be secure." }, 400);
    const key = ownMediaUrl(url);
    if (key && !await env.BUCKET.head(key)) return json({ error: "Uploaded recording is unavailable." }, 400);
  }
  const recordingKey = ownMediaUrl(recordingUrl);
  const englishRecordingKey = ownMediaUrl(englishRecordingUrl);
  const copticRecordingKey = ownMediaUrl(copticRecordingUrl);
  const notationHtml = typeof body.notationHtml === "string" ? body.notationHtml.slice(0, 1_000_000) : "";
  const textContent = typeof body.textContent === "string" ? body.textContent.slice(0, 100_000) : "";
  const copticText = typeof body.copticText === "string" ? body.copticText.slice(0, 100_000) : "";
  const notationKey = mediaKey(body.notationKey);
  if (notationKey && !await env.BUCKET.head(notationKey)) return json({ error: "Uploaded Hazzat is unavailable." }, 400);
  const repeats = body.repeatSections;
  if (repeats !== undefined && (!Array.isArray(repeats) || repeats.length > 100 || repeats.some(section => {
    const keys = ['timings','copticTimings','hazzatTimings','hazzatLineTimings'];
    return !section || !keys.includes(section.key) || !Number.isInteger(section.startIndex) || !Number.isInteger(section.endIndex) || section.startIndex < 0 || section.endIndex < section.startIndex || section.endIndex > 20000 || !Array.isArray(section.passes) || !section.passes.length || section.passes.length > 9 || section.passes.some(pass => !Array.isArray(pass) || pass.length !== section.endIndex - section.startIndex + 1 || !parseTimes(pass) || pass.some((t,i) => Number.isFinite(t) && pass.slice(0,i).some(previous => Number.isFinite(previous) && previous > t)));
  }))) return json({ error: "Invalid repeated section or pass timings." }, 400);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO hymn_projects
    (hymn_id,title,season,service,owner_email,status,timings_json,coptic_timings_json,hazzat_timings_json,hazzat_line_timings_json,recording_url,recording_key,english_recording_url,english_recording_key,coptic_recording_url,coptic_recording_key,notation_html,notation_key,text_content,coptic_text,updated_at,completed_at)
    VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(hymn_id) DO UPDATE SET
      title=excluded.title,season=excluded.season,service=excluded.service,status='draft',
      timings_json=excluded.timings_json,coptic_timings_json=excluded.coptic_timings_json,hazzat_timings_json=excluded.hazzat_timings_json,
      hazzat_line_timings_json=excluded.hazzat_line_timings_json,
      recording_url=excluded.recording_url,recording_key=excluded.recording_key,
      english_recording_url=excluded.english_recording_url,english_recording_key=excluded.english_recording_key,
      coptic_recording_url=excluded.coptic_recording_url,coptic_recording_key=excluded.coptic_recording_key,
      notation_html=excluded.notation_html,notation_key=excluded.notation_key,text_content=excluded.text_content,coptic_text=excluded.coptic_text,
      updated_at=excluded.updated_at,completed_at=NULL`)
    .bind(hymnId,title,season,service,EDITOR_EMAIL,JSON.stringify(timings),JSON.stringify(copticTimings),JSON.stringify(hazzatTimings),JSON.stringify(hazzatLineTimings),recordingUrl || null,recordingKey,englishRecordingUrl || null,englishRecordingKey,copticRecordingUrl || null,copticRecordingKey,notationHtml || null,notationKey,textContent || null,copticText || null,now).run();
  await ensureLibrarySchema(env.DB);
  if (repeats !== undefined) await env.DB.prepare("INSERT INTO hymn_repeat_sections (hymn_id,sections_json) VALUES (?,?) ON CONFLICT(hymn_id) DO UPDATE SET sections_json=excluded.sections_json").bind(hymnId, JSON.stringify(repeats)).run();
  await env.DB.prepare("UPDATE library_nodes SET status = 'draft', updated_at = ? WHERE node_id = ? AND owner_email = ?").bind(now, hymnId, EDITOR_EMAIL).run();
  await inheritMatchingHymn(env.DB, hymnId, title, season, service);
  return json({ project: await projectWithMedia(env.DB, await getRow(env.DB, hymnId)) });
}

async function publishAlignment(request, env, hymnId) {
  if (!isEditor(request)) return json({ error: "Only the project editor can publish hymns." }, 403);
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  if (!validId(hymnId)) return json({ error: "Invalid hymn." }, 400);
  if (Number(request.headers.get('content-length') || 0) > 2_000_000) return json({ error: "Alignment data is too large." }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid alignment data." }, 400); }
  if (!body || typeof body !== 'object' || !sectionConfig(body.section)) return json({ error: "Choose a supported alignment section." }, 400);
  const row = await getRow(env.DB, hymnId);
  if (!row || row.owner_email !== EDITOR_EMAIL) return json({ error: "Save the hymn before publishing its alignment." }, 404);
  const config = sectionConfig(body.section);
  let source = row[config.source] || '';
  if (!source) {
    const [season, service, id] = hymnId.split('/');
    const catalog = await env.ASSETS.fetch(new Request(new URL('/catalog/' + season + '.json', request.url)));
    if (!catalog.ok) return json({ error: "The hymn text or notation could not be checked." }, 409);
    const services = await catalog.json();
    const hymn = services.find(s => s.id === service)?.hymns?.find(h => h.id === id);
    source = catalogSource(hymn, body.section);
  }
  try { validateAlignment(body, row, source); } catch (error) { return json({ error: error.message }, 400); }
  const serialized = JSON.stringify(body.timings);
  if (row.status === 'complete' && row[config.times] === serialized) return json({ project: await projectWithMedia(env.DB, row) });
  if (!Number.isFinite(body.expectedUpdatedAt) || body.expectedUpdatedAt !== row.updated_at) return json({ error: "This hymn changed since the publish window opened. Close it and reopen Publish from your review." }, 409);
  await ensureLibrarySchema(env.DB);
  const now = Math.max(Date.now(), row.updated_at + 1);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE hymn_projects SET ${config.times} = ?, status = 'complete', updated_at = ?, completed_at = ? WHERE hymn_id = ? AND owner_email = ? AND updated_at = ?`)
      .bind(serialized, now, now, hymnId, EDITOR_EMAIL, body.expectedUpdatedAt),
    env.DB.prepare("UPDATE library_nodes SET status = 'complete', updated_at = ? WHERE node_id = ? AND owner_email = ? AND EXISTS (SELECT 1 FROM hymn_projects WHERE hymn_id = ? AND updated_at = ? AND completed_at = ?)")
      .bind(now, hymnId, EDITOR_EMAIL, hymnId, now, now)
  ]);
  if (results[0].meta?.changes !== 1) return json({ error: "The hymn changed while publishing. Reopen Publish to review its current state." }, 409);
  return json({ project: await projectWithMedia(env.DB, await getRow(env.DB, hymnId)) });
}

async function completeProject(request, env, hymnId) {
  if (!isEditor(request)) return json({ error: "Only the project editor can complete hymns." }, 403);
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  if (!validId(hymnId)) return json({ error: "Invalid hymn." }, 400);
  const row = await getRow(env.DB, hymnId);
  if (!row || row.owner_email !== EDITOR_EMAIL) return json({ error: "Save the project first." }, 404);
  const hasTiming = raw => JSON.parse(raw || "[]").some(Number.isFinite);
  const ready = (row.recording_url && (hasTiming(row.hazzat_timings_json) || hasTiming(row.hazzat_line_timings_json))) ||
    (row.english_recording_url && hasTiming(row.timings_json)) ||
    (row.coptic_recording_url && hasTiming(row.coptic_timings_json));
  if (!ready) return json({ error: "Choose a recording and mark passages in the same section before completing." }, 400);
  const now = Date.now();
  await env.DB.prepare("UPDATE hymn_projects SET status = 'complete', updated_at = ?, completed_at = ? WHERE hymn_id = ? AND owner_email = ?")
    .bind(now,now,hymnId,EDITOR_EMAIL).run();
  await ensureLibrarySchema(env.DB);
  await env.DB.prepare("UPDATE library_nodes SET status = 'complete', updated_at = ? WHERE node_id = ? AND owner_email = ?").bind(now, hymnId, EDITOR_EMAIL).run();
  return json({ project: await projectWithMedia(env.DB, await getRow(env.DB, hymnId)) });
}

async function uploadFile(request, env, hymnId, kind, section = "hazzat") {
  if (!isEditor(request)) return json({ error: "Only the project editor can upload files." }, 403);
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  if (!validId(hymnId)) return json({ error: "Invalid hymn." }, 400);
  await ensureLibrarySchema(env.DB);
  const row = await getRow(env.DB, hymnId);
  if (!row || row.owner_email !== EDITOR_EMAIL) return json({ error: "Save the project before uploading." }, 404);
  const type = request.headers.get("content-type") || "";
  const length = Number(request.headers.get("content-length") || 0);
  if (!request.body) return json({ error: "Choose a file to upload." }, 400);
  if (kind === "audio") {
    if (!["hazzat", "english", "coptic"].includes(section)) return json({ error: "Invalid recording section." }, 400);
    if (!(/^audio\//u.test(type) || type === "application/octet-stream")) return json({ error: "Choose an audio recording." }, 415);
    if (length > 100_000_000) return json({ error: "Recording exceeds 100 MB." }, 413);
  } else {
    if (!/^(text\/plain|text\/html|application\/octet-stream)/u.test(type)) return json({ error: "Choose a text or HTML Hazzat file." }, 415);
    if (length > 1_000_000) return json({ error: "Hazzat file exceeds 1 MB." }, 413);
  }
  const key = (kind === "audio" ? "recordings/" : "hazzat/") + crypto.randomUUID();
  if (kind === "audio") {
    await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: type } });
    const mediaUrl = "/api/media/" + key;
    const columns = section === "english" ? ["english_recording_url", "english_recording_key"] : section === "coptic" ? ["coptic_recording_url", "coptic_recording_key"] : ["recording_url", "recording_key"];
    const config = alignmentSection(section);
    const now = Date.now();
    const reference = { source: row[config.source] || "", times: JSON.parse(row[config.times] || "[]") };
    const payload = { reference, content: row[config.content] || "", baseline: "[]", baselineLines: "[]", granularity: section === "hazzat" ? "piece" : "word" };
    await env.DB.batch([
      env.DB.prepare(`UPDATE hymn_projects SET ${columns[0]} = ?, ${columns[1]} = ?, ${config.times} = '[]'${section === "hazzat" ? ", hazzat_line_timings_json = '[]'" : ""}, status = 'draft', updated_at = ?, completed_at = NULL WHERE hymn_id = ? AND owner_email = ?`)
        .bind(mediaUrl,key,now,hymnId,EDITOR_EMAIL),
      env.DB.prepare("DELETE FROM hymn_recording_clips WHERE hymn_id = ? AND section = ?").bind(hymnId, section),
      env.DB.prepare(`INSERT INTO alignment_suggestions (id,hymn_id,section,source_url,status,payload_json,version,updated_at)
        VALUES (?,?,?,?,'queued',?,1,?) ON CONFLICT(hymn_id,section) DO UPDATE SET
        id=excluded.id,source_url=excluded.source_url,status='queued',payload_json=excluded.payload_json,version=1,updated_at=excluded.updated_at`)
        .bind(crypto.randomUUID(),hymnId,section,mediaUrl,JSON.stringify(payload),now)
    ]);

  } else {
    const content = await request.text();
    if (content.length > 1_000_000) return json({ error: "Hazzat file exceeds 1 MB." }, 413);
    await env.BUCKET.put(key, content, { httpMetadata: { contentType: type } });
    const html = type.startsWith("text/plain") ? escapeHtml(content).replace(/\r?\n/gu, "<br>") : content;
    await env.DB.batch([
      env.DB.prepare("UPDATE hymn_projects SET notation_html = ?, notation_key = ?, hazzat_timings_json = '[]', hazzat_line_timings_json = '[]', status = 'draft', updated_at = ?, completed_at = NULL WHERE hymn_id = ? AND owner_email = ?")
        .bind(html,key,Date.now(),hymnId,EDITOR_EMAIL)
    ]);
  }
  return json({ project: await projectWithMedia(env.DB, await getRow(env.DB, hymnId)) });
}

async function saveRecordingClip(request, env, hymnId) {
  if (!isEditor(request)) return json({ error: "Editor access required." }, 403);
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  if (!validId(hymnId)) return json({ error: "Invalid hymn." }, 400);
  await ensureLibrarySchema(env.DB);
  const row = await getRow(env.DB, hymnId);
  if (!row || row.owner_email !== EDITOR_EMAIL) return json({ error: "Save this hymn before choosing a clip." }, 404);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid clip selection." }, 400); }
  const section = body.section, config = alignmentSection(section);
  if (!config || !row[config.source]) return json({ error: "Add a recording to this section first." }, 400);
  const now = Date.now();
  if (body.action === "clear") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM hymn_recording_clips WHERE hymn_id = ? AND section = ?").bind(hymnId, section),
      env.DB.prepare(`UPDATE hymn_projects SET ${config.times} = '[]'${section === "hazzat" ? ", hazzat_line_timings_json = '[]'" : ""}, status='draft',updated_at=?,completed_at=NULL WHERE hymn_id=? AND owner_email=?`).bind(now,hymnId,EDITOR_EMAIL)
    ]);
  } else {
    const start = Number(body.start), end = Number(body.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 86400 || end - start < 0.5) return json({ error: "Choose a valid range of at least half a second." }, 400);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO hymn_recording_clips (hymn_id,section,clip_start,clip_end,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(hymn_id,section) DO UPDATE SET clip_start=excluded.clip_start,clip_end=excluded.clip_end,updated_at=excluded.updated_at`).bind(hymnId,section,start,end,now),
      env.DB.prepare(`UPDATE hymn_projects SET ${config.times} = '[]'${section === "hazzat" ? ", hazzat_line_timings_json = '[]'" : ""}, status='draft',updated_at=?,completed_at=NULL WHERE hymn_id=? AND owner_email=?`).bind(now,hymnId,EDITOR_EMAIL)
    ]);
  }
  return json({ project: await projectWithMedia(env.DB, await getRow(env.DB, hymnId)) });
}

async function uploadHazzatScore(request, env, hymnId) {
  if (!isEditor(request)) return json({ error: "Editor access required." }, 403);
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  if (!validId(hymnId)) return json({ error: "Invalid hymn." }, 400);
  await ensureLibrarySchema(env.DB);
  const row = await getRow(env.DB, hymnId);
  if (!row || row.owner_email !== EDITOR_EMAIL) return json({ error: "Save this hymn before uploading Hazzat." }, 404);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 45_000_000) return json({ error: "Choose a score smaller than 40 MB after page conversion." }, 413);
  let form, metadata;
  try {
    form = await request.formData();
    metadata = JSON.parse(String(form.get("pages") || ""));
  } catch { return json({ error: "Could not read the Hazzat pages." }, 400); }
  if (!Array.isArray(metadata) || metadata.length < 1 || metadata.length > 30) return json({ error: "Upload between 1 and 30 score pages." }, 400);
  const uploads = [];
  let totalBytes = 0;
  for (let index = 0; index < metadata.length; index++) {
    const file = form.get("page" + index), lines = metadata[index]?.lines;
    if (!file || typeof file.arrayBuffer !== "function" || !["image/jpeg","image/png","image/webp"].includes(file.type) || file.size < 1 || file.size > 8_000_000 || !Array.isArray(lines) || !lines.length || lines.length > 100) return json({ error: "Each page needs an image smaller than 8 MB and detected Hazzat lines." }, 400);
    totalBytes += file.size;
    if (totalBytes > 35_000_000) return json({ error: "The converted score is too large. Try fewer or smaller pages." }, 413);
    let priorTop = -1;
    const safeLines = [];
    for (const line of lines) {
      const top = Number(line?.top), height = Number(line?.height);
      if (!Number.isFinite(top) || !Number.isFinite(height) || top < 0 || height <= 0 || top + height > 1.001 || top < priorTop) return json({ error: "The page contains invalid line positions." }, 400);
      priorTop = top;
      safeLines.push({ top, height });
    }
    uploads.push({ file, page: index, lines: safeLines, key: "hazzat/" + crypto.randomUUID() });
  }
  const scoreVersion = crypto.randomUUID();
  try {
    await Promise.all(uploads.map(item => env.BUCKET.put(item.key, item.file.stream(), { httpMetadata: { contentType: item.file.type } })));
    const now = Date.now();
    const statements = [];
    for (const item of uploads) statements.push(env.DB.prepare("INSERT INTO hazzat_score_pages (hymn_id,score_version,page_index,object_key,lines_json,updated_at) VALUES (?,?,?,?,?,?)").bind(hymnId,scoreVersion,item.page,item.key,JSON.stringify(item.lines),now));
    statements.push(env.DB.prepare(`INSERT INTO hazzat_score_active (hymn_id,score_version,updated_at) VALUES (?,?,?)
      ON CONFLICT(hymn_id) DO UPDATE SET score_version=excluded.score_version,updated_at=excluded.updated_at`).bind(hymnId,scoreVersion,now));
    statements.push(env.DB.prepare("UPDATE hymn_projects SET notation_html=NULL,notation_key=NULL,hazzat_timings_json='[]',hazzat_line_timings_json='[]',status='draft',updated_at=?,completed_at=NULL WHERE hymn_id=? AND owner_email=?").bind(now,hymnId,EDITOR_EMAIL));
    statements.push(env.DB.prepare("UPDATE alignment_suggestions SET status='rejected',version=version+1,updated_at=? WHERE hymn_id=? AND section='hazzat' AND status IN ('queued','needs_content','pending','failed')").bind(now,hymnId));
    await env.DB.batch(statements);
  } catch (error) {
    await Promise.all(uploads.map(item => env.BUCKET.delete(item.key).catch(() => {})));
    throw error;
  }
  return json({ project: await projectWithMedia(env.DB, await getRow(env.DB, hymnId)) });
}

async function serveReferenceMedia(request, env, key) {
  const object = await env.BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "cache-control": "private, no-store" });
  object.writeHttpMetadata(headers);
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

const alignmentSection = section => ({
  hazzat: { source: "recording_url", times: "hazzat_timings_json", content: "notation_html" },
  english: { source: "english_recording_url", times: "timings_json", content: "text_content" },
  coptic: { source: "coptic_recording_url", times: "coptic_timings_json", content: "coptic_text" }
})[section];
const suggestionFromRow = row => ({ id: row.id, hymnId: row.hymn_id, section: row.section, source: row.source_url,
  status: row.status, version: row.version, updatedAt: row.updated_at, ...JSON.parse(row.payload_json) });
const validSuggestionTimes = (times, parts, duration) => Array.isArray(times) && times.length === parts.length &&
  times.every((t, i) => Number.isFinite(t) && t >= 0 && t < duration && (i === 0 || t >= times[i-1]));

async function alignmentSuggestions(request, env, hymnId) {
  if (!isEditor(request)) return json({ error: "Editor access required." }, 403);
  if (!validId(hymnId)) return json({ error: "Invalid hymn." }, 400);
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM alignment_suggestions WHERE hymn_id = ? ORDER BY section").bind(hymnId).all();
    return json({ suggestions: (rows.results || []).map(suggestionFromRow) });
  }
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  const raw = await request.text();
  if (raw.length > 2_000_000) return json({ error: "Suggestion is too large." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid suggestion." }, 400); }
  const row = await env.DB.prepare("SELECT * FROM alignment_suggestions WHERE hymn_id = ? AND id = ?").bind(hymnId, body.id || "").first();
  if (!row || row.version !== body.version) return json({ error: "This suggestion changed. Reload it before continuing." }, 409);
  const project = await getRow(env.DB, hymnId);
  const config = alignmentSection(row.section);
  if (!project || project.owner_email !== EDITOR_EMAIL || project[config.source] !== row.source_url) return json({ error: "The recording changed. This suggestion is no longer current." }, 409);
  const data = JSON.parse(row.payload_json);
  let status = row.status;
  const action = body.action;
  if (row.section === "hazzat" && data.granularity !== "piece" && ["result", "edit", "accept"].includes(action)) return json({ error: "Reload this hymn to prepare a separate guess for each Hazzat piece." }, 409);
  if (action === "prepare") {
    if (!["queued", "needs_content", "failed"].includes(status)) return json({ error: "This suggestion is already ready for review." }, 409);
    if (!Array.isArray(body.parts) || body.parts.length > 12000 || !body.parts.every(p => typeof p.label === "string" && p.label.length <= 2000 && Number.isFinite(p.weight) && p.weight > 0 && p.weight <= 10000)) return json({ error: "Invalid alignment parts." }, 400);
    if (row.section === "hazzat" && (body.granularity !== "piece" || !body.parts.every((p,i) => typeof p.glyph === "string" && p.glyph.length <= 2000 && ["HazzatFont", "HazzatVFont"].includes(p.font) && Number.isInteger(p.stack) && p.stack >= 0 && p.stack < 12000 && (!i || p.stack >= body.parts[i-1].stack)))) return json({ error: "Reload to align individual Hazzat pieces." }, 400);
    if (row.section === "hazzat" && data.granularity !== "piece") data.reference = null;
    data.granularity = row.section === "hazzat" ? "piece" : "word";
    // Content can be added after an upload. Old manual marks are reusable only for identical content.
    if (data.content !== (project[config.content] || "")) data.reference = null;
    data.content = project[config.content] || "";
    data.baseline = project[config.times] || "[]";
    data.baselineLines = project.hazzat_line_timings_json || "[]";
    data.parts = body.parts;
    data.signature = cleanString(body.signature, 100);
    data.message = "";
    status = body.parts.length ? "queued" : "needs_content";
  } else if (action === "result") {
    if (status !== "queued" || !data.parts?.length) return json({ error: "This upload is not waiting for analysis." }, 409);
    if (data.content !== (project[config.content] || "")) return json({ error: "The text changed during analysis. Reload to prepare a new suggestion." }, 409);
    if (!Number.isFinite(body.duration) || body.duration <= 0 || body.duration > 86400 || !validSuggestionTimes(body.times, data.parts, body.duration)) return json({ error: "Invalid suggested times." }, 400);
    data.times = body.times;
    data.duration = body.duration;
    data.method = ["reference", "hazzat-reader"].includes(body.method) ? body.method : "phrase-estimate";
    data.message = cleanString(body.message, 500);
    status = "pending";
  } else if (action === "edit" || action === "accept") {
    if (status !== "pending") return json({ error: "Only pending suggestions can be edited or accepted." }, 409);
    if (data.content !== (project[config.content] || "") || body.signature !== data.signature) return json({ error: "The words or Hazzat changed. Reject this suggestion and prepare it again." }, 409);
    if (!validSuggestionTimes(body.times, data.parts || [], data.duration)) return json({ error: "Times must be in order and within the recording." }, 400);
    data.times = body.times;
    if (action === "accept") {
      if ((project[config.times] || "[]") !== data.baseline || (row.section === "hazzat" && (project.hazzat_line_timings_json || "[]") !== data.baselineLines)) return json({ error: "Manual timings have changed since this suggestion was made. Your manual work is saved; reject this suggestion to keep it." }, 409);
      const now = Date.now();
      const stackTimes = [];
      if (row.section === "hazzat") data.parts.forEach((part,i) => { if (stackTimes[part.stack] === undefined) stackTimes[part.stack] = data.times[i]; });
      const extraValues = row.section === "hazzat" ? [JSON.stringify(stackTimes)] : [];
      const update = await env.DB.batch([
        env.DB.prepare(`UPDATE hymn_projects SET ${config.times} = ?${row.section === "hazzat" ? ", hazzat_line_timings_json = ?" : ""}, status = 'draft', completed_at = NULL, updated_at = ?
          WHERE hymn_id = ? AND ${config.source} = ? AND COALESCE(${config.content}, '') = ? AND ${config.times} = ? AND (? != 'hazzat' OR hazzat_line_timings_json = ?)
          AND EXISTS (SELECT 1 FROM alignment_suggestions WHERE id = ? AND version = ? AND status = 'pending')`)
          .bind(JSON.stringify(data.times),...extraValues,now,hymnId,row.source_url,data.content,data.baseline,row.section,data.baselineLines,row.id,row.version),
        env.DB.prepare(`UPDATE alignment_suggestions SET status = 'accepted', payload_json = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND EXISTS (SELECT 1 FROM hymn_projects WHERE hymn_id = ? AND updated_at = ?)`)
          .bind(JSON.stringify(data),now,row.id,row.version,hymnId,now)
      ]);
      if (!update[0].meta.changes) return json({ error: "The hymn changed while accepting. Reload to protect your latest edits." }, 409);
      return json({ suggestion: suggestionFromRow(await env.DB.prepare("SELECT * FROM alignment_suggestions WHERE id = ?").bind(row.id).first()), project: await projectWithMedia(env.DB, await getRow(env.DB,hymnId)) });
    }
  } else if (action === "refine") {
    if (row.section !== "hazzat" || data.granularity === "piece" || !["pending", "accepted"].includes(status)) return json({ error: "This suggestion already uses individual pieces." }, 409);
    data.previousStackSuggestion = { times: data.times || [], status };
    data.reference = null;
    delete data.times;
    status = "queued";
  } else if (action === "reject") {
    if (status === "accepted") return json({ error: "Use manual alignment to change accepted timings." }, 409);
    status = "rejected";
  } else if (action === "retry") {
    if (!["failed", "rejected", "needs_content"].includes(status)) return json({ error: "This suggestion cannot be retried yet." }, 409);
    status = "queued";
    data.message = "";
    delete data.times;
  } else if (action === "fail") {
    if (status !== "queued") return json({ error: "This analysis has already finished." }, 409);
    status = "failed";
    data.message = cleanString(body.message, 500);
  } else return json({ error: "Unknown suggestion action." }, 400);
  const changed = await env.DB.prepare("UPDATE alignment_suggestions SET status = ?, payload_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
    .bind(status,JSON.stringify(data),Date.now(),row.id,row.version).run();
  if (!changed.meta.changes) return json({ error: "This suggestion changed in another window. Reload it." }, 409);
  return json({ suggestion: suggestionFromRow(await env.DB.prepare("SELECT * FROM alignment_suggestions WHERE id = ?").bind(row.id).first()) });
}

async function serveMedia(request, env, key) {
  if (!mediaKey(key)) return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT status FROM hymn_projects WHERE recording_key = ? OR english_recording_key = ? OR coptic_recording_key = ? OR notation_key = ? LIMIT 1").bind(key,key,key,key).first();
  // Immutable earlier uploads remain available to editors reviewing exported references.
  if (!row && isEditor(request) && key.startsWith('recordings/')) return serveReferenceMedia(request, env, key);
  if (!row && isEditor(request)) {
    const reference = await env.DB.prepare("SELECT id FROM alignment_suggestions WHERE json_extract(payload_json, '$.reference.source') = ? LIMIT 1").bind("/api/media/" + key).first();
    if (reference) return serveReferenceMedia(request, env, key);
  }
  if (!row || (row.status !== "complete" && !isEditor(request))) return new Response("Not found", { status: 404 });
  const object = await env.BUCKET.get(key, { range: request.headers });
  if (!object?.body) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", row.status === "complete" ? "public, max-age=3600" : "private, no-store");
  if (object.range) {
    headers.set("content-range", `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
    headers.set("content-length", String(object.range.length));
  } else headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: object.range ? 206 : 200, headers });
}

async function analysisAudio(request, listener = false) {
  if ((!listener && !isEditor(request)) || !sameOrigin(request)) return json({ error: "Editor access required." }, 403);
  const raw = new URL(request.url).searchParams.get("url") || "";
  let source;
  try { source = new URL(raw); } catch { return json({ error: "Invalid recording URL." }, 400); }
  if (source.protocol !== "https:" || source.hostname !== "media.tasbeha.org" || source.port || source.username || source.password || !source.pathname.startsWith("/mp3/")) {
    return json({ error: "This recording source cannot be analyzed yet." }, 400);
  }
  let response;
  try {
    response = await fetch(source.toString(), { redirect: "manual", signal: AbortSignal.timeout(30000) });
  } catch {
    return json({ error: "The recording source could not be reached. Please try again." }, 502);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return json({ error: "The recording source redirected instead of returning audio." }, 502);
  }
  if (!response.ok || !response.body) return json({ error: "Could not load the recording for analysis." }, 502);
  const length = Number(response.headers.get("content-length"));
  if (!Number.isFinite(length) || length < 1 || length > 25_000_000) {
    await response.body.cancel();
    return json({ error: "This reference recording is too large to analyze." }, 413);
  }
  if (!/^audio\//u.test(response.headers.get("content-type") || "")) {
    await response.body.cancel();
    return json({ error: "The recording source did not return audio." }, 502);
  }
  return new Response(response.body, {
    headers: { "content-type": response.headers.get("content-type") || "audio/mpeg", "content-length": String(length), "cache-control": "private, no-store" }
  });
}

async function voiceExample(request, env, hymnId) {
  if (!isEditor(request) || !sameOrigin(request)) return json({ error: "Editor access required." }, 403);
  if (!validId(hymnId)) return json({ error: "Invalid hymn." }, 400);
  const prefix = "voice-examples/" + hymnId + "/";
  if (request.method === "GET") {
    const items = await env.BUCKET.list({ prefix, limit: 100, include: ["customMetadata"] });
    return json({ examples: items.objects.map(item => ({ key: item.key, start: Number(item.customMetadata?.start), section: item.customMetadata?.section, createdAt: item.customMetadata?.createdAt })) });
  }
  if (Number(request.headers.get("content-length")) > 10_100_000) return json({ error: "Choose a sample smaller than 10 MB." }, 413);
  const form = await request.formData();
  const sample = form.get("sample"), section = form.get("section"), start = Number(form.get("start")), source = form.get("source");
  if (!sample || typeof sample.arrayBuffer !== "function" || sample.size < 1 || sample.size > 10_000_000 || !sample.type.startsWith("audio/")) return json({ error: "A short audio sample is required." }, 400);
  if (!["hazzat", "coptic", "english"].includes(section) || form.get("start") === null || !Number.isFinite(start) || start < 0 || start > 86400 || typeof source !== "string" || source.length > 1200) return json({ error: "Choose a valid recording time." }, 400);
  const key = prefix + crypto.randomUUID();
  await env.BUCKET.put(key, await sample.arrayBuffer(), {
    httpMetadata: { contentType: sample.type },
    customMetadata: { section, start: String(start), source, createdAt: new Date().toISOString(), engine: "singing-v2" }
  });
  return json({ saved: true, key });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.DB || !env.BUCKET) return json({ error: "Cloud storage is temporarily unavailable." }, 503);
    const hymnId = url.searchParams.get("hymnId") || "";
    try {
      if (url.pathname === "/api/error-reports") return await errorReports(request, env, { isEditor, validId });
      if (url.pathname === "/api/session" && request.method === "GET") return json({ canEdit: isEditor(request) });
      if (url.pathname === "/api/library" && request.method === "GET") return await listLibrary(request, env);
      if (url.pathname === "/api/library/hymn-state" && request.method === "POST") return await updateHymnLibraryState(request, env);
      if (url.pathname === "/api/library/season" && request.method === "POST") return await createLibraryNode(request, env, "season");
      if (url.pathname === "/api/library/category" && request.method === "POST") return await createLibraryNode(request, env, "category");
      if (url.pathname === "/api/library/hymn" && request.method === "POST") return await createLibraryNode(request, env, "hymn");
      if (url.pathname === "/api/completed" && request.method === "GET") {
        const results = await env.DB.prepare("SELECT hymn_id FROM hymn_projects WHERE status = 'complete' LIMIT 2000").all();
        return json({ hymnIds: (results.results || []).map(row => row.hymn_id) });
      }
      if (url.pathname === "/api/projects" && request.method === "GET") {
        if (!isEditor(request)) return json({ error: "Editor access required." }, 403);
        const results = await env.DB.prepare("SELECT hymn_id,title,season,service,status,updated_at,completed_at FROM hymn_projects WHERE owner_email = ? ORDER BY updated_at DESC LIMIT 1000").bind(EDITOR_EMAIL).all();
        return json({ projects: results.results || [] });
      }
      if (url.pathname === "/api/alignment-suggestions" && ["GET", "POST"].includes(request.method)) return await alignmentSuggestions(request, env, hymnId);
      if (url.pathname === "/api/project" && request.method === "GET") {
        if (!validId(hymnId)) return json({ error: "Invalid hymn." }, 400);
        let row = await getRow(env.DB, hymnId);
        if (isEditor(request) && sameOrigin(request) && url.searchParams.has("title")) {
          const initialMedia = row ? {} : {
            recordingUrl: cleanString(url.searchParams.get("recordingUrl"), 1200),
            englishRecordingUrl: cleanString(url.searchParams.get("englishRecordingUrl"), 1200),
            copticRecordingUrl: cleanString(url.searchParams.get("copticRecordingUrl"), 1200)
          };
          for (const value of Object.values(initialMedia)) {
            if (value && !/^https:\/\//u.test(value) && !ownMediaUrl(value)) return json({ error: "Recording URL must be secure." }, 400);
            const key = ownMediaUrl(value);
            if (key && !await env.BUCKET.head(key)) return json({ error: "Uploaded recording is unavailable." }, 400);
          }
          row = await inheritMatchingHymn(env.DB, hymnId, cleanString(url.searchParams.get("title")), cleanString(url.searchParams.get("season"), 100), cleanString(url.searchParams.get("service"), 200), true, initialMedia) || row;
        }
        if (!row || (row.status !== "complete" && !isEditor(request))) return json({ project: null });
        return json({ project: await projectWithMedia(env.DB, row) });
      }
      if (url.pathname === "/api/reference-alignment" && ["GET", "POST"].includes(request.method)) return await referenceAlignment(request, env, hymnId, { isEditor, sameOrigin, validId, getRow, owner: EDITOR_EMAIL, projectWithMedia });
      if (url.pathname === "/api/project" && request.method === "PUT") return await saveProject(request, env, hymnId);
      if (url.pathname === "/api/project/complete" && request.method === "POST") return await completeProject(request, env, hymnId);
      if (url.pathname === "/api/project/publish-alignment" && request.method === "POST") return await publishAlignment(request, env, hymnId);
      if (url.pathname === "/api/recording-clip" && request.method === "POST") return await saveRecordingClip(request, env, hymnId);
      if (url.pathname === "/api/analysis-audio" && request.method === "GET") return await analysisAudio(request);
      if (url.pathname === "/api/listen-audio" && request.method === "GET") return await analysisAudio(request, true);
      if (url.pathname === "/api/voice-examples" && ["GET", "PUT"].includes(request.method)) return await voiceExample(request, env, hymnId);
      if (url.pathname === "/api/upload/audio" && request.method === "PUT") return await uploadFile(request, env, hymnId, "audio", url.searchParams.get("section") || "hazzat");
      if (url.pathname === "/api/upload/hazzat-score" && request.method === "POST") return await uploadHazzatScore(request, env, hymnId);
      if (url.pathname === "/api/upload/hazzat" && request.method === "PUT") return await uploadFile(request, env, hymnId, "hazzat");
      if (url.pathname.startsWith("/api/media/") && ["GET","HEAD"].includes(request.method)) return await serveMedia(request, env, url.pathname.slice(11));
      return json({ error: "Not found." }, 404);
    } catch (error) {
      console.error("Mobile Moallem storage request failed", error);
      return json({ error: "Cloud storage is unavailable. Your unsaved changes are still on this page; try again." }, 503);
    }
  },
};
