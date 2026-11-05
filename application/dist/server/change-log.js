// Update log: editor changes are recorded automatically as pending notes. An editor reviews them
// and approves them as a numbered update (1.0, 1.1, ... or a major bump to 2.0) shown on the site.
// Edits still go live immediately; approving only publishes the notes.

const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const SECTION_NAMES = { hazzat: "Hazzat", english: "English", coptic: "Coptic" };
const MAX_SUMMARY = 300;

const schemaReady = new WeakMap();
export async function ensureUpdateSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS change_log (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    summary_edited INTEGER DEFAULT 0 NOT NULL,
    editor_email TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    update_id TEXT,
    dismissed INTEGER DEFAULT 0 NOT NULL
  )`).run();
  // One pending note per kind of change per item, so repeated saves update a note instead of piling up.
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_change_log_pending ON change_log (kind, target_id) WHERE update_id IS NULL AND dismissed = 0").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS site_updates (
    id TEXT PRIMARY KEY NOT NULL,
    major INTEGER NOT NULL,
    minor INTEGER NOT NULL,
    notes_json TEXT NOT NULL,
    approved_by TEXT,
    approved_at INTEGER NOT NULL,
    UNIQUE (major, minor)
  )`).run();
}
async function ready(db) {
  // Cache per database binding, but retry if a previous attempt failed.
  if (!schemaReady.has(db)) schemaReady.set(db, ensureUpdateSchema(db).catch(error => { schemaReady.delete(db); throw error; }));
  return schemaReady.get(db);
}

const clean = (value, max = MAX_SUMMARY) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
const editorEmail = request => (request.headers.get("oai-authenticated-user-email") || "").toLowerCase() || null;
const prettify = id => clean(String(id || "").split("/").pop().replace(/[-_]+/gu, " ")).replace(/\b\p{Ll}/gu, c => c.toUpperCase());
const version = row => row.major + "." + row.minor;

async function hymnTitle(db, hymnId, row) {
  const presentation = await db.prepare("SELECT title FROM hymn_library_presentation WHERE hymn_id = ?").bind(hymnId).first().catch(() => null);
  return clean(presentation?.title) || clean(row?.title) || prettify(hymnId);
}

export async function recordChange(db, { kind, target, summary, email, detail = null }) {
  summary = clean(summary);
  if (!summary || !kind || !target) return;
  await ready(db);
  const now = Date.now();
  await db.prepare(`INSERT INTO change_log (id,kind,target_id,summary,editor_email,detail,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(kind,target_id) WHERE update_id IS NULL AND dismissed = 0 DO UPDATE SET
      summary = CASE WHEN change_log.summary_edited = 1 THEN change_log.summary ELSE excluded.summary END,
      editor_email = excluded.editor_email, updated_at = excluded.updated_at`)
    .bind(crypto.randomUUID(), kind, target, summary, email, detail, now, now).run();
}

// Routes whose successful editor writes are logged.
const LOGGED = new Set([
  "POST /api/library/season", "POST /api/library/category", "POST /api/library/hymn", "POST /api/library/hymn-state",
  "PUT /api/project", "POST /api/project/complete", "POST /api/project/publish-alignment", "POST /api/recording-clip",
  "PUT /api/upload/audio", "PUT /api/upload/hazzat", "POST /api/upload/hazzat-score", "POST /api/reference-alignment"
]);
const JSON_BODY = new Set(["POST /api/library/hymn-state", "POST /api/project/publish-alignment", "POST /api/recording-clip", "POST /api/reference-alignment"]);

// Called before the edit runs: captures what the change needs to be described afterwards.
export async function beforeChange(request, env, { isEditor, getRow, validId }) {
  const url = new URL(request.url);
  const route = request.method + " " + url.pathname;
  if (!LOGGED.has(route) || !isEditor(request)) return null;
  const hymnId = url.searchParams.get("hymnId") || "";
  const context = { route, hymnId, section: url.searchParams.get("section") || "hazzat", email: editorEmail(request), body: null, before: null, hadScore: false };
  if (JSON_BODY.has(route)) { try { context.body = await request.clone().json(); } catch {} }
  if (route === "POST /api/library/hymn-state" && context.body?.action === "rename" && validId(context.body.hymnId)) {
    await ready(env.DB);
    // Keep the name from before the first pending rename, so "A to B" then "B to C" reads "A to C".
    const earlier = await env.DB.prepare("SELECT detail FROM change_log WHERE kind = 'hymn-renamed' AND target_id = ? AND update_id IS NULL AND dismissed = 0").bind(context.body.hymnId).first();
    context.renamedFrom = earlier?.detail || await hymnTitle(env.DB, context.body.hymnId, await getRow(env.DB, context.body.hymnId));
  }
  if (validId(hymnId)) {
    context.before = await getRow(env.DB, hymnId);
    if (route === "POST /api/upload/hazzat-score" || route === "PUT /api/upload/hazzat") {
      const score = await env.DB.prepare("SELECT 1 AS present FROM hazzat_score_active WHERE hymn_id = ?").bind(hymnId).first().catch(() => null);
      context.hadScore = Boolean(score) || Boolean(context.before?.notation_html || context.before?.notation_key);
    }
  }
  return context;
}

