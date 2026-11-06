// Home search: one box finds seasons (cards below filter as before), categories and hymns.
// Hymn names come from catalog/search-index.json plus the live library (editor-added hymns,
// renames and removals), so results always match what the library shows.
(() => {
  const input = document.getElementById("seasonSearch");
  const panel = document.getElementById("globalSearchResults");
  if (!input || !panel) return;
  const PUBLIC_SEASONS = new Set(["annual", "kiahk"]);
  const MAX_HYMNS = 30, MAX_CATEGORIES = 6, MIN_CHARS = 2;
  let indexPromise = null;

  const norm = value => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const loadIndex = () => indexPromise ||= fetch("./catalog/search-index.json?v=1").then(r => r.ok ? r.json() : { hymns: [] }).catch(() => { indexPromise = null; return { hymns: [] }; });
  // site.js keeps these as shared top-level bindings; read them at search time.
  const editor = () => typeof canEdit !== "undefined" && canEdit;
  const seasonsList = () => (typeof allSeasons === "function" ? allSeasons() : []);
  const libraryState = () => (typeof hymnLibraryState !== "undefined" ? hymnLibraryState : {});
  const library = () => (typeof customLibrary !== "undefined" ? customLibrary : { seasons: [], categories: [], hymns: [] });

  function collectEntries(index) {
    const seasonName = new Map(seasonsList().map(s => [s.id, s.name]));
    const state = libraryState(), lib = library(), canSeeAll = editor();
    const visible = id => canSeeAll || PUBLIC_SEASONS.has(id.split("/")[0]);
    const categoryName = new Map();
    for (const [id, , category] of index.hymns) categoryName.set(id.split("/").slice(0, 2).join("/"), category);
    for (const c of lib.categories || []) categoryName.set(c.season + "/" + c.id, c.name);
    const hymns = new Map();
    for (const [id, name, category] of index.hymns) hymns.set(id, { id, name, category, season: id.split("/")[0] });
    for (const h of lib.hymns || []) hymns.set(h.id, { id: h.id, name: h.name, season: h.season, category: categoryName.get(h.season + "/" + h.category) || h.category });
    const out = [];
    for (const h of hymns.values()) {
      if (!visible(h.id) || state[h.id]?.removed) continue;
      out.push({ ...h, name: state[h.id]?.title || h.name, seasonName: seasonName.get(h.season) || h.season });
    }
    return { hymns: out, categoryName, seasonName, visible };
  }

  function score(name, q) {
    const n = norm(name);
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(" ").some(word => word.startsWith(q))) return 2;
    if (n.includes(q)) return 3;
    return 4; // matched through season or category only
  }

  function highlighted(text, terms) {
    const span = document.createElement("span");
    span.className = "gs-name";
    const lower = text.toLocaleLowerCase();
    const term = terms.find(t => lower.includes(t));
    if (!term) { span.textContent = text; return span; }
    const at = lower.indexOf(term);
    const mark = document.createElement("mark");
    mark.textContent = text.slice(at, at + term.length);
    span.append(text.slice(0, at), mark, text.slice(at + term.length));
    return span;
  }

  function row(href, name, terms, metaParts, kind) {
    const a = document.createElement("a");
    a.className = "gs-item";
    a.href = href;
    a.append(highlighted(name, terms));
    const meta = document.createElement("span");
    meta.className = "gs-meta";
    if (kind) { const k = document.createElement("span"); k.className = "gs-kind"; k.textContent = kind; meta.append(k); }
    metaParts.filter(Boolean).forEach((part, i) => {
      if (i || kind) meta.append(Object.assign(document.createElement("span"), { className: "gs-sep", textContent: "·", ariaHidden: "true" }));
      meta.append(Object.assign(document.createElement("span"), { textContent: part }));
    });
    a.append(meta);
    return a;
  }

  function group(title) {
    const h = document.createElement("p");
    h.className = "gs-group";
    h.textContent = title;
    return h;
  }

  let sequence = 0;
  async function render() {
    const raw = input.value.trim();
    const q = norm(raw);
    const mine = ++sequence;
    if (q.length < MIN_CHARS) { panel.hidden = true; panel.replaceChildren(); return; }
    const index = await loadIndex();
    if (mine !== sequence) return;
    const { hymns, categoryName, seasonName, visible } = collectEntries(index);
    const terms = q.split(" ").filter(Boolean);
    const rawTerms = raw.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = hymns.filter(h => { const hay = norm(h.name + " " + h.category + " " + h.seasonName); return terms.every(t => hay.includes(t)); })
      .map(h => ({ ...h, rank: score(h.name, q) }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    const categories = [...categoryName.entries()]
      .filter(([key, name]) => visible(key) && terms.every(t => norm(name + " " + (seasonName.get(key.split("/")[0]) || "")).includes(t)) && terms.some(t => norm(name).includes(t)))
      .slice(0, MAX_CATEGORIES);

    panel.replaceChildren();
    if (categories.length) {
      panel.append(group("Categories"));
      for (const [key, name] of categories) panel.append(row("#/season/" + key.split("/")[0], name, rawTerms, [seasonName.get(key.split("/")[0])], "Category"));
    }
    if (matches.length) {
      panel.append(group("Hymns"));
      for (const h of matches.slice(0, MAX_HYMNS)) panel.append(row("#/hymn/" + h.id, h.name, rawTerms, [h.seasonName, h.category]));
      if (matches.length > MAX_HYMNS) panel.append(Object.assign(document.createElement("p"), { className: "gs-more", textContent: "Showing " + MAX_HYMNS + " of " + matches.length + " hymns. Keep typing to narrow it down." }));
    }
    const seasonCards = document.querySelectorAll("#seasonNav .season-card").length;
    if (!panel.childElementCount && !seasonCards) panel.append(Object.assign(document.createElement("p"), { className: "gs-empty", textContent: "Nothing matches “" + raw + "”." }));
    panel.hidden = !panel.childElementCount;
    // The season grid below says "No seasons match" on its own; drop that when hymns or categories matched.
    const nav = document.getElementById("seasonNav");
    if (nav && !seasonCards && panel.querySelector(".gs-item")) nav.textContent = "";
  }
  function focusables() { return [...panel.querySelectorAll(".gs-item")]; }
  input.addEventListener("focus", () => void loadIndex(), { once: true });
  input.addEventListener("input", () => void render());
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { input.value = ""; input.dispatchEvent(new Event("input")); }
    if (event.key === "ArrowDown") { const first = focusables()[0]; if (first) { event.preventDefault(); first.focus(); } }
    if (event.key === "Enter") { const first = focusables()[0]; if (first) { event.preventDefault(); first.click(); } }
  });
  panel.addEventListener("keydown", event => {
    const items = focusables(), at = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" && at < items.length - 1) { event.preventDefault(); items[at + 1].focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); (at > 0 ? items[at - 1] : input).focus(); }
    if (event.key === "Escape") { input.focus(); }
  });
  // Going to a result leaves the home page; clear the box so coming back shows all seasons.
  panel.addEventListener("click", event => {
    if (!event.target.closest(".gs-item")) return;
    input.value = "";
    panel.hidden = true;
    queueMicrotask(() => input.dispatchEvent(new Event("input")));
  });
})();
