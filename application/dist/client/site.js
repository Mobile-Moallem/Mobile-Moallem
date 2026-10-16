const $ = id => document.getElementById(id);
const audio = $("audio");
const players = { hazzat: audio, english: $("englishAudio"), coptic: $("copticAudio") };
const playerPrefix = { hazzat: "", english: "english", coptic: "coptic" };
const playerElement = (kind, suffix) => $(kind === "hazzat" ? suffix[0].toLowerCase() + suffix.slice(1) : playerPrefix[kind] + suffix);
function syncSeekProgress(slider) {
  const fraction = Math.max(0, Math.min(1, Number(slider.value) / Number(slider.max)));
  slider.style.setProperty("--seek-fraction", String(fraction));
}
const pausePlayers = () => Object.values(players).forEach(player => player.pause());
function hidePlayer() {
  $("recordingGrid").hidden = true;
  $("readerView").classList.remove("recording-open");
  for (const card of $("recordingGrid").querySelectorAll("[data-recording-section]")) card.hidden = true;
  activePlaybackKind = null;
  pausePlayers();
}
function showPlayer(kind) {
  if (!current()) return;
  $("recordingGrid").hidden = false;
  $("readerView").classList.add("recording-open");
  for (const card of $("recordingGrid").querySelectorAll("[data-recording-section]")) card.hidden = card.dataset.recordingSection !== kind;
  for (const [name, player] of Object.entries(players)) if (name !== kind) player.pause();
}
const workspace = document.querySelector(".workspace");
let seasonIndex = [];
let customLibrary = { seasons: [], categories: [], hymns: [] };
let audioMatches = {};
let recordingsBySeason = {};
let selectedSeason = "annual";
let seasonServices = [];
let selectedFolder = null;
let hymnLibraryState = {};
let showRemovedHymns = false;
let hazzatImportPages = [];
let selectedId = null;
let view = "words";
let textLanguage = "coptic";
let activePlaybackKind = null;
let aligning = false;
let alignmentScope = null;
let alignmentKey = null;
let alignmentCursor = 0;
let lastAlignmentTarget = "";
let clipEnd = null;
let repeatSelection = null;
let repeatLoop = null;
let repeatHymnId = null;
let repeatAlignment = null;
let repeatAlignmentLoop = null;
let alignmentBounds = null;
let sectionSelection = null;
let repeatPass = null;
let readerScale = 1;
let routeSequence = 0;
let canEdit = false;
let editingLibrary = false;
let librarySaving = false;
let allProjects = [];
let completedProjects = new Set();
let autosaveTimer = null;
let savePromise = null;
const seasonCache = new Map();
const seasonAssetCache = new Map();
const chosenAudio = new Map();
function loadSeasonAsset(id) {
  if (!seasonAssetCache.has(id)) {
    seasonAssetCache.set(id, fetch("./catalog/" + id + ".json").then(response => {
      if (!response.ok) throw new Error("Catalog unavailable");
      return response.json();
    }).catch(error => { seasonAssetCache.delete(id); throw error; }));
  }
  return seasonAssetCache.get(id);
}
function allSeasons() {
  const seen = new Set();
  return [...seasonIndex, ...(customLibrary.seasons || [])].filter(season => {
    if (seen.has(season.id)) return false;
    seen.add(season.id);
    return true;
  });
}
function customCategoriesForSeason(seasonId) { return (customLibrary.categories || []).filter(category => category.season === seasonId); }
function customHymnsForSeason(seasonId) { return (customLibrary.hymns || []).filter(hymn => hymn.season === seasonId); }
function applyCustomProject(hymn) {
  const project = hymn.project;
  if (!project) return hymn;
  return { ...hymn, textOverride: project.textContent || "", copticTextOverride: project.copticText || "", notationHtml: project.notationHtml || "", recordingUrl: project.recordingUrl || "", englishRecordingUrl: project.englishRecordingUrl || "", copticRecordingUrl: project.copticRecordingUrl || "", timings: project.timings || [], copticTimings: project.copticTimings || [], hazzatTimings: project.hazzatTimings || [], hazzatLineTimings: project.hazzatLineTimings || [], repeatSections: project.repeatSections || [], recordingClips: project.recordingClips || {}, hazzatPages: project.hazzatPages || [], projectStatus: project.status };
}
function shortSlug(value) {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 70) || "recording";
}
function shortHash(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
function extraRecordings(seasonId) {
  const linked = new Set(Object.entries(audioMatches).filter(([id]) => id.startsWith(seasonId + "/")).map(([, track]) => track.url));
  const seen = new Set();
  return (recordingsBySeason[seasonId] || []).filter(track => {
    if (!track.url || linked.has(track.url) || seen.has(track.url)) return false;
    seen.add(track.url);
    return true;
  });
}

function stamp(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
}
function words(text) { return (text || "").trim().split(/\s+/u).filter(Boolean); }
function decodeCatalogText(value) {
  const field = document.createElement("textarea");
  field.innerHTML = String(value || "").replace(/<br\s*\/?\s*>/giu, " ").replaceAll("<", "&lt;");
  return field.value.trim();
}
function catalogText(h, language) {
  const variation = h.formats?.["1"]?.[0];
  return (variation?.content?.paragraphs || [])
    .map(paragraph => decodeCatalogText((paragraph.columns || []).find(column => column.language?.toLowerCase() === language)?.content || ""))
    .join("\n");
}
function allHymns() {
  return seasonServices.flatMap(service => service.hymns);
}
function current() { return allHymns().find(h => h.id === selectedId) || null; }
function hymnText(h) {
  if (h.textOverride) return h.textOverride;
  if (h.text) return h.text;
  return catalogText(h, "english");
}
function hymnCopticText(h) {
  return h.copticTextOverride || catalogText(h, "coptic");
}
function hazzatHtml(h) {
  if (h.notationHtml) return h.notationHtml;
  if (h.hazzat) return null;
  const variation = h.formats?.["2"]?.[0] || h.formats?.["3"]?.[0];
  return variation?.content?.copticHazzat || variation?.content?.englishHazzat || "";
}
function notationForEditor(html) {
  if (!html) return "";
  if (/<(?!br\s*\/?\s*>)[a-z][^>]*>/iu.test(html)) return html;
  const source = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html").body.firstElementChild;
  return source.innerHTML.replace(/<br\s*\/?\s*>/giu, "\n").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
}
function notationFromEditor(value) {
  if (/<\/?(?:span|div|b|i|br)\b/iu.test(value)) return value;
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r?\n/gu, "<br>");
}
function audioFor(h, kind = "hazzat") {
  if (kind === "english") return h.englishRecordingUrl || "";
  if (kind === "coptic") return h.copticRecordingUrl || "";
  return h.recordingUrl || chosenAudio.get(h.id)?.url || audioMatches[h.id]?.url || "";
}
function visiblePlayerKind(h) {
  const preferred = view === "words" ? textLanguage : "hazzat";
  return audioFor(h, preferred) ? preferred : Object.keys(players).find(kind => audioFor(h, kind)) || preferred;
}
function recordingRange(h, kind, duration = players[kind]?.duration) {
  const clip = h?.recordingClips?.[kind];
  const total = Number.isFinite(duration) ? duration : Number.isFinite(clip?.end) ? clip.end : 0;
  const start = clip ? Math.max(0, Math.min(clip.start, total)) : 0;
  const end = clip ? Math.max(start, Math.min(clip.end, total)) : total;
  return { start, end };
}
function parseClipTime(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  const parts = text.split(":");
  if (parts.length !== 2 || !/^\d+$/u.test(parts[0]) || !/^\d{1,2}(?:\.\d+)?$/u.test(parts[1]) || Number(parts[1]) >= 60) return NaN;
  return Number(parts[0]) * 60 + Number(parts[1]);
}
function clipTimeText(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const remainder = Number((seconds % 60).toFixed(2));
  const tail = Number.isInteger(remainder) ? String(remainder).padStart(2, "0") : remainder.toFixed(2).replace(/0$/u, "").padStart(4, "0");
  return Math.floor(seconds / 60) + ":" + tail;
}
function renderClipControls(h) {
  for (const kind of Object.keys(players)) {
    const range = h?.recordingClips?.[kind];
    const start = $("clipStart" + kind[0].toUpperCase() + kind.slice(1));
    const end = $("clipEnd" + kind[0].toUpperCase() + kind.slice(1));
    if (!start || !end) continue;
    start.value = range ? clipTimeText(range.start) : "0:00";
    end.value = range ? clipTimeText(range.end) : "";
    end.placeholder = Number.isFinite(players[kind].duration) ? stamp(players[kind].duration) : "full length";
    const active = Boolean(range);
    $("clearClip" + kind[0].toUpperCase() + kind.slice(1)).hidden = !active;
  }
}
function setHelp(message, kind = "hazzat") { playerElement(kind, "AudioHelp").textContent = message; }
function updateRepeatControl(kind) {
  const button = playerElement(kind, "RepeatBtn");
  if (!button) return;
  const state = repeatHymnId === current()?.id ? repeatSelection : null;
  const loop = repeatHymnId === current()?.id ? repeatLoop : null;
  button.textContent = loop ? "Clear repeat" : state?.stage === "end" ? "Choose end" : state?.stage === "start" ? "Choose start" : "↻ Repeat part";
  button.setAttribute("aria-pressed", String(Boolean(loop)));
  button.setAttribute("aria-label", loop ? "Clear repeated section" : "Repeat a selected section");
  button.classList.toggle("is-active", Boolean(loop || state));
  button.disabled = repeatAlignmentLoop?.hymnId === current()?.id;
}
function resetRepeat() {
  sectionSelection = null;
  repeatPass = null;
  repeatSelection = null;
  repeatLoop = null;
  repeatHymnId = null;
  repeatAlignment = null;
  repeatAlignmentLoop = null;
  alignmentBounds = null;
  for (const kind of Object.keys(players)) updateRepeatControl(kind);
  updateRepeatAlignmentControl();
  highlightRepeatRange();
}
function updateRepeatAlignmentControl() {
  const button = $("repeatAlignmentBtn");
  if (!button) return;
  const isLooping = repeatAlignmentLoop?.hymnId === current()?.id;
  const isSelecting = repeatAlignment?.hymnId === current()?.id;
  button.textContent = isLooping ? "Stop repeat alignment" : isSelecting ? repeatAlignment.stage === "end" ? "Choose end part" : "Choose start part" : "↻ Repeat alignment";
  button.setAttribute("aria-pressed", String(Boolean(isLooping || isSelecting)));
  button.classList.toggle("is-active", Boolean(isLooping || isSelecting));
  button.disabled = view === "recording" || !current();
  for (const kind of Object.keys(players)) updateRepeatControl(kind);
}
function setRepeatAlignmentPoint(element, event) {
  const state = repeatAlignment;
  const h = current();
  if (!state || !h || state.hymnId !== h.id || !workspace.classList.contains("editing")) return false;
  if (state.kind === "hazzat" && state.stage === "start") state.key = element.closest(".hazza-mark") ? "hazzatTimings" : "hazzatLineTimings";
  const targetClass = state.key === "hazzatLineTimings" ? ".hazzat-stack" : state.key === "hazzatTimings" ? ".hazza-mark" : ".word";
  const target = element.closest(targetClass);
  if (!target) return false;
  const index = Number(target.dataset.position);
  const time = h[state.key]?.[index];
  if (!Number.isInteger(index)) {
    $("repeatAlignmentHelp").textContent = "Choose a word, Hazzat passage, or stack.";
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  if (state.stage === "start") {
    const precedingTime = (h[state.key] || []).slice(0, index).reverse().find(Number.isFinite);
    const startTime = Number.isFinite(time) ? time : Number.isFinite(precedingTime) ? precedingTime : recordingRange(h, state.kind).start;
    repeatAlignment = { ...state, startIndex: index, startTime, stage: "end" };
    highlightRepeatRange();
    $("repeatAlignmentHelp").textContent = "Start selected. Tap the last part to include. An untimed start plays from the previous timed part, or the recording start.";
    updateRepeatAlignmentControl();
    return true;
  }
  if (index < state.startIndex) {
    $("repeatAlignmentHelp").textContent = "Choose an end part at or after the start.";
    return true;
  }
  const range = recordingRange(h, state.kind);
  if (!Number.isFinite(players[state.kind].duration) && !h.recordingClips?.[state.kind]) range.end = Infinity;
  let endTime = (h[state.key] || []).slice(index + 1).find(value => Number.isFinite(value) && value > state.startTime + 0.02);
  if (!Number.isFinite(endTime)) endTime = range.end;
  const loopStart = Math.max(range.start, state.startTime);
  endTime = Math.min(range.end, endTime);
  if (!Number.isFinite(endTime) || endTime <= loopStart + 0.2) {
    $("repeatAlignmentHelp").textContent = "Wait for the recording to finish loading, then choose the end part again.";
    return true;
  }
  h[state.key] ||= [];
  for (let position = state.startIndex; position <= index; position++) h[state.key][position] = null;
  alignmentBounds = { key: state.key, start: state.startIndex, end: index };
  repeatAlignmentLoop = { hymnId: h.id, kind: state.kind, key: state.key, startIndex: state.startIndex, endIndex: index, start: loopStart, end: endTime };
  repeatAlignment = null;
  repeatLoop = null;
  repeatSelection = null;
  repeatHymnId = null;
  aligning = true;
  alignmentScope = state.kind === "hazzat" ? "hazzat" : state.kind;
  alignmentKey = state.key;
  alignmentCursor = state.startIndex;
  lastAlignmentTarget = "";
  showPlayer(state.kind);
  markUnsaved();
  renderReader();
  focusAlignmentTarget();
  playAtTime(state.kind, repeatAlignmentLoop.start, "Playback could not start. Press Play to begin the repeat.");
  $("repeatAlignmentHelp").textContent = "Looping this part. Its existing timings were cleared; tap the selected parts as they sing to mark new times. The rest of the hymn stays untouched.";
  updateRepeatAlignmentControl();
  setHelp("This recording part repeats while you redo its selected timings.", state.kind);
  return true;
}
function playbackLoop(kind) {
  if (repeatAlignmentLoop?.kind === kind && repeatAlignmentLoop.hymnId === current()?.id) return repeatAlignmentLoop;
  if (repeatLoop?.kind === kind && repeatHymnId === current()?.id) return repeatLoop;
  return null;
}
function stopRepeatAlignment() {
  repeatPass = null;
  if (repeatAlignmentLoop) players[repeatAlignmentLoop.kind]?.pause();
  repeatAlignment = null;
  repeatAlignmentLoop = null;
  alignmentBounds = null;
  aligning = false;
  updateRepeatAlignmentControl();
}
function playAtTime(kind, target, failureMessage = "Playback could not start.") {
  const player = players[kind];
  const seekAndPlay = () => {
    const range = recordingRange(current(), kind);
    player.currentTime = Math.max(range.start, Math.min(target, range.end || target));
    player.play().catch(() => setHelp(failureMessage, kind));
  };
  if (player.readyState === 0) {
    player.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    player.load();
    return;
  }
  seekAndPlay();
}
$("readerContent").addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  if (selectSectionPoint(event.target, event)) return;
  if (setRepeatAlignmentPoint(event.target, event)) return;
  selectListenPoint(event.target, event);
}, true);
function chooseRepeatPoint(start, kind) {
  if (!repeatSelection || repeatSelection.kind !== kind || repeatHymnId !== current()?.id || !Number.isFinite(start)) return false;
  const range = recordingRange(current(), kind);
  const point = Math.max(range.start, Math.min(start, range.end));
  if (repeatSelection.stage === "start") {
    repeatSelection = { kind, start: point, stage: "end" };
    updateRepeatControl(kind);
    setHelp("Repeat starts at " + stamp(point) + ". Tap a later timed word or Hazzat part to set the end.", kind);
    return true;
  }
  if (point <= repeatSelection.start + 0.2) {
    setHelp("Choose a later timed part to finish the repeat.", kind);
    return true;
  }
  repeatLoop = { kind, start: repeatSelection.start, end: point };
  repeatSelection = null;
  updateRepeatControl(kind);
  setHelp("Repeating " + stamp(repeatLoop.start) + " to " + stamp(repeatLoop.end) + ". Press Play to listen.", kind);
  return true;
}
function setPlayerSource(h, kind) {
  const player = players[kind];
  if (activePlaybackKind === kind) activePlaybackKind = null;
  const url = h ? audioFor(h, kind) : "";
  player.pause();
  if (url) player.src = url;
  else player.removeAttribute("src");
  playerElement(kind, "CurrentTime").textContent = "0:00";
  playerElement(kind, "Duration").textContent = "0:00";
  playerElement(kind, "Seek").value = "0";
  syncSeekProgress(playerElement(kind, "Seek"));
  playerElement(kind, "PlayBtn").textContent = "▶";
  const track = kind === "hazzat" && h && (h.trackMeta || chosenAudio.get(h.id) || audioMatches[h.id]);
  playerElement(kind, "AudioName").textContent = !url ? "Recording" : url.startsWith("/api/media/") ? "Uploaded recording" : track?.url === url ? "Ibrahim Ayad · " + track.title : "Saved recording";
  playerElement(kind, "PlayBtn").disabled = !url;
  if (repeatLoop?.kind === kind || repeatSelection?.kind === kind) resetRepeat();
  updateRepeatControl(kind);
  renderClipControls(h);
  setHelp(url ? "Play this section’s recording, then tap a timed part." : "No recording is attached to this hymn section yet.", kind);
}
function lastTimedIndex(values, time) {
  if (!Array.isArray(values) || !Number.isFinite(time)) return -1;
  let index = -1;
  let latest = -Infinity;
  values.forEach((start, position) => {
    if (Number.isFinite(start) && start <= time + 0.03 && start >= latest) {
      latest = start;
      index = position;
    }
  });
  return index;
}
function updateKaraoke() {
  highlightRepeatRange();
  const content = $("readerContent");
  for (const element of content.querySelectorAll(".karaoke-active, .karaoke-line-active")) {
    element.classList.remove("karaoke-active", "karaoke-line-active");
    element.removeAttribute("aria-current");
  }
  const h = current();
  if (view !== "words" && view !== "hazzat") return;
  const kind = view === "hazzat" ? "hazzat" : textLanguage;
  if (!h || activePlaybackKind !== kind) return;
  const time = players[kind].currentTime;
  const badge = $("repeatProgress");
  const sections = (h.repeatSections || []).filter(s => kind === "hazzat" ? s.key.startsWith("hazzat") : s.key === (kind === "coptic" ? "copticTimings" : "timings"));
  badge.hidden = !workspace.classList.contains("editing") || !sections.length;
  if (sections.length) { const section = sections[0]; const start = h[section.key]?.[section.startIndex]; const end = h[section.key]?.[section.endIndex + 1] ?? recordingRange(h, kind).end; badge.textContent = "Sing " + (section.passes.length + 1) + " times" + (Number.isFinite(start) && time >= start && time < end ? " · 1 of " + (section.passes.length + 1) : ""); }
  if (kind === "hazzat") {
    const passage = lastTimedIndex(playbackTimings(h, "hazzatTimings", time), time);
    const stack = lastTimedIndex(playbackTimings(h, "hazzatLineTimings", time), time);
    const mark = passage < 0 ? null : content.querySelector('.hazza-mark[data-position="' + passage + '"]');
    const box = mark?.closest(".hazzat-stack") || (stack < 0 ? null : content.querySelector('.hazzat-stack[data-position="' + stack + '"]'));
    if (box) box.classList.add("karaoke-line-active");
    if (mark) { mark.classList.add("karaoke-active"); mark.setAttribute("aria-current", "true"); }
  } else {
    const key = kind === "coptic" ? "copticTimings" : "timings";
    const index = lastTimedIndex(playbackTimings(h, key, time), time);
    const mark = index < 0 ? null : content.querySelector('.word[data-position="' + index + '"]');
    if (mark) {
      mark.classList.add("karaoke-active");
      mark.setAttribute("aria-current", "true");
      mark.closest(".word-row")?.classList.add("karaoke-line-active");
    }
  }
}
function alignmentCount(h, key) {
  if (key === "timings") return words(hymnText(h)).length;
  if (key === "copticTimings") return words(hymnCopticText(h)).length;
  if (key === "hazzatTimings") return h.hazzatGroupCount || 0;
  return h.hazzatLineCount || 0;
}
function refreshAlignmentTarget() {
  const content = $("readerContent");
  for (const element of content.querySelectorAll(".next-to-mark")) element.classList.remove("next-to-mark");
  const h = current();
  if (!aligning || !h || view === "recording") return;
  const scope = view === "words" ? textLanguage : "hazzat";
  if (alignmentScope !== scope || !alignmentKey) {
    alignmentScope = scope;
    alignmentKey = view === "hazzat" ? "hazzatLineTimings" : textLanguage === "coptic" ? "copticTimings" : "timings";
    const count = alignmentCount(h, alignmentKey);
    const firstMissing = Array.from({ length: count }, (_, i) => i).find(i => !Number.isFinite(h[alignmentKey]?.[i]));
    alignmentCursor = firstMissing ?? 0;
  }
  const count = alignmentCount(h, alignmentKey);
  alignmentCursor = Math.min(alignmentCursor, count);
  if (alignmentBounds?.key === alignmentKey && alignmentCursor > alignmentBounds.end) {
    $("alignStatus").textContent += " · Selected repeat range marked";
    return;
  }
  if (repeatPass && alignmentCursor > alignmentBounds.end) { $("alignStatus").textContent += " · Repeat pass marked — finish aligning"; return; }
  if (alignmentCursor >= count) {
    $("alignStatus").textContent += " · All parts marked";
    return;
  }
  const selector = alignmentKey === "hazzatLineTimings" ? ".hazzat-stack" : alignmentKey === "hazzatTimings" ? ".hazza-mark" : ".word";
  const target = content.querySelector(selector + '[data-position="' + alignmentCursor + '"]');
  target?.classList.add("next-to-mark");
  const targetId = scope + ":" + alignmentKey + ":" + alignmentCursor;
  if (target && targetId !== lastAlignmentTarget) {
    lastAlignmentTarget = targetId;
    target.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const label = alignmentKey === "hazzatLineTimings" ? "stack" : alignmentKey === "hazzatTimings" ? "passage" : "word";
  $("alignStatus").textContent += " · Selected " + label + " " + (alignmentCursor + 1) + " of " + count + " · ←/→ move · Space mark";
}
function focusAlignmentTarget() {
  $("readerContent").querySelector(".next-to-mark")?.focus({ preventScroll: true });
}

function renderSeasons() {
  const nav = $("seasonNav");
  nav.replaceChildren();
  const seasons = allSeasons().slice().sort((a, b) => {
    const rank = id => id === "annual" ? 0 : id === "kiahk" ? 1 : 2;
    return rank(a.id) - rank(b.id);
  });
  $("seasonCount").textContent = seasons.length + " seasons";
  const query = $("seasonSearch").value.trim().toLocaleLowerCase();
  const readyGrid = document.createElement("div");
  readyGrid.className = "season-section season-ready-grid";
  const upcomingGrid = document.createElement("div");
  upcomingGrid.className = "season-section season-upcoming-grid";
  for (const season of seasons.filter(s => s.name.toLocaleLowerCase().includes(query))) {
    const available = ["annual", "kiahk"].includes(season.id);
    const accessible = available || canEdit;
    const card = document.createElement(accessible ? "a" : "div");
    card.className = "season-card" + (accessible ? "" : " season-unavailable");
    if (accessible) card.href = "#/season/" + season.id;
    else card.setAttribute("aria-disabled", "true");
    const name = document.createElement("strong");
    name.textContent = season.name;
    const detail = document.createElement("span");
    const completeCount = [...completedProjects].filter(id => id.startsWith(season.id + "/")).length;
    const customHymns = customHymnsForSeason(season.id);
    const customCategories = customCategoriesForSeason(season.id);
    const removedCount = Object.entries(hymnLibraryState).filter(([hymnId, state]) => state.removed && hymnId.startsWith(season.id + "/")).length;
    const cached = seasonCache.get(season.id);
    const hymnCount = cached ? cached.flatMap(service => service.hymns).filter(h => readerLibraryHymn(h) && !hymnLibraryState[h.id]?.removed).length : Math.max(0, (season.hymnCount || 0) + customHymns.length - removedCount);
    detail.textContent = hymnCount + " hymns · " + ((season.serviceCount || 0) + customCategories.length) + " sections" + (completeCount ? " · " + completeCount + " synced" : "");
    card.append(name, detail);
    if (!available) {
      const notice = document.createElement("span");
      notice.className = "alignment-coming-soon";
      notice.textContent = "Alignment coming soon";
      card.append(notice);
    }
    (available ? readyGrid : upcomingGrid).append(card);
  }
  if (readyGrid.childElementCount) nav.append(readyGrid);
  if (upcomingGrid.childElementCount) nav.append(upcomingGrid);
  if (!nav.childElementCount) nav.textContent = "No seasons match your search.";
}
function isDoxology(hymn, service) {
  if (seasonServices.some(item => item.id === "doxologies" && item.replacesDoxologies)) return service.id === "doxologies";
  return !/^(?:intro(?:duction)?|conclusion)\b.*doxolog/iu.test(hymn.name) && (/\bdoxology\b/iu.test(hymn.name) || /^doxologies$/iu.test(service.name));
}
function doxologyFolderCard(count) {
  const item = document.createElement("article");
  item.className = "hymn-card hymn-folder-card";
  const link = document.createElement("a");
  link.className = "hymn-card-link";
  link.href = "#/folder/annual/doxologies";
  const icon = document.createElement("span");
  icon.className = "folder-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
  const title = document.createElement("strong");title.textContent = "Doxologies";
  const detail = document.createElement("span");detail.textContent = count + " doxologies · Open folder";
  link.append(icon, title, detail);item.append(link);return item;
}
function renderLibrary() {
  const list = $("hymnList");
  list.replaceChildren();
  const query = $("search").value.trim().toLocaleLowerCase();
  let count = 0, folderShown = false, officesGroup = null, officesGrid = null;
  const inFolder = selectedFolder === "doxologies";
  const edit = canEdit && editingLibrary;
  const doxologies = seasonServices.flatMap(service => service.hymns.filter(h => (edit || readerLibraryHymn(h)) && isDoxology(h, service) && !hymnLibraryState[h.id]?.removed));
  $("editLibraryBtn").hidden = !canEdit;
  $("editLibraryBtn").disabled = librarySaving;
  $("editLibraryBtn").setAttribute("aria-pressed", String(edit));
  $("editLibraryBtn").setAttribute("aria-label", edit ? "Done editing hymn boxes" : "Edit hymn boxes");
  $("editLibraryLabel").textContent = edit ? "Done" : "Edit";
  $("libraryEditHelp").hidden = !edit;
  const services = inFolder ? [{ id: "doxologies", name: "Doxologies", hymns: doxologies }] : seasonServices.filter(service => !(service.id === "doxologies" && service.replacesDoxologies));
  for (const service of services) {
    const visible = service.hymns.filter(h => !hymnLibraryState[h.id]?.removed && (edit || readerLibraryHymn(h))).map((h, index) => ({ h, index, order: hymnLibraryState[h.id]?.[inFolder ? "folderOrder" : "order"] }));
    visible.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.index - b.index);
    const matches = visible.map(row => row.h).filter(h => displayHymnName(h).toLocaleLowerCase().includes(query));
    const showFolder = !inFolder && selectedSeason === "annual" && service.id === "matins-11" && (!query || "doxologies".includes(query) || doxologies.some(h => h.name.toLocaleLowerCase().includes(query)));
    if (!matches.length && !showFolder) continue;
    const combinedOffices = !inFolder && selectedSeason === "annual" && /^(Vespers|Matins)$/iu.test(service.name);
    const group = combinedOffices && officesGroup ? officesGroup : document.createElement("section");
    group.className = "service-group";
    const header = document.createElement("h3");
    header.className = "service-name";
    header.textContent = combinedOffices ? "Vespers and Matins" : edit ? service.name : service.name.replace(/^Recordings · /u, "");
    const grid = document.createElement("div");
    grid.className = "hymn-grid";
    for (const h of matches) {
      count++;
      const item = document.createElement("article");
      item.className = "hymn-card";
      item.dataset.hymnId = h.id;
      if (edit) item.classList.add("hymn-card-editable");
      const link = document.createElement("a");
      link.className = "hymn-card-link";
      link.href = "#/hymn/" + h.id;
      const title = document.createElement("strong");
      title.textContent = displayHymnName(h);
      const detail = document.createElement("span");
      detail.textContent = edit && h.source === "Tasbeha" ? "Recording" : hazzatHtml(h) || h.hazzat || h.hazzatPages?.length ? "Hazzat" : "Text";
      if (completedProjects.has(h.id)) detail.textContent += " · Synced and ready";
      link.append(title, detail);
      item.append(link);
      if (edit) {
        const handle = document.createElement("button");
        handle.className = "hymn-drag-handle";
        handle.type = "button";
        handle.draggable = true;
        handle.textContent = "⠿";
        handle.title = "Drag to reorder this hymn";
        handle.setAttribute("aria-label", "Move " + displayHymnName(h));
        handle.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight");
        handle.disabled = librarySaving;
        const move = targetId => moveLibraryCard(visible.map(row => row.h), h.id, targetId, inFolder);
        handle.addEventListener("keydown", event => {
          if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const index = visible.findIndex(row => row.h.id === h.id);
          const target = visible[index + (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1)];
          if (target) void move(target.h.id);
        });
        bindTouchCardDrag(handle, item, grid, move);
        handle.addEventListener("dragstart", event => {
          event.dataTransfer?.setData("text/plain", h.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          item.classList.add("dragging");
        });
        handle.addEventListener("dragend", () => item.classList.remove("dragging"));
        const remove = document.createElement("button");
        remove.className = "hymn-remove-button";
        remove.type = "button";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", "Remove " + displayHymnName(h) + " from the library");
        remove.disabled = librarySaving;
        remove.addEventListener("click", async () => {
          try {
            await saveHymnLibraryChange({ action: "remove", hymnId: h.id });
            hymnLibraryState[h.id] = { ...(hymnLibraryState[h.id] || {}), removed: true };
            renderLibrary();
          } catch (error) { alert(error.message || "Could not remove this hymn."); }
        });
        const rename = document.createElement("button");
        rename.type = "button";rename.className = "hymn-title-edit";rename.textContent = "Edit title";
        rename.setAttribute("aria-label", "Edit title of " + displayHymnName(h));
        rename.disabled = librarySaving;
        rename.addEventListener("click", () => editCardTitle(h, item, link, rename));
        item.append(handle, remove, rename);
      }
      grid.append(item);
    }
    if (showFolder) { grid.append(doxologyFolderCard(doxologies.length)); folderShown = true; }
    if (edit) {
      grid.addEventListener("dragover", event => {
        if (event.target.closest(".hymn-card[data-hymn-id]")) event.preventDefault();
      });
      grid.addEventListener("drop", async event => {
        const target = event.target.closest(".hymn-card[data-hymn-id]");
        const draggedId = event.dataTransfer?.getData("text/plain");
        if (!target || !draggedId || draggedId === target.dataset.hymnId) return;
        event.preventDefault();
        await moveLibraryCard(visible.map(row => row.h), draggedId, target.dataset.hymnId, inFolder);
      });
    }
    if (combinedOffices) {
      if (!officesGroup) {
        officesGroup = group;
        officesGrid = document.createElement("div");
        officesGrid.className = "hymn-grid";
        group.append(header, officesGrid);
        list.append(group);
      }
      // Keep each source category's reorder controls bound to its own hymns.
      grid.style.display = "contents";
      officesGrid.append(grid);
    } else {
      group.append(header, grid);
      list.append(group);
    }
  }
  if (!count && !folderShown) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = inFolder ? (query ? "No matching doxologies." : "No doxologies in this folder yet.") : query ? "No matching hymns in this season." : "No hymns in this season.";
    list.append(empty);
  }
  $("hymnCount").textContent = String(count);
  $("seasonTitle").textContent = inFolder ? "Doxologies" : allSeasons().find(s => s.id === selectedSeason)?.name || "Hymns";
  $("libraryEyebrow").textContent = inFolder ? "Annual · Matins" : "Season";
  $("librarySummary").textContent = inFolder ? "Choose an individual doxology." : count + " hymns";
  $("libraryBack").href = inFolder ? "#/season/annual" : "#/seasons";
  $("libraryBack").textContent = inFolder ? "← Annual" : "← All seasons";
  $("search").placeholder = inFolder ? "Search doxologies" : "Search hymns in this season";
  $("librarySearchLabel").textContent = inFolder ? "Search doxologies" : "Search hymns in this season";
  renderRemovedHymns(query);
}
function displayHymnName(h) { return hymnLibraryState[h.id]?.title || h.name; }
function readerLibraryHymn(h) {
  return h.source !== "Tasbeha" || completedProjects.has(h.id) || Boolean(hymnText(h).trim() || hymnCopticText(h).trim() || hazzatHtml(h) || h.hazzat || h.hazzatPages?.length);
}
async function moveLibraryCard(hymns, draggedId, targetId, inFolder) {
  if (!canEdit || !editingLibrary || librarySaving) return;
  const ordered = [...hymns], from = ordered.findIndex(h => h.id === draggedId), to = ordered.findIndex(h => h.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  ordered.splice(to, 0, ordered.splice(from, 1)[0]);
  const parts = ordered[0].id.split("/");
  librarySaving = true;$("editLibraryBtn").disabled = true;$("libraryEditStatus").textContent = "Saving order…";
  try {
    await saveHymnLibraryChange({ action: "reorder", seasonId: parts[0], ...(inFolder ? { folderId: "doxologies" } : { categoryId: parts[1] }), hymnIds: ordered.map(h => h.id) });
    ordered.forEach((h,index) => { hymnLibraryState[h.id] = { ...hymnLibraryState[h.id], [inFolder ? "folderOrder" : "order"]: index }; });
    $("libraryEditStatus").textContent = "Order saved.";
  } catch (error) { $("libraryEditStatus").textContent = error.message || "Could not save the new order. Try again."; }
  finally {
    librarySaving = false;renderLibrary();
    Array.from($("hymnList").querySelectorAll("[data-hymn-id]")).find(item => item.dataset.hymnId === draggedId)?.querySelector(".hymn-drag-handle")?.focus({ preventScroll: true });
  }
}
function bindTouchCardDrag(handle, item, grid, move) {
  let start = null, targetId = null, dragging = false;
  const clear = () => { start = null;targetId = null;dragging = false;item.classList.remove("dragging");grid.querySelectorAll(".drop-target").forEach(card => card.classList.remove("drop-target")); };
  handle.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" || librarySaving) return;
    start = [event.clientX,event.clientY];handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", event => {
    if (!start) return;
    if (!dragging && Math.hypot(event.clientX-start[0],event.clientY-start[1]) < 8) return;
    dragging = true;item.classList.add("dragging");
    const card = document.elementFromPoint(event.clientX,event.clientY)?.closest(".hymn-card[data-hymn-id]");
    targetId = card && grid.contains(card) && card !== item ? card.dataset.hymnId : null;
    grid.querySelectorAll(".drop-target").forEach(other => other.classList.toggle("drop-target", other === card && Boolean(targetId)));
    if (event.clientY < 70) window.scrollBy(0,-18);
    else if (event.clientY > innerHeight-70) window.scrollBy(0,18);
  });
  handle.addEventListener("pointerup", () => { const target = targetId;clear();if (target) void move(target); });
  handle.addEventListener("pointercancel", clear);
}
function editCardTitle(h, item, link, button) {
  if (librarySaving || item.querySelector("form")) return;
  const form = document.createElement("form");form.className = "hymn-title-form";
  const label = document.createElement("label");label.textContent = "Hymn title";
  const input = document.createElement("input");input.type = "text";input.required = true;input.maxLength = 240;input.value = displayHymnName(h);
  label.append(input);
  const save = document.createElement("button");save.type = "submit";save.textContent = "Save";
  const cancel = document.createElement("button");cancel.type = "button";cancel.textContent = "Cancel";
  const note = document.createElement("span");note.setAttribute("role", "status");
  const close = () => { form.remove();link.hidden = false;button.hidden = false;button.focus(); };
  cancel.addEventListener("click", close);
  input.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault();close(); } });
  form.addEventListener("submit", async event => {
    event.preventDefault();if (librarySaving) return;
    if (!input.value.trim()) { note.textContent = "Enter a title.";input.focus();return; }
    librarySaving = true;save.disabled = true;cancel.disabled = true;input.disabled = true;$("editLibraryBtn").disabled = true;note.textContent = "Saving…";
    try {
      const data = await saveHymnLibraryChange({ action: "rename", hymnId: h.id, title: input.value });
      hymnLibraryState[h.id] = { ...hymnLibraryState[h.id], title: data.title };
      $("libraryEditStatus").textContent = "Title saved.";
      librarySaving = false;renderLibrary();
    } catch (error) { note.textContent = error.message || "Could not save this title."; }
    finally { librarySaving = false;save.disabled = false;cancel.disabled = false;input.disabled = false;$("editLibraryBtn").disabled = false; }
  });
  form.append(label, save, cancel, note);link.hidden = true;button.hidden = true;item.prepend(form);input.focus();input.select();
}
$("editLibraryBtn").addEventListener("click", () => {
  if (!canEdit || librarySaving) return;
  editingLibrary = !editingLibrary;$("libraryEditStatus").textContent = "";renderLibrary();
});
async function saveHymnLibraryChange(change) {
  const response = await fetch("/api/library/hymn-state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not save the library change.");
  return data;
}
function renderRemovedHymns(query) {
  const panel = $("removedHymnsPanel"), list = $("removedHymnList");
  if (!panel || !list) return;
  const removed = seasonServices.flatMap(service => service.hymns.filter(h => hymnLibraryState[h.id]?.removed && (!selectedFolder || isDoxology(h, service)) && displayHymnName(h).toLocaleLowerCase().includes(query)).map(h => ({ h, service })));
  panel.hidden = !canEdit || !editingLibrary || !removed.length;
  panel.open = showRemovedHymns;
  $("removedHymnsSummary").textContent = "Removed hymns (" + removed.length + ")";
  list.replaceChildren();
  for (const { h, service } of removed) {
    const card = document.createElement("article");
    card.className = "hymn-card removed-hymn-card";
    const link = document.createElement("a");
    link.className = "hymn-card-link";
    link.href = "#/hymn/" + h.id;
    const title = document.createElement("strong");
    title.textContent = displayHymnName(h);
    const detail = document.createElement("span");
    detail.textContent = service.name;
    link.append(title, detail);
    const restore = document.createElement("button");
    restore.className = "hymn-restore-button";
    restore.type = "button";
    restore.textContent = "Restore";
    restore.addEventListener("click", async () => {
      try {
        await saveHymnLibraryChange({ action: "restore", hymnId: h.id });
        hymnLibraryState[h.id] = { ...(hymnLibraryState[h.id] || {}), removed: false };
        renderLibrary();
      } catch (error) { alert(error.message || "Could not restore this hymn."); }
    });
    card.append(link, restore);
    list.append(card);
  }
  panel.onToggle = () => { showRemovedHymns = panel.open; };
}
function renderHazzatPages(h) {
  const score = document.createElement("div");
  score.className = "hazzat-score hazzat-image-score";
  let position = 0;
  for (const page of h.hazzatPages || []) {
    const frame = document.createElement("div");
    frame.className = "hazzat-image-page";
    const image = document.createElement("img");
    image.src = page.imageUrl;
    image.alt = "Hazzat score page " + (page.page + 1);
    image.loading = page.page > 1 ? "lazy" : "eager";
    frame.append(image);
    for (const line of page.lines || []) {
      const lineIndex = position++;
      const stack = document.createElement("button");
      stack.type = "button";
      stack.className = "hazzat-stack hazzat-image-stack";
      stack.dataset.position = String(lineIndex);
      stack.style.top = (line.top * 100) + "%";
      stack.style.height = (line.height * 100) + "%";
      stack.classList.toggle("timed", Number.isFinite(h.hazzatLineTimings?.[lineIndex]));
      stack.classList.toggle("marking", aligning);
      stack.classList.toggle("next-to-mark", aligning && alignmentKey === "hazzatLineTimings" && alignmentCursor === lineIndex);
      stack.setAttribute("aria-label", "Hazzat stack " + (lineIndex + 1) + (Number.isFinite(h.hazzatLineTimings?.[lineIndex]) ? ", " + stamp(h.hazzatLineTimings[lineIndex]) : ""));
      const useStack = () => {
        if (aligning) { activateTiming(h, "hazzatLineTimings", lineIndex); return; }
        playFrom(h.hazzatLineTimings?.[lineIndex], "hazzat", "This stack has no timing yet.");
      };
      stack.addEventListener("click", useStack);
      stack.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key) && !(aligning && event.key === " ")) { event.preventDefault(); useStack(); }
      });
      frame.append(stack);
    }
    score.append(frame);
  }
  h.hazzatGroupCount = 0;
  h.hazzatLineCount = position;
  return score;
}
function hazzatHitTokens(text) {
  // Dots separate stacks even when the source omits whitespace.
  // Keep punctuation and repeat endings attached to their preceding stack.
  return text.split(/(\s+)/u).flatMap(part => part.split(/(?<=\.)(?=[^\s).])/u));
}
function expandHazzatTimings(values, counts) {
  return counts.flatMap((count, index) => [values?.[index] ?? null, ...Array(count - 1).fill(null)]);
}
function migrateHazzatHitBoxes(h, html, counts) {
  const marker = "<!-- hazzat-hit-boxes:v2 -->";
  if (html.includes(marker) || h.id === "annual/liturgy-of-the-word/al-el-qorban" || counts.every(n => n === 1)) return;
  const starts = [0];
  for (const count of counts) starts.push(starts.at(-1) + count);
  h.hazzatTimings = expandHazzatTimings(h.hazzatTimings, counts);
  h.repeatSections = (h.repeatSections || []).map(section => {
    if (section.key !== "hazzatTimings") return section;
    const { startIndex, endIndex } = section;
    if (starts[startIndex] === undefined || starts[endIndex + 1] === undefined) return section;
    return { ...section, startIndex: starts[startIndex], endIndex: starts[endIndex + 1] - 1,
      passes: section.passes.map(values => expandHazzatTimings(values, counts.slice(startIndex, endIndex + 1))) };
  });
  // Persist the index format with the notation on the next ordinary editor save.
  h.notationHtml = html + marker;
}
function safeHazzat(html, h) {
  const source = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html").body.firstElementChild;
  const counts = [...source.querySelectorAll(".HazzatFont, .HazzatVFont")].flatMap(span =>
    (span.textContent || "").split(/\s+/u).filter(Boolean).map(token => hazzatHitTokens(token).filter(Boolean).length));
  migrateHazzatHitBoxes(h, html, counts);
  const output = document.createElement("div");
  output.className = "hazzat-score";
  let index = 0;
  let line = document.createElement("div");
  line.className = "hazzat-line";
  output.append(line);
  const walk = (node, parent) => {
    const target = parent === output ? line : parent;
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(node.textContent));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const name = node.tagName.toLowerCase();
    if (name === "br") {
      line = document.createElement("div");
      line.className = "hazzat-line";
      output.append(line);
      return;
    }
    const className = node.classList.contains("HazzatFont") ? "HazzatFont"
      : node.classList.contains("HazzatVFont") ? "HazzatVFont"
      : node.classList.contains("CopticFont") ? "CopticFont"
      : node.classList.contains("EnglishFont") ? "EnglishFont"
      : node.classList.contains("ArabicFont") ? "ArabicFont" : "";
    const tag = ["span", "div", "b", "i"].includes(name) ? name : "span";
    const element = document.createElement(tag);
    if (className) element.className = className;
    for (const child of node.childNodes) walk(child, element);
    if (className === "HazzatFont" || className === "HazzatVFont") {
      for (const token of hazzatHitTokens(element.textContent || "", h.id)) {
        if (!token) continue;
        if (/^\s+$/u.test(token)) { target.append(document.createTextNode(token)); continue; }
        const mark = document.createElement("button");
        const position = index++;
        mark.type = "button";
        mark.dataset.position = String(position);
        mark.className = "hazza-mark" + (Number.isFinite(h.hazzatTimings?.[position]) ? " timed" : "") + (aligning ? " marking" : "");
        mark.setAttribute("aria-label", "Hazzat passage " + (position + 1) + (Number.isFinite(h.hazzatTimings?.[position]) ? ", " + stamp(h.hazzatTimings[position]) : ""));
        const glyphs = document.createElement("span");
        glyphs.className = className;
        glyphs.textContent = token;
        mark.append(glyphs);
        mark.addEventListener("click", () => {
          if (!aligning && !Number.isFinite(h.hazzatTimings?.[position])) {
            showPlayer("hazzat");
            setHelp("This passage has no timing yet. You can play the recording from the controls.");
            return;
          }
          activateTiming(h, "hazzatTimings", position);
        });
        target.append(mark);
      }
    } else target.append(element);
  };
  for (const child of source.childNodes) walk(child, output);
  const rows = [...output.children];
  output.replaceChildren();
  const stacks = [];
  let stack = null;
  for (const row of rows) {
    if (!row.textContent.trim()) { stack = null; continue; }
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "hazzat-stack";
      output.append(stack);
      stacks.push(stack);
    }
    stack.append(row);
  }
  stacks.forEach((box, stackIndex) => {
    box.dataset.position = String(stackIndex);
    box.classList.toggle("timed", Number.isFinite(h.hazzatLineTimings?.[stackIndex]));
    box.classList.toggle("marking", aligning);
    box.setAttribute("role", "button");
    box.setAttribute("tabindex", "0");
    box.setAttribute("aria-label", "Hazzat stack " + (stackIndex + 1));
    const useStack = () => {
      if (aligning) { activateTiming(h, "hazzatLineTimings", stackIndex); return; }
      const start = Number.isFinite(h.hazzatLineTimings?.[stackIndex])
        ? h.hazzatLineTimings[stackIndex]
        : [...box.querySelectorAll(".hazza-mark")]
            .map(mark => h.hazzatTimings?.[Number(mark.dataset.position)])
            .find(Number.isFinite);
      playFrom(start, "hazzat", "This stack has no timing yet.");
    };
    box.playFromStart = useStack;
    box.addEventListener("click", event => {
      if (event.target.closest(".hazza-mark")) return;
      useStack();
    });
    box.addEventListener("keydown", event => {
      if (event.target !== box || !["Enter", " "].includes(event.key)) return;
      if (aligning && event.key === " ") return;
      event.preventDefault();
      useStack();
    });
  });
  h.hazzatGroupCount = index;
  h.hazzatLineCount = stacks.length;
  return output;
}
function playFrom(start, kind = "hazzat", unavailable = "This part has no timing yet.") {
  showPlayer(kind);
  const player = players[kind];
  if (!Number.isFinite(start) || !player.src) { setHelp(player.src ? unavailable : "No recording is attached to this section yet.", kind); return; }
  if (chooseRepeatPoint(start, kind)) return;
  clipEnd = null;
  const range = recordingRange(current(), kind);
  playAtTime(kind, Math.max(range.start, Math.min(start, range.end || start)));
}
function renderReader() {
  const h = current();
  const content = $("readerContent");
  content.replaceChildren();
  content.classList.toggle("completed-hymn", Boolean(h && (h.projectStatus === "complete" || completedProjects.has(h.id))));
  const sourcePanel = $("sourcePanel");
  sourcePanel.replaceChildren();
  sourcePanel.hidden = true;
  if (!h) {
    hidePlayer();
    $("hymnCategory").textContent = "Season";
    $("hymnTitle").textContent = seasonIndex.find(s => s.id === selectedSeason)?.name || "Season";
    $("hymnSubtitle").textContent = "No hymn selected.";
    $("timingBtn").disabled = $("exportBtn").disabled = true;
    $("alignStatus").textContent = "Choose a hymn";
    return;
  }
  $("timingBtn").disabled = $("exportBtn").disabled = false;
  $("hymnCategory").textContent = h.category || "Hymn";
  $("hymnTitle").textContent = displayHymnName(h);
  const englishText = hymnText(h);
  const copticText = hymnCopticText(h);
  const notation = hazzatHtml(h);
  const hasWords = Boolean(englishText.trim() || copticText.trim());
  const hasHazzat = Boolean(h.hazzatPages?.length || (notation || "").replace(/<[^>]*>/gu, "").replace(/&nbsp;/giu, " ").trim() || (typeof h.hazzat === "string" && h.hazzat.trim()));
  const hasRecording = Object.keys(players).some(kind => audioFor(h, kind));
  const editing = canEdit && workspace.classList.contains("editing");
  if (view === "words" && !hasWords) view = hasHazzat ? "hazzat" : "recording";
  else if (view === "hazzat" && !hasHazzat) view = hasWords ? "words" : "recording";
  else if (view === "recording" && (hasWords || hasHazzat)) view = hasWords ? "words" : "hazzat";
  if (view === "recording") aligning = false;
  $("hymnSubtitle").textContent = !hasWords && !hasHazzat
    ? editing && hasRecording ? "Recording available. Words and Hazzat have not been added yet." : "Words and Hazzat have not been added yet."
    : hasRecording ? editing ? "Play from the top, or tap a timed part to start there. The current part lights up as it plays." : "Tap a timed part to listen. The current part lights up as it plays." : "";
  $("readerToolbar").hidden = !hasWords && !hasHazzat;
  $("wordsTab").hidden = !hasWords;
  $("hazzatTab").hidden = !hasHazzat;
  $("wordsTab").classList.toggle("active", view === "words");
  $("hazzatTab").classList.toggle("active", view === "hazzat");
  $("wordsTab").setAttribute("aria-selected", String(view === "words"));
  $("hazzatTab").setAttribute("aria-selected", String(view === "hazzat"));
  if (textLanguage === "english" && !englishText.trim()) textLanguage = "coptic";
  if (textLanguage === "coptic" && !copticText.trim()) textLanguage = "english";
  $("textLanguageWrap").hidden = view !== "words" || !englishText.trim() || !copticText.trim();
  $("englishLanguageBtn").hidden = !englishText.trim();
  $("copticLanguageBtn").hidden = !copticText.trim();
  $("englishLanguageBtn").disabled = !englishText.trim();
  $("copticLanguageBtn").disabled = !copticText.trim();
  $("englishLanguageBtn").setAttribute("aria-pressed", String(textLanguage === "english"));
  $("copticLanguageBtn").setAttribute("aria-pressed", String(textLanguage === "coptic"));
  $("hazzatRecordingLabel").textContent = hasHazzat ? "Hazzat recording" : "Recording";
  showPlayer(visiblePlayerKind(h));
  if (view === "hazzat") {
    const html = notation;
    if (h.hazzatPages?.length) content.append(renderHazzatPages(h));
    else if (html) content.append(safeHazzat(html, h));
    else if (h.hazzat) {
      const notes = document.createElement("div");
      notes.className = "hazzat-content";
      notes.textContent = h.hazzat;
      content.append(notes);
    } else {
      const message = document.createElement("p");
      message.className = "note-empty";
      message.textContent = "Hazzat notation is not available for this hymn.";
      content.append(message);
    }
    if (hasHazzat) {
      const attribution = document.createElement("p");
      attribution.className = "hazzat-attribution";
      attribution.append("Hazzat sourced from ");
      const source = document.createElement("a");
      source.href = "https://hazzat.com";
      source.textContent = "hazzat.com";
      attribution.append(source);
      content.append(attribution);
    }
  } else if (view === "words") {
    if (!englishText.trim() && !copticText.trim()) {
      const message = document.createElement("p");
      message.className = "note-empty";
      message.textContent = "Hymn words have not been added yet.";
      content.append(message);
      updateStatus();
      refreshAlignmentTarget();
      updateKaraoke();
      return;
    }
    const block = document.createElement("div");
    block.className = "word-line";
    const englishLines = englishText.split("\n");
    const copticLines = copticText.split("\n");
    const choice = textLanguage;
    let englishIndex = 0;
    let copticIndex = 0;
    const addRow = (holder, line, language, firstWord, otherFirstWord, lineIndex) => {
      const key = language === "coptic" ? "copticTimings" : "timings";
      const row = document.createElement("div");
      row.className = "word-row" + (language === "coptic" ? " coptic-row" : "");
      if (language === "coptic" && h.textEncoding === "unicode") row.classList.add("coptic-unicode");
      row.lang = language === "coptic" ? "cop" : "en";
      row.dataset.position = String(firstWord);
      let index = firstWord;
      for (const word of words(line)) {
        const position = index++;
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.position = String(position);
        button.className = "word" + (Number.isFinite(h[key]?.[position]) ? " timed" : "") + (aligning ? " marking" : "");
        button.textContent = word;
        button.setAttribute("aria-label", language + " " + word + (Number.isFinite(h[key]?.[position]) ? ", " + stamp(h[key][position]) : ""));
        button.addEventListener("click", () => {
          if (!aligning && !Number.isFinite(h[key]?.[position])) {
            playFrom(undefined, language, "This word has no timing yet.");
            return;
          }
          activateTiming(h, key, position);
        });
        row.append(button, document.createTextNode(" "));
      }
      if (index === firstWord) return;
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.setAttribute("aria-label", language + " text line " + (lineIndex + 1));
      row.classList.toggle("timed", Number.isFinite(h[key]?.[firstWord]));
      const playLine = () => {
        if (aligning) { activateTiming(h, key, firstWord); return; }
        const start = h[key]?.[firstWord];
        playFrom(start, language, "This line has no timing yet.");
      };
      row.addEventListener("click", event => { if (!event.target.closest(".word")) playLine(); });
      row.addEventListener("keydown", event => {
        if (event.target !== row || !["Enter", " "].includes(event.key)) return;
        if (aligning && event.key === " ") return;
        event.preventDefault();
        playLine();
      });
      holder.append(row);
    };
    for (let i = 0; i < Math.max(englishLines.length, copticLines.length); i++) {
      const englishLine = englishLines[i] || "";
      const copticLine = copticLines[i] || "";
      const pair = document.createElement("div");
      pair.className = "bilingual-pair";
      if (choice === "coptic" && copticLine.trim()) addRow(pair, copticLine, "coptic", copticIndex, englishIndex, i);
      if (choice === "english" && englishLine.trim()) addRow(pair, englishLine, "english", englishIndex, copticIndex, i);
      if (pair.childElementCount) block.append(pair);
      englishIndex += words(englishLine).length;
      copticIndex += words(copticLine).length;
    }
    content.append(block);
  } else if (!editing || !hasRecording) {
    const message = document.createElement("p");
    message.className = "note-empty";
    message.textContent = "Words and Hazzat have not been added yet.";
    content.append(message);
  }
  updateStatus();
  refreshAlignmentTarget();
  updateKaraoke();
  updateRepeatAlignmentControl();
  renderRepeatSections();
}
function updateStatus() {
  const h = current();
  if (!h) return;
  const countTimed = (key, total) => Array.from({ length: total }, (_, i) => h[key]?.[i]).filter(Number.isFinite).length;
  $("alignBtn").disabled = view === "recording";
  if (view === "recording") {
    $("alignStatus").textContent = "Add words or Hazzat to begin aligning";
  } else if (view === "hazzat") {
    const passages = h.hazzatGroupCount || 0;
    const stacks = h.hazzatLineCount || 0;
    $("alignStatus").textContent = countTimed("hazzatTimings", passages) + " of " + passages + " passages timed · " + countTimed("hazzatLineTimings", stacks) + " of " + stacks + " stacks";
  } else {
    const english = words(hymnText(h)).length;
    const coptic = words(hymnCopticText(h)).length;
    $("alignStatus").textContent = "English " + countTimed("timings", english) + " of " + english + " words" + (coptic ? " · Coptic " + countTimed("copticTimings", coptic) + " of " + coptic + " words" : "");
  }
  $("alignBtn").textContent = aligning ? "Finish aligning" : "Start aligning";
}
function activateTiming(h, key, index) {
  const kind = key === "timings" ? "english" : key === "copticTimings" ? "coptic" : "hazzat";
  if (aligning && alignmentBounds && (key !== alignmentBounds.key || index < alignmentBounds.start || index > alignmentBounds.end)) {
    setHelp("This repeat alignment is limited to the selected part of the hymn.", kind);
    return;
  }
  const wasHidden = $("recordingGrid").hidden || $("recordingGrid").querySelector('[data-recording-section="' + kind + '"]').hidden;
  showPlayer(kind);
  const player = players[kind];
  if (aligning) {
    if (!player.src || !Number.isFinite(player.currentTime)) { setHelp("Choose this section’s recording before marking it.", kind); return; }
    if (wasHidden || player.paused) { setHelp("Play this recording, then tap the part again when it begins.", kind); return; }
    h[key] ||= [];
    if (repeatPass && key !== repeatPass.key) { setHelp("Mark the selected repeat parts only.", kind); return; }
    markTiming(h, key, index, player.currentTime);
    alignmentScope = view === "words" ? textLanguage : "hazzat";
    alignmentKey = key;
    alignmentCursor = index + 1;
    markUnsaved();
    renderReader();
    focusAlignmentTarget();
    return;
  }
  const start = h[key]?.[index];
  if (!Number.isFinite(start)) { setHelp("This passage has no timing yet. Use Align recording to mark it.", kind); return; }
  playFrom(start, kind);
}
async function loadSeason(id, sequence) {
  if (id !== selectedSeason) $("search").value = "";
  selectedSeason = id;
  aligning = false;
  hidePlayer();
  clipEnd = null;
  $("hymnList").textContent = "Loading hymns…";
  try {
    if (!seasonCache.has(id)) {
      let services = [];
      if (seasonIndex.some(season => season.id === id)) {
        const catalog = await loadSeasonAsset(id);
        services = catalog.map(service => ({ ...service, hymns: (service.hymns || []).map(hymn => ({ ...hymn })) }));
      }
      if (id === "annual") services.sort((a, b) => Number(b.id === "midnight-psalmody-4") - Number(a.id === "midnight-psalmody-4"));
      for (const service of services) {
        service.hymns = service.hymns.map(hymn => ({
          ...hymn, id: id + "/" + service.id + "/" + hymn.id,
          category: service.name, season: id, source: hymn.source || "Hazzat", timings: [], copticTimings: [], hazzatTimings: [], hazzatLineTimings: []
        }));
      }
      const albums = new Map();
      for (const track of extraRecordings(id)) {
        const album = track.album || "Other recordings";
        if (!albums.has(album)) albums.set(album, []);
        albums.get(album).push(track);
      }
      for (const [album, tracks] of albums) {
        const serviceId = "recordings-" + shortSlug(album) + "-" + shortHash(album);
        services.push({
          id: serviceId,
          name: "Recordings · " + album,
          hymns: tracks.map(track => ({
            id: id + "/" + serviceId + "/" + shortSlug(track.title) + "-" + shortHash(track.url),
            name: track.title, category: "Recordings · " + album, season: id,
            source: "Tasbeha", trackMeta: track, recordingUrl: track.url,
            timings: [], copticTimings: [], hazzatTimings: [], hazzatLineTimings: []
          }))
        });
      }
      const customCategories = customCategoriesForSeason(id);
      for (const category of customCategories) {
        if (!services.some(service => service.id === category.id)) services.push({ id: category.id, name: category.name, hymns: [] });
      }
      for (const customHymn of customHymnsForSeason(id)) {
        const hymn = applyCustomProject(customHymn);
        let service = services.find(item => item.id === hymn.category);
        if (!service) { service = { id: hymn.category, name: hymn.category, hymns: [] }; services.push(service); }
        service.hymns.push(hymn);
      }
      seasonCache.set(id, services);
    }
    if (sequence !== routeSequence) return false;
    seasonServices = seasonCache.get(id);
    renderLibrary();
    $("backToHymns").href = selectedFolder ? "#/folder/annual/doxologies" : "#/season/" + id;
    $("backToHymns").textContent = selectedFolder ? "← Doxologies" : "← Hymns";
    return true;
  } catch {
    $("hymnList").textContent = "Could not load this season. Try again.";
    return false;
  }
}
function selectHymn(id) {
  globalThis.AlignmentReview?.leave();
  resetRepeat();
  selectedId = id;
  aligning = false;
  clipEnd = null;
  hidePlayer();
  const h = current();
  $("textInput").value = h?.textOverride || "";
  $("copticInput").value = h?.copticTextOverride || "";
  $("notationInput").value = notationForEditor(h?.notationHtml || "");
  const track = h && (h.trackMeta || chosenAudio.get(h.id) || audioMatches[h.id]);
  for (const kind of Object.keys(players)) setPlayerSource(h, kind);
  renderRecordingPicker(h, track);
  $("projectState").textContent = "Checking saved project…";
  renderReader();
  if (h) void loadProject(h);
}
function showScreen(name) {
  $("seasonsView").hidden = name !== "seasons";
  $("hymnsView").hidden = name !== "hymns";
  $("projectsView").hidden = name !== "projects";
  $("readerView").hidden = name !== "reader";
  if (name !== "reader") {
    hidePlayer();
    clipEnd = null;
    aligning = false;
    workspace.classList.remove("editing");
    $("timingBtn").textContent = "Edit hymn";
  }
  window.scrollTo(0, 0);
}
async function route() {
  const sequence = ++routeSequence;
  editingLibrary = false;
  $("libraryEditStatus").textContent = "";
  if (autosaveTimer && current()?.dirty) {
    const pending = current();
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    void saveDraft(pending);
  }
  const path = decodeURIComponent(location.hash.slice(2));
  const requestedSeason = path.startsWith("season/") ? path.slice(7) : path.startsWith("hymn/") ? path.split("/")[1] : null;
  if (!canEdit && requestedSeason && !["annual", "kiahk"].includes(requestedSeason)) {
    location.hash = "#/seasons";
    showScreen("seasons");
    return;
  }
  if (!path || path === "seasons") { showScreen("seasons"); return; }
  if (path === "projects") {
    if (!canEdit) { location.hash = "#/seasons"; return; }
    showScreen("projects");
    await loadProjects();
    return;
  }
  if (path === "folder/annual/doxologies") {
    selectedFolder = "doxologies";$("search").value = "";
    if (await loadSeason("annual", sequence) && sequence === routeSequence) showScreen("hymns");
    return;
  }
  if (path.startsWith("season/")) {
    if (selectedFolder) $("search").value = "";
    selectedFolder = null;
    const id = path.slice(7);
    if (!allSeasons().some(s => s.id === id)) { location.hash = "#/seasons"; return; }
    if (await loadSeason(id, sequence) && sequence === routeSequence) showScreen("hymns");
    return;
  }
  if (path.startsWith("hymn/")) {
    const id = path.slice(5);
    const season = id.split("/")[0];
    if (season !== "annual") selectedFolder = null;
    if (!allSeasons().some(s => s.id === season)) { location.hash = "#/seasons"; return; }
    if (!(await loadSeason(season, sequence)) || sequence !== routeSequence) return;
    if (!allHymns().some(h => h.id === id)) { location.hash = "#/season/" + season; return; }
    selectHymn(id);
    showScreen("reader");
    return;
  }
  location.hash = "#/seasons";
}
function renderRecordingPicker(h, selected) {
  for (const kind of Object.keys(players)) {
    const picker = playerElement(kind, "RecordingPicker");
    picker.replaceChildren(new Option("Choose a recording", ""));
    if (!h) continue;
    const tracks = recordingsBySeason[h.season] || [];
    for (const track of tracks) picker.add(new Option(track.title + " · " + track.album, track.url));
    if (kind === "hazzat" && selected && !tracks.some(track => track.url === selected.url)) picker.add(new Option(selected.title + " · " + selected.album, selected.url));
    const url = audioFor(h, kind);
    if (url && !tracks.some(track => track.url === url)) picker.add(new Option("Saved or uploaded recording", url));
    picker.value = url;
  }
}
function markUnsaved() {
  const h = current();
  if (!h || !canEdit) return;
  h.dirty = true;
  h.editVersion = (h.editVersion || 0) + 1;
  $("projectState").textContent = "Saving changes online…";
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { autosaveTimer = null; void saveDraft(h); }, 1000);
}
function applyProject(h, project) {
  h.dirty = false;
  if (project.status === "complete") completedProjects.add(h.id);
  else completedProjects.delete(h.id);
  renderSeasons();
  renderLibrary();
  h.timings = project.timings || [];
  h.copticTimings = project.copticTimings || [];
  h.hazzatTimings = project.hazzatTimings || [];
  h.hazzatLineTimings = project.hazzatLineTimings || [];
  h.recordingUrl = project.recordingUrl || "";
  h.englishRecordingUrl = project.englishRecordingUrl || "";
  h.copticRecordingUrl = project.copticRecordingUrl || "";
  h.notationHtml = project.notationHtml || "";
  h.textOverride = project.textContent || "";
  h.copticTextOverride = project.copticText || "";
  h.notationKey = project.notationKey || "";
  h.repeatSections = project.repeatSections || [];
  h.recordingClips = project.recordingClips || {};
  h.hazzatPages = project.hazzatPages || [];
  h.projectStatus = project.status;
  if (h.id !== selectedId) return;
  $("textInput").value = h.textOverride;
  $("copticInput").value = h.copticTextOverride;
  $("notationInput").value = notationForEditor(h.notationHtml);
  renderClipControls(h);
  for (const kind of Object.keys(players)) if (players[kind].getAttribute("src") !== audioFor(h, kind)) setPlayerSource(h, kind);
  const track = h.trackMeta || chosenAudio.get(h.id) || audioMatches[h.id];
  renderRecordingPicker(h, track);
  $("projectState").textContent = project.status === "complete" ? "Complete and ready for listeners" : "Draft saved online";
  renderReader();
  if (canEdit) void globalThis.AlignmentReview?.load(h);
}
async function loadProject(h) {
  try {
    const params = new URLSearchParams({ hymnId: h.id, title: h.name, season: h.season, service: h.category,
      recordingUrl: audioFor(h), englishRecordingUrl: audioFor(h, "english"), copticRecordingUrl: audioFor(h, "coptic") });
    if (h.source === "Coptic Reader") params.delete("title");
    const response = await fetch("/api/project?" + params);
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.project && !h.dirty) applyProject(h, data.project);
    else if (h.id === selectedId) $("projectState").textContent = "Not saved yet";
    if (canEdit) void globalThis.AlignmentReview?.load(h);
  } catch {
    if (h.id === selectedId) $("projectState").textContent = "Could not check cloud storage";
  }
}
async function readProjectResponse(response) {
  let data;
  try { data = await response.json(); } catch {
    if (response.redirected || response.status === 401 || response.status === 403) throw new Error("Your sign-in has expired. Sign in again, then retry the upload.");
    if (response.status === 413) throw new Error("This file is too large. Choose a smaller file and try again.");
    throw new Error("The server could not finish saving. Your changes are still on this page; try again.");
  }
  if (!response.ok) throw new Error(data.error || "Could not save. Your changes are still on this page; try again.");
  if (!data || !data.project) throw new Error("The server did not confirm the save. Your changes are still on this page; try again.");
  return data;
}