// Called after a successful edit: turns it into one or more pending notes.
export async function afterChange(context, response, env, { getRow }) {
  const { route, hymnId, email, body, before } = context;
  const db = env.DB;
  const log = (kind, target, summary) => recordChange(db, { kind, target, summary, email });
  let data = null;
  try { data = await response.json(); } catch {}
  if (route === "POST /api/library/season" && data?.node) return log("season-added", data.node.id, "Added the season: " + data.node.name);
  if (route === "POST /api/library/category" && data?.node) return log("category-added", data.node.id, "Added the section: " + data.node.name);
  if (route === "POST /api/library/hymn" && data?.node) return log("hymn-added", data.node.id, "Added hymn " + data.node.name);
  if (route === "POST /api/library/hymn-state" && body) {
    if (body.action === "rename") {
      const from = context.renamedFrom || prettify(body.hymnId), to = clean(body.title);
      return recordChange(db, { kind: "hymn-renamed", target: body.hymnId, summary: "Renamed " + from + " to " + to, email, detail: from });
    }
    if (body.action === "remove") return log("hymn-removed", body.hymnId, "Removed hymn " + await hymnTitle(db, body.hymnId));
    if (body.action === "restore") return log("hymn-restored", body.hymnId, "Restored hymn " + await hymnTitle(db, body.hymnId));
    if (body.action === "reorder") {
      const folder = body.folderId || body.categoryId;
      return log("hymns-reordered", (body.seasonId || "") + "/" + folder, "Reordered the hymns in " + prettify(folder));
    }
    return;
  }
  const title = await hymnTitle(db, hymnId, before || await getRow(db, hymnId));
  if (route === "PUT /api/project") {
    const after = await getRow(db, hymnId);
    if (!after) return;
    const changed = column => (before?.[column] || "") !== (after[column] || "");
    const timingColumns = ["timings_json", "coptic_timings_json", "hazzat_timings_json", "hazzat_line_timings_json"];
    const timing = column => before ? changed(column) : JSON.parse(after[column] || "[]").some(Number.isFinite);
    if (!before) return log("hymn-added", hymnId, "Added hymn " + title);
    if (changed("text_content") || changed("coptic_text")) await log("words", hymnId, "Edited the words of " + title);
    if (changed("notation_html")) await log("hazzat", hymnId, "Edited the Hazzat of " + title);
    for (const [column, section] of [["recording_url", "hazzat"], ["english_recording_url", "english"], ["coptic_recording_url", "coptic"]]) {
      if (changed(column)) await log("recording:" + section, hymnId, (before[column] ? "Changed the " : "Added the ") + SECTION_NAMES[section] + " recording of " + title);
    }
    if (timingColumns.some(timing)) await log("timings", hymnId, "Updated the syncing of " + title);
    return;
  }
  if (route === "POST /api/project/complete") return log("published", hymnId, "Published " + title);
  if (route === "POST /api/project/publish-alignment") {
    const section = body?.section;
    const summary = section === "hazzat" ? "Synced recording with Hazzat for " + title
      : section in SECTION_NAMES ? "Synced the " + SECTION_NAMES[section] + " recording with the words of " + title
      : "Synced the recording of " + title;
    return log("synced:" + (section || "all"), hymnId, summary);
  }
  if (route === "POST /api/recording-clip") {
    const section = SECTION_NAMES[body?.section] || "";
    return log("clip:" + (body?.section || ""), hymnId, (body?.action === "clear" ? "Reset the trim of the " : "Trimmed the ") + section + " recording of " + title);
  }
  if (route === "PUT /api/upload/audio") {
    const column = { hazzat: "recording_url", english: "english_recording_url", coptic: "coptic_recording_url" }[context.section];
    if (!column) return;
    return log("recording:" + context.section, hymnId, (before?.[column] ? "Changed the " : "Added the ") + SECTION_NAMES[context.section] + " recording of " + title);
  }
  if (route === "PUT /api/upload/hazzat" || route === "POST /api/upload/hazzat-score") {
    return log("hazzat", hymnId, (context.hadScore ? "Replaced the Hazzat of the hymn " : "Added the Hazzat of the hymn ") + title);
  }
  if (route === "POST /api/reference-alignment" && body?.action === "save") return log("timings", hymnId, "Updated the syncing of " + title);
}

async function latest(db) {
  return db.prepare("SELECT major,minor FROM site_updates ORDER BY major DESC, minor DESC LIMIT 1").first();
}
function nextVersions(row) {
  if (!row) return { minor: { major: 1, minor: 0 }, major: { major: 1, minor: 0 } };
  return { minor: { major: row.major, minor: row.minor + 1 }, major: { major: row.major + 1, minor: 0 } };
}
async function pendingEntries(db) {
  return (await db.prepare("SELECT id,kind,target_id,summary,editor_email,created_at,updated_at FROM change_log WHERE update_id IS NULL AND dismissed = 0 ORDER BY created_at, id").all()).results || [];
}

export async function updatesApi(request, env, { isEditor, sameOrigin }) {
  const url = new URL(request.url);
  const db = env.DB;
  await ready(db);
  if (url.pathname === "/api/updates" && request.method === "GET") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const rows = (await db.prepare("SELECT major,minor,notes_json,approved_at FROM site_updates ORDER BY major DESC, minor DESC LIMIT ?").bind(limit).all()).results || [];
    return json({ updates: rows.map(row => ({ version: version(row), approvedAt: row.approved_at, notes: JSON.parse(row.notes_json || "[]") })) });
  }
  if (!isEditor(request)) return json({ error: "Editor access required." }, 403);
  if (url.pathname === "/api/updates/pending" && request.method === "GET") {
    const next = nextVersions(await latest(db));
    const entries = await pendingEntries(db);
    return json({
      entries: entries.map(row => ({ id: row.id, kind: row.kind, summary: row.summary, editor: row.editor_email, updatedAt: row.updated_at })),
      nextVersion: { minor: version(next.minor), major: version(next.major) }
    });
  }
  if (!sameOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid update data." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid update data." }, 400);
  const now = Date.now();
  if (url.pathname === "/api/updates/pending" && request.method === "POST") {
    if (body.action === "add") {
      const summary = clean(body.summary);
      if (!summary) return json({ error: "Write the note first." }, 400);
      await recordChange(db, { kind: "note", target: crypto.randomUUID(), summary, email: editorEmail(request) });
      return json({ saved: true });
    }
    if (typeof body.id !== "string" || body.id.length > 64) return json({ error: "Choose a pending note." }, 400);
    if (body.action === "edit") {
      const summary = clean(body.summary);
      if (!summary) return json({ error: "A note can't be empty. Remove it instead." }, 400);
      const result = await db.prepare("UPDATE change_log SET summary = ?, summary_edited = 1, updated_at = ? WHERE id = ? AND update_id IS NULL AND dismissed = 0").bind(summary, now, body.id).run();
      if (result?.meta?.changes === 0) return json({ error: "That note is no longer pending. Reload the list." }, 409);
      return json({ saved: true });
    }
    if (body.action === "dismiss") {
      await db.prepare("UPDATE change_log SET dismissed = 1, updated_at = ? WHERE id = ? AND update_id IS NULL").bind(now, body.id).run();
      return json({ saved: true });
    }
    return json({ error: "Unknown change." }, 400);
  }
  if (url.pathname === "/api/updates/approve" && request.method === "POST") {
    const ids = body.entryIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 300 || !ids.every(id => typeof id === "string" && id.length <= 64) || new Set(ids).size !== ids.length) return json({ error: "Choose the notes to include." }, 400);
    if (!["minor", "major"].includes(body.bump)) return json({ error: "Choose how to number this update." }, 400);
    const entries = await pendingEntries(db);
    const pendingIds = new Set(entries.map(entry => entry.id));
    // Everyone approves exactly what they reviewed: if notes were added, edited away, or approved by someone else meanwhile, reload first.
    if (ids.length !== pendingIds.size || !ids.every(id => pendingIds.has(id))) return json({ error: "The pending changes were updated by someone else. Reload and review them again." }, 409);
    const target = nextVersions(await latest(db))[body.bump];
    if (typeof body.expectedVersion === "string" && body.expectedVersion !== version(target)) return json({ error: "Another update was approved meanwhile. Reload to see the new number." }, 409);
    const updateId = crypto.randomUUID();
    const notes = entries.map(entry => entry.summary);
    try {
      await db.batch([
        db.prepare("INSERT INTO site_updates (id,major,minor,notes_json,approved_by,approved_at) VALUES (?,?,?,?,?,?)").bind(updateId, target.major, target.minor, JSON.stringify(notes), editorEmail(request), now),
        ...ids.map(id => db.prepare("UPDATE change_log SET update_id = ? WHERE id = ? AND update_id IS NULL AND dismissed = 0").bind(updateId, id))
      ]);
    } catch (error) {
      if (/unique|constraint/iu.test(String(error?.message))) return json({ error: "Another update was approved meanwhile. Reload to see the new number." }, 409);
      throw error;
    }
    return json({ update: { version: version(target), approvedAt: now, notes } });
  }
  return json({ error: "Not found." }, 404);
}