async function saveDraft(h = current()) {
  if (!canEdit || !h) return false;
  if (h.id === selectedId) $("projectState").textContent = "Saving online…";
  const prior = savePromise;
  const task = (async () => {
    if (prior) await prior.catch(() => {});
    const version = h.editVersion || 0;
    const response = await fetch("/api/project?hymnId=" + encodeURIComponent(h.id), {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: h.name, season: h.season, service: h.category, repeatSections: h.repeatSections || [],
        timings: h.timings || [], copticTimings: h.copticTimings || [], hazzatTimings: h.hazzatTimings || [], hazzatLineTimings: h.hazzatLineTimings || [],
        recordingUrl: audioFor(h), englishRecordingUrl: audioFor(h, "english"), copticRecordingUrl: audioFor(h, "coptic"), notationHtml: h.notationHtml || "", notationKey: h.notationKey || "",
        textContent: h.textOverride || "", copticText: h.copticTextOverride || ""
      })
    });
    const data = await readProjectResponse(response);
    if (!response.ok) throw new Error(data.error || "Could not save the project.");
    if ((h.editVersion || 0) === version) applyProject(h, data.project);
    else {
      h.dirty = true;
      if (!autosaveTimer) autosaveTimer = setTimeout(() => { autosaveTimer = null; void saveDraft(h); }, 1000);
    }
    return true;
  })();
  savePromise = task;
  try {
    return await task;
  } catch (error) {
    if (h.id === selectedId) $("projectState").textContent = error.message || "Could not save. Try again.";
    return false;
  } finally { if (savePromise === task) savePromise = null; }
}
function completeMap(values, count) {
  return count > 0 && Array.from({ length: count }, (_, i) => values?.[i]).every(Number.isFinite);
}
async function completeProject() {
  const h = current();
  if (!canEdit || !h) return;
  const hasTiming = values => Array.isArray(values) && values.some(Number.isFinite);
  const ready = (audioFor(h) && (hasTiming(h.hazzatTimings) || hasTiming(h.hazzatLineTimings))) ||
    (audioFor(h, "english") && hasTiming(h.timings)) || (audioFor(h, "coptic") && hasTiming(h.copticTimings));
  if (!ready) { $("projectState").textContent = "Choose a recording and time at least one part in that section before completing. Other passages may stay untimed."; return; }
  if (!await saveDraft()) return;
  try {
    const response = await fetch("/api/project/complete?hymnId=" + encodeURIComponent(h.id), { method: "POST" });
    const data = await readProjectResponse(response);
    if (!response.ok) throw new Error(data.error || "Could not complete the project.");
    applyProject(h, data.project);
  } catch (error) { $("projectState").textContent = error.message || "Could not complete the project."; }
}

async function uploadProjectFile(kind, file, section = "hazzat") {
  const h = current();
  if (!canEdit || !h || !file) return;
  if (kind === "audio" && file.size > 100_000_000) { $("projectState").textContent = "Recording exceeds 100 MB."; return; }
  if (kind === "hazzat" && file.size > 1_000_000) { $("projectState").textContent = "Hazzat file exceeds 1 MB."; return; }
  clearTimeout(autosaveTimer); autosaveTimer = null;
  if (!await saveDraft(h)) return;
  aligning = false; renderReader();
  const editorControls = [...document.querySelectorAll(".timing-panel input, .timing-panel textarea, .timing-panel select, .timing-panel button")];
  editorControls.forEach(control => { control.dataset.uploadDisabled = String(control.disabled); control.disabled = true; });
  $("projectState").textContent = "Uploading " + (kind === "audio" ? "recording" : "Hazzat") + "…";
  try {
    const response = await fetch("/api/upload/" + kind + "?hymnId=" + encodeURIComponent(h.id) + "&section=" + encodeURIComponent(section), {
      method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file
    });
    const data = await readProjectResponse(response);
    if (!response.ok) throw new Error(data.error || "Upload failed.");
    applyProject(h, data.project);
    void globalThis.AlignmentReview?.load(h);
  } catch (error) { $("projectState").textContent = error.message || "Upload failed. Try again."; }
  finally { editorControls.forEach(control => { control.disabled = control.dataset.uploadDisabled === "true"; delete control.dataset.uploadDisabled; }); }
}
let pdfJsPromise = null;
async function pdfJs() {
  if (!pdfJsPromise) pdfJsPromise = import("./pdf.min.mjs").then(module => {
    module.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", document.baseURI).href;
    return module;
  });
  return pdfJsPromise;
}
function canvasBlob(canvas, type = "image/jpeg", quality = 0.9) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The score page could not be prepared.")), type, quality));
}
function detectScoreLines(canvas) {
  const { width, height } = canvas;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, width, height).data;
  const stride = Math.max(1, Math.floor(width / 1200));
  const sampleWidth = Math.ceil(width / stride);
  const rowInk = new Uint16Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x += stride) {
      const p = (y * width + x) * 4;
      if ((pixels[p] * 3 + pixels[p + 1] * 6 + pixels[p + 2]) / 10 < 190) count++;
    }
    rowInk[y] = count;
  }
  const threshold = Math.max(2, Math.ceil(sampleWidth * 0.0015));
  const active = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0, count = 0;
    for (let at = Math.max(0, y - 2); at <= Math.min(height - 1, y + 2); at++) { sum += rowInk[at]; count++; }
    active[y] = sum / count >= threshold ? 1 : 0;
  }
  const groups = [];
  let start = -1, last = -1;
  const mergeGap = Math.max(8, Math.round(height * 0.012));
  for (let y = 0; y < height; y++) {
    if (active[y]) { if (start < 0) start = y; last = y; }
    else if (start >= 0 && y - last > mergeGap) {
      if (last - start >= Math.max(2, height * 0.002)) groups.push([start, last + 1]);
      start = -1;
    }
  }
  if (start >= 0 && last - start >= Math.max(2, height * 0.002)) groups.push([start, last + 1]);
  if (groups.length < 2 || groups.length > 80) return Array.from({ length: 6 }, (_, index) => ({ top: index / 6 + 0.005, height: 1 / 6 - 0.01 }));
  return groups.map(([top, bottom]) => {
    const pad = Math.max(0.006, Math.min(0.02, (bottom - top) / height * 0.22));
    const normalizedTop = Math.max(0, top / height - pad);
    const normalizedBottom = Math.min(1, bottom / height + pad);
    return { top: normalizedTop, height: normalizedBottom - normalizedTop };
  });
}
function pageFromCanvas(canvas) {
  return canvasBlob(canvas).then(blob => {
    const page = { blob, lines: detectScoreLines(canvas), previewUrl: URL.createObjectURL(blob) };
    return page;
  });
}
function imageToCanvas(file) {
  const bitmapPromise = typeof createImageBitmap === "function" ? createImageBitmap(file) : new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve({ width: image.naturalWidth, height: image.naturalHeight, image, close() {} }); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This image could not be opened.")); };
    image.src = url;
  });
  return bitmapPromise.then(bitmap => {
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap.image || bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas;
  });
}
async function pdfToPages(file) {
  const pdf = await pdfJs();
  const documentRef = await pdf.getDocument({ data: await file.arrayBuffer() }).promise;
  if (documentRef.numPages > 30) throw new Error("This PDF has more than 30 pages. Split it into smaller uploads.");
  const pages = [];
  for (let index = 1; index <= documentRef.numPages; index++) {
    const page = await documentRef.getPage(index);
    const original = page.getViewport({ scale: 1 });
    const scale = Math.min(1.7, 2400 / Math.max(original.width, original.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    pages.push(await pageFromCanvas(canvas));
    page.cleanup();
  }
  await documentRef.destroy();
  return pages;
}
function renderHazzatImportPreview() {
  const preview = $("hazzatImportPreview");
  preview.replaceChildren();
  hazzatImportPages.forEach((page, pageIndex) => {
    const card = document.createElement("section");
    card.className = "hazzat-import-page";
    const heading = document.createElement("strong");
    heading.textContent = "Page " + (pageIndex + 1) + " · " + page.lines.length + " detected stacks";
    const imageBox = document.createElement("div");
    imageBox.className = "hazzat-import-image";
    const image = document.createElement("img");
    image.src = page.previewUrl;
    image.alt = "Score page preview " + (pageIndex + 1);
    imageBox.append(image);
    page.lines.forEach((line, lineIndex) => {
      const row = document.createElement("span");
      row.className = "hazzat-import-line";
      row.style.top = (line.top * 100) + "%";
      row.style.height = (line.height * 100) + "%";
      row.textContent = String(lineIndex + 1);
      imageBox.append(row);
    });
    const controls = document.createElement("div");
    controls.className = "hazzat-import-page-controls";
    const label = document.createElement("label");
    label.textContent = "If detection missed the lines, divide evenly into";
    const count = document.createElement("input");
    count.type = "number"; count.min = "1"; count.max = "80"; count.value = String(page.lines.length);
    count.setAttribute("aria-label", "Number of Hazzat stacks on page " + (pageIndex + 1));
    label.append(" ", count, " stacks");
    const divide = document.createElement("button");
    divide.type = "button"; divide.className = "button button-outline"; divide.textContent = "Divide evenly";
    divide.addEventListener("click", () => {
      const amount = Math.max(1, Math.min(80, Number(count.value) || 1));
      page.lines = Array.from({ length: amount }, (_, index) => ({ top: index / amount + 0.004, height: 1 / amount - 0.008 }));
      renderHazzatImportPreview();
    });
    controls.append(label, divide);
    card.append(heading, imageBox, controls);
    preview.append(card);
  });
}
function clearHazzatImport() {
  for (const page of hazzatImportPages) URL.revokeObjectURL(page.previewUrl);
  hazzatImportPages = [];
  $("hazzatImport").hidden = true;
  $("hazzatImportPreview").replaceChildren();
  $("hazzatScoreUpload").value = "";
  $("saveHazzatScore").disabled = true;
}
async function prepareHazzatImport(file) {
  if (!file || !canEdit) return;
  clearHazzatImport();
  $("hazzatImport").hidden = false;
  $("hazzatImportStatus").textContent = "Reading the score and finding its lines…";
  try {
    if (file.size > 50_000_000) throw new Error("Choose a score smaller than 50 MB.");
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) hazzatImportPages = await pdfToPages(file);
    else {
      if (!/^image\/(jpeg|png|webp)$/u.test(file.type)) throw new Error("Choose a PDF, JPG, PNG, or WebP score.");
      const canvas = await imageToCanvas(file);
      hazzatImportPages = [await pageFromCanvas(canvas)];
    }
    if (!hazzatImportPages.length) throw new Error("No score pages were found.");
    renderHazzatImportPreview();
    $("hazzatImportStatus").textContent = "Preview the detected stacks. Each shaded row becomes clickable and can be timed separately.";
    $("saveHazzatScore").disabled = false;
  } catch (error) {
    $("hazzatImportStatus").textContent = error.message || "Could not read this score file.";
    $("saveHazzatScore").disabled = true;
  }
}
async function saveHazzatImport() {
  const h = current();
  if (!canEdit || !h || !hazzatImportPages.length) return;
  if (!await saveDraft(h)) return;
  if (hazzatImportPages.some(page => page.blob.size > 8_000_000) || hazzatImportPages.reduce((sum, page) => sum + page.blob.size, 0) > 35_000_000) {
    $("projectState").textContent = "The prepared pages are too large. Upload fewer pages or divide the PDF into smaller files.";
    $("saveHazzatScore").disabled = false;
    return;
  }
  const form = new FormData();
  form.append("pages", JSON.stringify(hazzatImportPages.map(page => ({ lines: page.lines }))));
  hazzatImportPages.forEach((page, index) => form.append("page" + index, page.blob, "hazzat-page-" + (index + 1) + ".jpg"));
  $("saveHazzatScore").disabled = true;
  $("projectState").textContent = "Saving interactive Hazzat pages online…";
  try {
    const response = await fetch("/api/upload/hazzat-score?hymnId=" + encodeURIComponent(h.id), { method: "POST", body: form });
    const data = await readProjectResponse(response);
    if (!response.ok) throw new Error(data.error || "Could not save the score.");
    applyProject(h, data.project);
    clearHazzatImport();
    $("projectState").textContent = "Hazzat pages saved online. Each stack is ready to time.";
  } catch (error) {
    $("projectState").textContent = error.message || "Could not save the score.";
    $("saveHazzatScore").disabled = false;
  }
}
async function saveRecordingClip(kind, clear = false) {
  const h = current();
  if (!canEdit || !h) return;
  const body = { section: kind, action: clear ? "clear" : "save" };
  if (!clear) {
    const suffix = kind[0].toUpperCase() + kind.slice(1), player = players[kind];
    const start = parseClipTime($("clipStart" + suffix).value);
    const endInput = $("clipEnd" + suffix).value.trim();
    const end = endInput ? parseClipTime(endInput) : player.duration;
    if (!Number.isFinite(player.duration) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > player.duration || end - start < 0.5) {
      $("projectState").textContent = "Enter a start and end within this recording (for example, 1:12 to 2:35).";
      return;
    }
    body.start = start;
    body.end = end;
  }
  if (!await saveDraft(h)) return;
  try {
    const response = await fetch("/api/recording-clip?hymnId=" + encodeURIComponent(h.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save this recording part.");
    applyProject(h, data.project);
    const range = recordingRange(h, kind);
    if (Number.isFinite(playerDuration(kind))) players[kind].currentTime = range.start;
    $("projectState").textContent = clear ? "Using the full recording" : "Using selected recording part · " + stamp(range.end - range.start);
  } catch (error) { $("projectState").textContent = error.message || "Could not save this recording part."; }
}
function playerDuration(kind) { return players[kind].duration; }
function renderProjects() {
  const list = $("projectList");
  list.replaceChildren();
  const query = $("projectSearch").value.trim().toLocaleLowerCase();
  const matches = allProjects.filter(p => (p.title + " " + p.season + " " + p.service).toLocaleLowerCase().includes(query));
  for (const project of matches) {
    const card = document.createElement("a");
    card.className = "hymn-card";
    card.href = "#/hymn/" + project.hymn_id;
    const title = document.createElement("strong");
    title.textContent = project.title;
    const detail = document.createElement("span");
    detail.textContent = (seasonIndex.find(s => s.id === project.season)?.name || project.season) + " · " + (project.status === "complete" ? "Complete" : "Draft");
    card.append(title, detail);
    list.append(card);
  }
  if (!matches.length) list.textContent = query ? "No projects match your search." : "No saved projects yet. Open a hymn and save its alignment to start one.";
}
async function loadProjects() {
  $("projectList").textContent = "Loading projects…";
  try {
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error();
    allProjects = (await response.json()).projects || [];
    renderProjects();
  } catch { $("projectList").textContent = "Could not load projects. Try again."; }
}
async function copyTiming() {
  const h = current();
  if (!h) return;
  const data = {
    format: "mobile-maallim-timing", version: 3, id: h.id, title: h.name, season: h.season,
    repeatSections: h.repeatSections || [], words: hymnText(h), coptic: hymnCopticText(h), timings: h.timings || [], copticTimings: h.copticTimings || [], hazzatTimings: h.hazzatTimings || [], hazzatLineTimings: h.hazzatLineTimings || [],
    recording: audioFor(h), englishRecording: audioFor(h, "english"), copticRecording: audioFor(h, "coptic")
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(data));
    setHelp("Timing copied. Paste it into our chat so I can publish this hymn’s alignment.");
  } catch { setHelp("Copy was blocked by this browser. Please allow clipboard access and try again."); }
}
async function start() {
  try {
    const routePath = decodeURIComponent(location.hash.slice(2));
    const requestedSeason = routePath.startsWith("hymn/") ? routePath.split("/")[1] : routePath.startsWith("season/") ? routePath.slice(7) : "";
    if (/^[a-z0-9-]+$/u.test(requestedSeason)) void loadSeasonAsset(requestedSeason).catch(() => {});
    const [indexResponse, matchesResponse, recordingsResponse, libraryResponse, sessionResponse, projectsResponse] = await Promise.all([
      fetch("./catalog/index.json"), fetch("./catalog/audio-matches.json"), fetch("./catalog/recordings-by-season.json"), fetch("/api/library").catch(() => null), fetch("/api/session").catch(() => null), fetch("/api/projects").catch(() => null)
    ]);
    if (!indexResponse.ok || !matchesResponse.ok || !recordingsResponse.ok) throw new Error();
    seasonIndex = await indexResponse.json();
    audioMatches = await matchesResponse.json();
    recordingsBySeason = await recordingsResponse.json();
    if (libraryResponse?.ok) {
      const libraryData = await libraryResponse.json();
      customLibrary = libraryData;
      hymnLibraryState = libraryData.hymnState || {};
    }
    let sessionData = null;
    try { sessionData = sessionResponse?.ok ? await sessionResponse.json() : null; } catch {}
    canEdit = Boolean(sessionData?.canEdit) || Boolean(projectsResponse?.ok);
    $("projectsLink").hidden = !canEdit;
    $("libraryTools").hidden = !canEdit;
    $("timingBtn").hidden = !canEdit;
    renderSeasons();
    await route();
    void fetch("/api/completed").then(response => response.ok ? response.json() : null).then(data => {
      if (!data) return;
      completedProjects = new Set(data.hymnIds || []);
      if (!$("seasonsView").hidden) renderSeasons();
      else if (!$("hymnsView").hidden && !editingLibrary) renderLibrary();
    }).catch(() => {});
  } catch { $("seasonNav").textContent = "The hymn library could not load."; }
}
function changeReaderScale(amount) {
  readerScale = Math.max(0.75, Math.min(2, Math.round((readerScale + amount) * 8) / 8));
  $("readerContent").style.setProperty("--reader-scale", String(readerScale));
  $("sizeValue").textContent = Math.round(readerScale * 100) + "%";
  $("decreaseSize").disabled = readerScale <= 0.75;
  $("increaseSize").disabled = readerScale >= 2;
}
window.addEventListener("hashchange", route);
$("seasonSearch").addEventListener("input", renderSeasons);
$("search").addEventListener("input", renderLibrary);
$("projectSearch").addEventListener("input", renderProjects);
$("decreaseSize").addEventListener("click", () => changeReaderScale(-0.125));
$("increaseSize").addEventListener("click", () => changeReaderScale(0.125));
$("timingBtn").addEventListener("click", () => {
  workspace.classList.toggle("editing");
  if (workspace.classList.contains("editing")) globalThis.AlignmentReview?.syncChannel();
  $("timingBtn").textContent = workspace.classList.contains("editing") ? "Close editor" : "Edit hymn";
  if (!workspace.classList.contains("editing")) { stopRepeatAlignment(); hidePlayer(); }
  renderReader();
});
$("wordsTab").addEventListener("click", () => { if (view !== "words") { if (repeatPass || repeatAlignment || repeatAlignmentLoop) stopRepeatAlignment(); hidePlayer(); globalThis.AlignmentReview?.stopPreview(); } view = "words"; renderReader(); });
$("hazzatTab").addEventListener("click", () => { if (view !== "hazzat") { if (repeatPass || repeatAlignment || repeatAlignmentLoop) stopRepeatAlignment(); hidePlayer(); globalThis.AlignmentReview?.stopPreview(); } view = "hazzat"; renderReader(); });
for (const language of ["coptic", "english"]) $(language + "LanguageBtn").addEventListener("click", () => {
  if (textLanguage !== language) { if (repeatPass || repeatAlignment || repeatAlignmentLoop) stopRepeatAlignment(); hidePlayer(); globalThis.AlignmentReview?.stopPreview(); }
  textLanguage = language;
  renderReader();
});
for (const kind of Object.keys(players)) {
  const suffix = kind[0].toUpperCase() + kind.slice(1);
  $("setClipStart" + suffix).addEventListener("click", () => {
    if (Number.isFinite(players[kind].currentTime)) $("clipStart" + suffix).value = clipTimeText(players[kind].currentTime);
  });
  $("setClipEnd" + suffix).addEventListener("click", () => {
    if (Number.isFinite(players[kind].currentTime)) $("clipEnd" + suffix).value = clipTimeText(players[kind].currentTime);
  });
  $("saveClip" + suffix).addEventListener("click", () => void saveRecordingClip(kind));
  $("clearClip" + suffix).addEventListener("click", () => void saveRecordingClip(kind, true));
}
document.addEventListener("keydown", event => {
  if (!aligning && !reportingError && event.key === " ") {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || $("readerView").hidden) return;
    if (event.target instanceof Element) {
      if (event.target.closest("input, textarea, select, a, audio, video, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='dialog'], dialog")) return;
      const button = event.target.closest("button, [role='button']");
      if (button && !button.matches(".word, .word-row, .hazza-mark, .hazzat-stack, .play-button")) return;
    }
    const kind = Object.keys(players).find(name => !players[name].paused) || activePlaybackKind;
    if (!kind || !players[kind].getAttribute("src")) return;
    event.preventDefault();
    // Handle Space before a focused hymn part can replay its start time.
    event.stopImmediatePropagation();
    if (!event.repeat) {
      const player = players[kind];
      if (player.paused) player.play().catch(() => setHelp("Playback could not resume.", kind));
      else player.pause();
    }
    return;
  }
}, true);
document.addEventListener("keydown", event => {
  const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
  if (!aligning || (event.key !== " " && !direction) || event.altKey || event.ctrlKey || event.metaKey || $("readerView").hidden) return;
  const target = event.target;
  if (target instanceof Element) {
    if (target.closest("textarea, select, a, [contenteditable='true'], input:not([type='range'])")) return;
    const button = target.closest("button");
    if (event.key === " " && button && !button.matches("#alignBtn, .word, .hazza-mark, .hazzat-image-stack, .play-button")) return;
  }
  event.preventDefault();
  const h = current();
  if (!h || view === "recording") return;
  if (!alignmentKey || alignmentScope !== (view === "words" ? textLanguage : "hazzat")) refreshAlignmentTarget();
  const key = alignmentKey;
  const count = alignmentCount(h, key);
  const kind = key === "timings" ? "english" : key === "copticTimings" ? "coptic" : "hazzat";
  const player = players[kind];
  if (direction) {
    if (!count) { setHelp("Add parts to this section before aligning.", kind); return; }
    const low = alignmentBounds?.key === key ? alignmentBounds.start : 0;
    const high = alignmentBounds?.key === key ? alignmentBounds.end : count - 1;
    alignmentCursor = Math.max(low, Math.min(high, alignmentCursor + direction));
    updateStatus();
    refreshAlignmentTarget();
    focusAlignmentTarget();
    setHelp("Use ← and → to choose a part. Press Space while the recording plays to mark it.", kind);
    return;
  }
  if (event.repeat) return;
  if (!count) { setHelp("Add clickable parts to this section before aligning.", kind); return; }
  if (alignmentBounds?.key === key && (alignmentCursor < alignmentBounds.start || alignmentCursor > alignmentBounds.end)) { setHelp("This repeat alignment is limited to the selected part of the hymn.", kind); return; }
  if (alignmentCursor >= count) { setHelp("All parts in this section are marked. Choose another section or tap a part to revise it.", kind); return; }
  if (!player.src || player.paused) { setHelp("Play this section’s recording, then press Space as the selected part begins.", kind); return; }
  const marked = alignmentCursor;
  h[key] ||= [];
  markTiming(h, key, marked, player.currentTime);
  alignmentCursor++;
  markUnsaved();
  renderReader();
  focusAlignmentTarget();
  setHelp("Marked part " + (marked + 1) + " of " + count + ". Use arrows to move, or press Space for the next part.", kind);
});
$("textInput").addEventListener("input", event => {
  const h = current();
  if (!h || !canEdit) return;
  globalThis.AlignmentReview?.stopPreview();
  h.textOverride = event.target.value;
  h.timings = [];
  h.repeatSections = (h.repeatSections || []).filter(s => s.key !== "timings");
  resetRepeat();
  markUnsaved();
  renderReader();
});
$("copticInput").addEventListener("input", event => {
  const h = current();
  if (!h || !canEdit) return;
  globalThis.AlignmentReview?.stopPreview();
  h.copticTextOverride = event.target.value;
  h.copticTimings = [];
  h.repeatSections = (h.repeatSections || []).filter(s => s.key !== "copticTimings");
  resetRepeat();
  markUnsaved();
  renderReader();
});
$("copticUpload").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file || !canEdit) return;
  if (file.size > 100_000) { $("projectState").textContent = "Coptic text file exceeds 100 KB."; event.target.value = ""; return; }
  $("copticInput").value = await file.text();
  $("copticInput").dispatchEvent(new Event("input", { bubbles: true }));
  event.target.value = "";
});
$("notationInput").addEventListener("input", event => {
  const h = current();
  if (!h || !canEdit) return;
  globalThis.AlignmentReview?.stopPreview();
  h.notationHtml = notationFromEditor(event.target.value);
  h.notationKey = "";
  h.hazzatPages = [];
  h.hazzatTimings = [];
  h.hazzatLineTimings = [];
  h.repeatSections = (h.repeatSections || []).filter(s => !s.key.startsWith("hazzat"));
  resetRepeat();
  markUnsaved();
  renderReader();
});
for (const kind of Object.keys(players)) {
  playerElement(kind, "RecordingPicker").addEventListener("change", event => {
    const h = current();
    if (!h) return;
    globalThis.AlignmentReview?.stopPreview();
    const previousUrl = audioFor(h, kind), hadClip = Boolean(h.recordingClips?.[kind]);
    const chosenUrl = event.target.value;
    const track = (recordingsBySeason[h.season] || []).find(item => item.url === chosenUrl);
    if (kind === "hazzat") {
      if (track) chosenAudio.set(h.id, track);
      else chosenAudio.delete(h.id);
      h.recordingUrl = chosenUrl;
    } else h[kind + "RecordingUrl"] = chosenUrl;
    if (previousUrl !== chosenUrl && hadClip) {
      h.recordingClips = { ...(h.recordingClips || {}) };
      delete h.recordingClips[kind];
    }
    setPlayerSource(h, kind);
    markUnsaved();
    renderReader();
    if (previousUrl !== chosenUrl && hadClip) void (async () => {
      if (!await saveDraft(h)) return;
      const response = await fetch("/api/recording-clip?hymnId=" + encodeURIComponent(h.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear", section: kind }) });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.project) applyProject(h, data.project);
    })();
  });
  playerElement(kind, "AudioUpload").addEventListener("change", async event => {
    await uploadProjectFile("audio", event.target.files?.[0], kind);
    event.target.value = "";
  });
}
$("hazzatUpload").addEventListener("change", async event => {
  await uploadProjectFile("hazzat", event.target.files?.[0]);
  event.target.value = "";
});
$("hazzatScoreUpload").addEventListener("change", event => { void prepareHazzatImport(event.target.files?.[0]); });
$("saveHazzatScore").addEventListener("click", () => void saveHazzatImport());
$("cancelHazzatScore").addEventListener("click", clearHazzatImport);
$("saveDraftBtn").addEventListener("click", () => saveDraft());
$("completeBtn").addEventListener("click", completeProject);
$("repeatAlignmentBtn").addEventListener("click", () => {
  if (repeatAlignment?.hymnId === current()?.id && !repeatAlignmentLoop) {
    repeatAlignment = null;
    $("repeatAlignmentHelp").textContent = "Repeat alignment selection canceled. No timings were changed.";
    updateRepeatAlignmentControl();
    return;
  }
  const kind = view === "hazzat" ? "hazzat" : textLanguage;
  const key = view === "hazzat" ? "hazzatLineTimings" : textLanguage === "coptic" ? "copticTimings" : "timings";
  if (repeatAlignmentLoop?.hymnId === current()?.id) {
    stopRepeatAlignment();
    $("repeatAlignmentHelp").textContent = "Repeat alignment stopped. No other parts of the hymn were changed.";
    renderReader();
    return;
  }
  if (!current() || !players[kind].src) { setHelp("Add a recording to this section before repeating alignment.", kind); return; }
  resetRepeat();
  aligning = false;
  pausePlayers();
  if (players[kind].readyState === 0) players[kind].load();
  repeatAlignmentLoop = null;
  alignmentBounds = null;
  repeatAlignment = { hymnId: current().id, kind, key, stage: "start" };
  showPlayer(kind);
  updateRepeatAlignmentControl();
  $("repeatAlignmentHelp").textContent = "Tap the first word, Hazzat passage, or stack to redo (timed or untimed), then tap the last part to include. Only timings inside that range will be cleared.";
  setHelp("Choose the first aligned part you want to redo.", kind);
});
$("alignBtn").addEventListener("click", () => {
  const kind = view === "hazzat" ? "hazzat" : textLanguage;
  if (repeatPass) { repeatPass = null; alignmentBounds = null; aligning = false; renderReader(); return; }
  if (repeatAlignmentLoop || repeatAlignment) { stopRepeatAlignment(); renderReader(); return; }
  aligning = !aligning;
  alignmentScope = null;
  alignmentKey = null;
  alignmentCursor = 0;
  lastAlignmentTarget = "";
  clipEnd = null;
  renderReader();
  if (aligning) focusAlignmentTarget();
  setHelp(aligning ? players[kind].src ? "Use arrows to choose a part. Play the recording and press Space to mark its time." : "Use arrows to choose a part. Add this section’s recording before marking times." : "Timings captured. Tap a timed part to check it.", kind);
});
$("clearTimesBtn").addEventListener("click", () => {
  const h = current();
  if (!h || !confirm("Clear this hymn’s timings?")) return;
  h.repeatSections = [];
  h.timings = [];
  h.copticTimings = [];
  h.hazzatTimings = [];
  h.hazzatLineTimings = [];
  h.repeatSections = (h.repeatSections || []).filter(s => !s.key.startsWith("hazzat"));
  resetRepeat();
  markUnsaved();
  renderReader();
});
$("exportBtn").addEventListener("click", copyTiming);
for (const [kind, player] of Object.entries(players)) {
  playerElement(kind, "RepeatBtn").addEventListener("click", () => {
    if (!current() || !player.src) { setHelp("Add a recording to this section before setting a repeat.", kind); return; }
    if (repeatSelection?.kind === kind || repeatLoop?.kind === kind) {
      repeatSelection = null;
      repeatLoop = null;
      repeatHymnId = null;
      updateRepeatControl(kind);
      highlightRepeatRange();
      setHelp("Repeat cleared. Tap a part to play from there.", kind);
      return;
    }
    aligning = false;
    if (player.readyState === 0) player.load();
    repeatSelection = { kind, stage: "start" };
    repeatLoop = null;
    repeatHymnId = current().id;
    updateRepeatControl(kind);
    setHelp("Tap a timed word or Hazzat part to choose where the repeat begins.", kind);
  });
  playerElement(kind, "PlayBtn").addEventListener("click", () => {
    if (!player.src) { setHelp("No recording is attached to this section yet.", kind); return; }
    clipEnd = null;
    const range = recordingRange(current(), kind);
    const loop = playbackLoop(kind);
    if (player.paused) {
      let target = player.currentTime;
      if (loop && (target < loop.start || target >= loop.end)) target = loop.start;
      else if (player.readyState === 0 || target < range.start || target >= range.end) target = loop?.start ?? range.start;
      playAtTime(kind, target);
    }
    else player.pause();
  });
  player.addEventListener("play", () => {
    for (const other of Object.values(players)) if (other !== player) other.pause();
    const range = recordingRange(current(), kind);
    const loop = playbackLoop(kind);
    if (loop && (player.currentTime < loop.start || player.currentTime >= loop.end)) player.currentTime = loop.start;
    else if (player.currentTime < range.start || player.currentTime >= range.end) player.currentTime = range.start;
    activePlaybackKind = kind;
    playerElement(kind, "PlayBtn").textContent = "Ⅱ";
    updateKaraoke();
  });
  player.addEventListener("pause", () => { playerElement(kind, "PlayBtn").textContent = "▶"; updateKaraoke(); });
  player.addEventListener("loadedmetadata", () => {
    const range = recordingRange(current(), kind);
    playerElement(kind, "Duration").textContent = stamp(range.end - range.start);
    if (current()?.recordingClips?.[kind]) player.currentTime = range.start;
    renderClipControls(current());
  });
  player.addEventListener("timeupdate", () => {
    const range = recordingRange(current(), kind);
    const loop = playbackLoop(kind);
    if (loop && !player.paused && player.currentTime >= loop.end - 0.04) {
      player.currentTime = loop.start;
      if (repeatAlignmentLoop === loop) { alignmentCursor = alignmentBounds.start; updateStatus(); refreshAlignmentTarget(); }
    }
    playerElement(kind, "CurrentTime").textContent = stamp(Math.max(0, player.currentTime - range.start));
    playerElement(kind, "Duration").textContent = stamp(range.end - range.start);
    playerElement(kind, "Seek").value = range.end > range.start ? String(Math.round((player.currentTime - range.start) / (range.end - range.start) * 1000)) : "0";
    syncSeekProgress(playerElement(kind, "Seek"));
    if (!loop && !player.paused && player.currentTime >= range.end) { player.currentTime = range.end; player.pause(); }
    if (activePlaybackKind === kind) updateKaraoke();
  });
  playerElement(kind, "Seek").addEventListener("input", event => {
    syncSeekProgress(event.target);
    if (!Number.isFinite(player.duration)) { if (player.src) player.load(); return; }
    const range = recordingRange(current(), kind);
    player.currentTime = range.start + Number(event.target.value) / 1000 * (range.end - range.start);
    if (activePlaybackKind === kind) updateKaraoke();
  });
  player.addEventListener("seeked", updateKaraoke);
  player.addEventListener("ended", () => { const loop = playbackLoop(kind); if (loop) { if (repeatAlignmentLoop === loop) alignmentCursor = alignmentBounds.start; playAtTime(kind, loop.start); return; } if (activePlaybackKind === kind) activePlaybackKind = null; updateKaraoke(); });
  playerElement(kind, "Speed").addEventListener("change", event => { player.playbackRate = Number(event.target.value); });
}

let libraryDialogMode = "";
function closeLibraryDialog() {
  $("libraryDialog").hidden = true;
  $("libraryForm").reset();
  libraryDialogMode = "";
}
function refreshLibrarySeasonOptions() {
  const select = $("librarySeasonSelect");
  const currentValue = select.value;
  select.replaceChildren(new Option("Choose a season", ""));
  allSeasons().forEach(season => select.add(new Option(season.name, season.id)));
  if (currentValue && [...select.options].some(option => option.value === currentValue)) select.value = currentValue;
}
async function refreshLibraryCategoryOptions() {
  const select = $("libraryCategorySelect");
  const seasonId = $("librarySeasonSelect").value;
  select.replaceChildren(new Option("Choose a category", ""));
  if (!seasonId) return;
  const categories = [...customCategoriesForSeason(seasonId)];
  let services = seasonCache.get(seasonId) || [];
  if (!services.length && seasonIndex.some(season => season.id === seasonId)) {
    try {
      const response = await fetch("./catalog/" + seasonId + ".json");
      if (response.ok) services = await response.json();
    } catch {}
  }
  const seen = new Set();
  [...services.map(service => ({ id: service.id, name: service.name })), ...categories].forEach(category => {
    if (seen.has(category.id)) return;
    seen.add(category.id);
    select.add(new Option(category.name, category.id));
  });
}
function openLibraryDialog(mode) {
  if (!canEdit) return;
  libraryDialogMode = mode;
  $("libraryDialogTitle").textContent = mode === "season" ? "Add a season" : mode === "category" ? "Add a category" : "Add a hymn";
  $("librarySeasonField").hidden = mode === "season";
  $("libraryCategoryField").hidden = mode !== "hymn";
  $("libraryEnglishField").hidden = mode !== "hymn";
  $("libraryCopticField").hidden = mode !== "hymn";
  $("libraryHazzatField").hidden = mode !== "hymn";
  $("libraryFormNote").textContent = mode === "hymn" ? "You can add recordings and finish the alignment from the hymn editor after it is created." : "This stays private while you build it. Save and complete a hymn to make it available to listeners.";
  refreshLibrarySeasonOptions();
  if (mode === "category" || mode === "hymn") {
    $("librarySeasonSelect").value = selectedSeason || "";
    void refreshLibraryCategoryOptions();
  }
  $("libraryDialog").hidden = false;
  $("libraryName").focus();
}
async function createLibraryItem(event) {
  event.preventDefault();
  if (!canEdit || !libraryDialogMode) return;
  const mode = libraryDialogMode;
  const name = $("libraryName").value.trim();
  const seasonId = $("librarySeasonSelect").value;
  const categoryId = $("libraryCategorySelect").value;
  if (!name || ((libraryDialogMode !== "season") && !seasonId) || (libraryDialogMode === "hymn" && !categoryId)) return;
  const body = { name };
  if (libraryDialogMode !== "season") body.seasonId = seasonId;
  if (libraryDialogMode === "hymn") {
    body.categoryId = categoryId;
    body.textContent = $("libraryEnglishText").value;
    body.copticText = $("libraryCopticText").value;
    body.notationHtml = notationFromEditor($("libraryHazzatText").value);
  }
  const button = $("libraryForm").querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const response = await fetch("/api/library/" + libraryDialogMode, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not add this item.");
    if (mode === "season") customLibrary.seasons.push({ ...data.node, id: data.node.id, name: data.node.name });
    if (mode === "category") { customLibrary.categories.push({ ...data.node, id: data.node.id, season: data.node.season, name: data.node.name }); seasonCache.delete(data.node.season); }
    if (mode === "hymn") {
      customLibrary.hymns.push({ id: data.node.id, name: data.node.name, season: data.node.season, category: data.node.category, custom: true, project: data.project });
      seasonCache.delete(data.node.season);
    }
    renderSeasons();
    closeLibraryDialog();
    if (mode === "hymn") { selectedSeason = seasonId; location.hash = "#/hymn/" + data.node.id; }
  } catch (error) {
    $("libraryFormNote").textContent = error.message || "Could not add this item. Try again.";
  } finally { button.disabled = false; }
}
$("addSeasonBtn").addEventListener("click", () => openLibraryDialog("season"));
$("addCategoryBtn").addEventListener("click", () => openLibraryDialog("category"));
$("addHymnBtn").addEventListener("click", () => openLibraryDialog("hymn"));
$("librarySeasonSelect").addEventListener("change", () => void refreshLibraryCategoryOptions());
$("libraryDialogClose").addEventListener("click", closeLibraryDialog);
$("libraryDialogCancel").addEventListener("click", closeLibraryDialog);
$("libraryForm").addEventListener("submit", createLibraryItem);
start();
if (document.modelContext?.registerTool) {
  const register = tool => Promise.resolve(document.modelContext.registerTool(tool)).catch(() => {});
  register({
    name: "set_passage_timings",
    title: "Set passage timings",
    description: "Set English word, Coptic word, hazzat passage, or stack start times in seconds and save the selected hymn project.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["words", "coptic", "hazzat", "lines"] }, timings: { type: "array", items: { type: ["number", "null"] } } }, required: ["kind", "timings"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      const h = current();
      if (!canEdit || !h || !input || !["words", "coptic", "hazzat", "lines"].includes(input.kind) || !Array.isArray(input.timings) || input.timings.some(t => t !== null && (!Number.isFinite(t) || t < 0))) throw new Error("Select a hymn and provide nonnegative passage times as the editor.");
      const count = input.kind === "words" ? words(hymnText(h)).length : input.kind === "coptic" ? words(hymnCopticText(h)).length : input.kind === "hazzat" ? h.hazzatGroupCount || 0 : h.hazzatLineCount || 0;
      if (input.timings.length !== count) throw new Error("Provide one timing or null per passage.");
      h[input.kind === "words" ? "timings" : input.kind === "coptic" ? "copticTimings" : input.kind === "hazzat" ? "hazzatTimings" : "hazzatLineTimings"] = input.timings.map(t => t === null ? undefined : t);
      markUnsaved();
      renderReader();
      if (!await saveDraft()) throw new Error("Could not save the timing project.");
      return { title: h.name, kind: input.kind, timed: input.timings.filter(Number.isFinite).length };
    }
  });
}

function timingTarget(element) {
  const mark = element.closest('.hazza-mark, .word') || element.closest('.hazzat-stack');
  if (!mark) return null;
  const key = mark.matches('.hazza-mark') ? 'hazzatTimings' : mark.matches('.hazzat-stack') ? 'hazzatLineTimings' : textLanguage === 'coptic' ? 'copticTimings' : 'timings';
  return { key, index: Number(mark.dataset.position), kind: key === 'timings' ? 'english' : key === 'copticTimings' ? 'coptic' : 'hazzat' };
}
function consumeSelection(event) { event.preventDefault(); event.stopImmediatePropagation(); }
function selectListenPoint(element, event) {
  const target = timingTarget(element), h = current();
  if (!target || !repeatSelection || target.kind !== repeatSelection.kind || repeatHymnId !== h?.id) return false;
  consumeSelection(event);
  const time = h[target.key]?.[target.index];
  if (!Number.isFinite(time)) { setHelp('Choose a timed part.', target.kind); return true; }
  if (repeatSelection.stage === 'start') {
    repeatSelection = { ...target, startIndex: target.index, start: time, stage: 'end' };
    setHelp('Start selected. Tap the last part to include in the repeat.', target.kind);
  } else {
    if (target.key !== repeatSelection.key || target.index < repeatSelection.startIndex) { setHelp('Choose the same type of part at or after the start.', target.kind); return true; }
    const end = (h[target.key] || []).slice(target.index + 1).find(t => Number.isFinite(t) && t > time) ?? recordingRange(h, target.kind).end;
    if (!(end > repeatSelection.start)) { setHelp('Wait for the recording to load, then choose the end again.', target.kind); return true; }
    repeatLoop = { ...repeatSelection, endIndex: target.index, end };
    repeatSelection = null;
    setHelp('Selected section highlighted. Press Play to repeat it.', target.kind);
  }
  updateRepeatControl(target.kind); highlightRepeatRange(); return true;
}
function highlightRepeatRange() {
  const content = $('readerContent');
  content.querySelectorAll('.repeat-selected').forEach(e => e.classList.remove('repeat-selected'));
  const h = current();
  const range = repeatPass || (repeatAlignmentLoop?.hymnId === h?.id ? repeatAlignmentLoop : repeatAlignment?.hymnId === h?.id ? repeatAlignment : null) || (repeatHymnId === h?.id ? repeatLoop || repeatSelection : null) || sectionSelection;
  if (!range?.key || !Number.isInteger(range.startIndex)) return;
  const selector = range.key === 'hazzatTimings' ? '.hazza-mark' : range.key === 'hazzatLineTimings' ? '.hazzat-stack' : '.word';
  if (view === 'words' && range.key !== (textLanguage === 'coptic' ? 'copticTimings' : 'timings')) return;
  if ((view === 'hazzat') !== range.key.startsWith('hazzat')) return;
  content.querySelectorAll(selector).forEach(e => { const i = Number(e.dataset.position); if (i >= range.startIndex && i <= (range.endIndex ?? range.startIndex)) e.classList.add('repeat-selected'); });
}
function markTiming(h, key, index, time) {
  const value = Math.round(time * 100) / 100;
  if (repeatPass) h.repeatSections[repeatPass.section].passes[repeatPass.pass][index - repeatPass.startIndex] = value;
  else h[key][index] = value;
}
function playbackTimings(h, key, time) {
  let result = h[key] || [], latest = -Infinity, active = null;
  for (const section of h.repeatSections || []) {
    if (section.key !== key) continue;
    for (let pass = 0; pass < section.passes.length; pass++) {
      const values = section.passes[pass], start = values.find(Number.isFinite);
      if (Number.isFinite(start) && start <= time + .03 && start > latest) {
        // Stop this occurrence at the next normally timed part or the next repeat pass.
        const next = [...(h[key] || []).slice(section.endIndex + 1), ...section.passes.slice(pass + 1).flat()].filter(t => Number.isFinite(t) && t > start);
        const end = next.length ? Math.min(...next) : recordingRange(h, key.startsWith('hazzat') ? 'hazzat' : key === 'timings' ? 'english' : 'coptic').end;
        if (time >= end) continue;
        result = Array(section.endIndex + 1).fill(null);
        values.forEach((t, i) => { result[section.startIndex + i] = t; });
        latest = start; active = { section, pass };
      }
    }
  }
  const badge = $('repeatProgress');
  if (active) {
    badge.hidden = !workspace.classList.contains('editing'); badge.textContent = 'Sing ' + (active.section.passes.length + 1) + ' times · ' + (active.pass + 2) + ' of ' + (active.section.passes.length + 1);
    const selector = key === 'hazzatTimings' ? '.hazza-mark' : key === 'hazzatLineTimings' ? '.hazzat-stack' : '.word';
    const first = $('readerContent').querySelector(selector + '[data-position="' + active.section.startIndex + '"]');
    const token = key + ':' + latest;
    if (badge.dataset.pass !== token) { badge.dataset.pass = token; first?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  return result;
}
function selectSectionPoint(element, event) {
  if (!sectionSelection || !canEdit) return false;
  const target = timingTarget(element); if (!target) return false;
  consumeSelection(event);
  if (!sectionSelection.key) { sectionSelection = { ...target, startIndex: target.index }; $('sectionRepeatHelp').textContent = 'Tap the last part of the repeated section.'; highlightRepeatRange(); return true; }
  if (target.key !== sectionSelection.key || target.index < sectionSelection.startIndex) { $('sectionRepeatHelp').textContent = 'Choose an end at or after the start, using the same type of part.'; return true; }
  const h = current(); h.repeatSections ||= [];
  h.repeatSections.push({ key: target.key, startIndex: sectionSelection.startIndex, endIndex: target.index, passes: [Array(target.index - sectionSelection.startIndex + 1).fill(null)] });
  sectionSelection = null; markUnsaved(); renderReader(); $('sectionRepeatHelp').textContent = 'Sing twice saved. Align pass 2 at its actual place in the recording.'; return true;
}
function renderRepeatSections() {
  const h = current(), list = $('sectionRepeatList'), badge = $('repeatProgress'); list.replaceChildren(); badge.hidden = true;
  const key = view === 'hazzat' ? null : textLanguage === 'coptic' ? 'copticTimings' : 'timings';
  (h?.repeatSections || []).forEach((section, sectionIndex) => {
    if (view === 'hazzat' ? !section.key.startsWith('hazzat') : section.key !== key) return;
    const row = document.createElement('div'); row.className = 'section-repeat-row';
    const label = document.createElement('span'); label.textContent = 'Sing ' + (section.passes.length + 1) + ' times · parts ' + (section.startIndex + 1) + '–' + (section.endIndex + 1); row.append(label);
    const action = (text, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'button button-outline'; b.textContent = text; b.onclick = fn; row.append(b); };
    section.passes.forEach((values, pass) => action('Align pass ' + (pass + 2), () => {
      resetRepeat(); aligning = true; alignmentKey = section.key; alignmentScope = section.key.startsWith('hazzat') ? 'hazzat' : section.key === 'timings' ? 'english' : 'coptic';
      repeatPass = { ...section, section: sectionIndex, pass }; alignmentBounds = { key: section.key, start: section.startIndex, end: section.endIndex }; alignmentCursor = section.startIndex;
      renderReader(); focusAlignmentTarget(); $('sectionRepeatHelp').textContent = 'Seek to pass ' + (pass + 2) + ' in the recording, press Play, then mark these highlighted parts. Finish aligning when done.';
    }));
    action('Add pass', () => { if (section.passes.length >= 9) { $('sectionRepeatHelp').textContent = 'A section can be sung up to 10 times.'; return; } section.passes.push(Array(section.endIndex - section.startIndex + 1).fill(null)); markUnsaved(); renderReader(); });
    action('Remove repeat', () => { resetRepeat(); aligning = false; h.repeatSections.splice(sectionIndex, 1); markUnsaved(); renderReader(); }); list.append(row);
    if (badge.hidden && workspace.classList.contains('editing')) { badge.hidden = false; badge.textContent = 'Sing ' + (section.passes.length + 1) + ' times · 1 of ' + (section.passes.length + 1); }
  });
  highlightRepeatRange();
}
$('addSectionRepeat').addEventListener('click', () => {
  if (!canEdit || !current()) return;
  const cancel = Boolean(sectionSelection); resetRepeat(); aligning = false; sectionSelection = cancel ? null : {};
  $('sectionRepeatHelp').textContent = cancel ? 'Selection canceled.' : 'Tap the first part, then the last part of the section that is sung twice.';
  highlightRepeatRange();
});

// Reporting captures reader activation before playback or alignment handlers.
let reportingError = false;
const reportDialog = document.createElement("dialog");
reportDialog.className = "error-report-dialog";
reportDialog.innerHTML = `<form><h2>Report an error</h2><p id="reportPart"></p><label for="reportMessage">What is wrong with this part?</label><textarea id="reportMessage" required minlength="5" maxlength="2000" rows="5"></textarea><p id="reportFeedback" role="status"></p><div class="report-buttons"><button type="button" id="reportCancel" class="button button-outline">Cancel</button><button id="reportSend" class="button button-gold">Send report</button></div></form>`;
document.body.append(reportDialog);
let reportTarget = null;
function stopReporting() {
  reportingError = false;
  $("reportErrorBtn").textContent = "Report error";
  $("reportErrorBtn").setAttribute("aria-pressed", "false");
  $("readerContent").classList.remove("report-selecting");
}
$("reportErrorBtn").onclick = () => {
  if (!current()) return;
  if (reportingError) { stopReporting(); return; }
  reportingError = true;
  $("reportErrorBtn").textContent = "Cancel · select a part below";
  $("reportErrorBtn").setAttribute("aria-pressed", "true");
  $("readerContent").classList.add("report-selecting");
};
function selectReportPart(event) {
  if (!reportingError || (event.type === "keydown" && !["Enter", " "].includes(event.key))) return;
  const part = event.target.closest(".word, .hazza-mark, .hazzat-stack, .hazzat-content");
  if (!part || !current()) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const section = part.classList.contains("word") ? (part.closest(".coptic-row") ? "coptic" : "english") : "hazzat";
  reportTarget = { hymnId: current().id, title: displayHymnName(current()), section,
    kind: part.classList.contains("word") ? "word" : part.classList.contains("hazza-mark") ? "passage" : "stack",
    position: Number(part.dataset.position || 0), excerpt: (part.textContent.trim() || part.getAttribute("aria-label") || "Hazzat").slice(0,500) };
  $("reportPart").textContent = reportTarget.title + " · " + section + " " + reportTarget.kind + " " + (reportTarget.position + 1) + " · " + reportTarget.excerpt;
  $("reportMessage").value = ""; $("reportFeedback").textContent = "";
  stopReporting(); reportDialog.showModal(); $("reportMessage").focus();
}
$("readerContent").addEventListener("click", selectReportPart, true);
$("readerContent").addEventListener("keydown", selectReportPart, true);
window.addEventListener("hashchange", stopReporting);
$("reportCancel").onclick = () => reportDialog.close();
reportDialog.querySelector("form").onsubmit = async event => {
  event.preventDefault(); $("reportSend").disabled = true;
  try {
    const response = await fetch("/api/error-reports", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({...reportTarget,message:$("reportMessage").value}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not send your report. Try again.");
    $("reportFeedback").textContent = "Thank you. Your report was saved for the editors.";
    $("reportMessage").value = "";
  } catch(error) { $("reportFeedback").textContent = error.message; }
  finally { $("reportSend").disabled = false; }
};
const inboxDialog = document.createElement("dialog");
inboxDialog.className = "error-report-dialog";
inboxDialog.innerHTML = `<h2>Error reports</h2><div class="report-inbox"></div><button class="button button-outline" type="button">Close</button>`;
document.body.append(inboxDialog);
inboxDialog.querySelector("button").onclick = () => inboxDialog.close();
fetch("/api/session").then(r=>r.json()).then(data=>{
  for (const id of ["reportInboxBtn", "homeReportsBtn", "projectReportsBtn"]) $(id).hidden=!data.canEdit;
}).catch(()=>{});
let reportCursor = null;
let inboxGeneration = 0;
const moreReports = document.createElement("button");
moreReports.type="button"; moreReports.className="button button-outline"; moreReports.textContent="Show more reports"; moreReports.hidden=true;
inboxDialog.querySelector(".report-inbox").after(moreReports);
async function loadOpenReports(reset = false) {
  const list = inboxDialog.querySelector(".report-inbox");
  if(reset) { inboxGeneration++; reportCursor=null; list.textContent="Loading…"; moreReports.hidden=true; }
  const generation=inboxGeneration;
  moreReports.disabled=true;
  try {
    const response=await fetch("/api/error-reports" + (reportCursor ? "?cursor="+encodeURIComponent(reportCursor) : ""));
    const data=await response.json();
    if(!response.ok) throw new Error(data.error);
    if(generation!==inboxGeneration) return;
    if(reset) list.replaceChildren();
    reportCursor=data.nextCursor;
    moreReports.hidden=!reportCursor;
    for(const report of data.reports) {
      const item=document.createElement("article");
      const heading=document.createElement("h3"); heading.textContent=report.title+" · "+report.section+" "+report.kind+" "+(report.position+1);
      const excerpt=document.createElement("p"); excerpt.textContent=report.excerpt;
      const message=document.createElement("p"); message.textContent=report.message;
      const link=document.createElement("a"); link.href="#/hymn/"+report.hymn_id; link.textContent="Open hymn"; link.onclick=()=>inboxDialog.close();
      const resolve=document.createElement("button"); resolve.type="button"; resolve.textContent="Mark resolved"; resolve.className="button button-outline";
      resolve.onclick=async()=>{
        resolve.disabled=true;
        try {
          const r=await fetch("/api/error-reports",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({id:report.id})});
          if(!r.ok) throw new Error();
          item.remove();
          if(!list.children.length && !reportCursor) list.textContent="No open reports.";
        } catch { resolve.disabled=false; resolve.textContent="Try resolving again"; }
      };
      item.append(heading,excerpt,message,link,resolve); list.append(item);
    }
    if(!list.children.length && !reportCursor) list.textContent="No open reports.";
  } catch(error) {
    if(generation!==inboxGeneration) return;
    if(reset) list.textContent=error.message||"Could not load reports.";
    else moreReports.textContent="Could not load more. Try again";
  } finally { if(generation===inboxGeneration) moreReports.disabled=false; }
}
function openReportInbox() { if(!inboxDialog.open) inboxDialog.showModal(); void loadOpenReports(true); }
for(const id of ["reportInboxBtn","homeReportsBtn","projectReportsBtn"]) $(id).onclick=openReportInbox;
moreReports.onclick=()=>loadOpenReports();
