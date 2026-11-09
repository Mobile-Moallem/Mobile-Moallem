/* Paste timings: let an editor drop a ready-made set of start times into a hymn.
   Accepts a JSON array, the aligner's JSON output, or plain text (seconds or m:ss,
   separated by commas, spaces or new lines; "-" or "null" for an untimed part).
   Applying goes through the editor's normal autosave, so the hymn becomes a draft
   until it is completed again. */
(() => {
  const MAX_SECONDS = 86400;
  const TARGETS = {
    copticTimings: "Coptic words",
    timings: "English words",
    hazzatTimings: "Hazzat pieces",
    hazzatLineTimings: "Hazzat lines"
  };
  // "the Coptic word timings", "the Hazzat piece timings", ...
  const timingsOf = key => TARGETS[key].replace(/s$/u, "") + " timings";

  function parseTime(token) {
    const t = String(token).trim();
    if (/^(null|-|—|–|none)$/iu.test(t)) return null;
    let m = /^(\d+):([0-5]?\d(?:\.\d+)?)$/u.exec(t);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = /^(\d+):(\d{1,2}):([0-5]?\d(?:\.\d+)?)$/u.exec(t);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (/^\d+(?:\.\d+)?$/u.test(t)) return Number(t);
    return undefined;
  }

  function fromJson(value, preferKey) {
    if (Array.isArray(value)) {
      if (value.every(v => v === null || typeof v === "number" || typeof v === "string")) return value;
      if (value.every(v => v && typeof v === "object")) {
        const field = ["forced", "new", "time", "start"].find(f => value.some(v => f in v));
        if (field) return value.map(v => v[field] ?? null);
      }
      return null;
    }
    if (value && typeof value === "object") {
      for (const key of [preferKey, "new_timings", "copticTimings", "timings", "hazzatTimings", "hazzatLineTimings"]) {
        if (key && Array.isArray(value[key])) return value[key];
      }
      if (value.project && typeof value.project === "object") return fromJson(value.project, preferKey);
      if (Array.isArray(value.words)) return fromJson(value.words, preferKey);
    }
    return null;
  }

  /** Parse pasted text into an array of seconds (or null). Returns {values} or {error}. */
  function parse(text, preferKey) {
    const raw = String(text ?? "").trim();
    if (!raw) return { error: "Paste some timings first." };
    let list = null;
    if (/^[[{]/u.test(raw)) {
      let json;
      try { json = JSON.parse(raw); } catch { return { error: "That looks like JSON but could not be read. Check for a missing bracket or comma." }; }
      list = fromJson(json, preferKey);
      if (!list) return { error: "Could not find a list of timings in that JSON." };
    } else {
      list = raw.split(/[\s,;]+/u).filter(Boolean);
    }
    const values = [];
    for (let i = 0; i < list.length; i++) {
      const v = list[i] === null ? null : typeof list[i] === "number" ? list[i] : parseTime(list[i]);
      if (v === undefined || (v !== null && !(Number.isFinite(v) && v >= 0 && v <= MAX_SECONDS))) {
        return { error: "Item " + (i + 1) + " (\"" + String(list[i]).slice(0, 20) + "\") is not a time." };
      }
      values.push(v === null ? null : Math.round(v * 100) / 100);
    }
    let last = -1, lastIndex = -1;
    for (let i = 0; i < values.length; i++) {
      if (values[i] === null) continue;
      if (values[i] < last) return { error: "Item " + (i + 1) + " (" + values[i] + " s) comes before item " + (lastIndex + 1) + " (" + last + " s). Times must go in order." };
      last = values[i]; lastIndex = i;
    }
    return { values };
  }

  /** Check parsed values against how many parts the hymn has. */
  function check(values, expected) {
    if (!expected) return { error: "This hymn has nothing to time in that section yet." };
    if (values.length !== expected) {
      return { error: "You pasted " + values.length + " timings but this section has " + expected + " parts. They must match exactly." };
    }
    const timed = values.filter(v => v !== null);
    return { timed: timed.length, first: timed[0], last: timed[timed.length - 1] };
  }

  const stamp = s => s == null ? "—" : Math.floor(s / 60) + ":" + (s % 60).toFixed(2).padStart(5, "0");

  globalThis.PasteTimings = { parse, check, parseTime, TARGETS };
  if (typeof document === "undefined") return;

  function wire() {
    const box = document.getElementById("pasteTimings");
    if (!box) return;
    const target = document.getElementById("pasteTimingsTarget");
    const input = document.getElementById("pasteTimingsInput");
    const status = document.getElementById("pasteTimingsStatus");
    const apply = document.getElementById("pasteTimingsApply");
    const copy = document.getElementById("pasteTimingsCopy");
    let ready = null;

    const hymn = () => (typeof current === "function" ? current() : null);
    const count = (h, key) => (typeof alignmentCount === "function" && h ? alignmentCount(h, key) : 0);

    function refresh() {
      ready = null;
      apply.disabled = true;
      const h = hymn();
      if (!h) { status.textContent = "Open a hymn first."; return; }
      const key = target.value;
      const expected = count(h, key);
      if (!input.value.trim()) {
        status.textContent = TARGETS[key] + ": " + expected + " parts. Paste one time per part, in order.";
        return;
      }
      const parsed = parse(input.value, key);
      if (parsed.error) { status.textContent = parsed.error; return; }
      const result = check(parsed.values, expected);
      if (result.error) { status.textContent = result.error; return; }
      ready = { key, values: parsed.values, hymnId: h.id };
      apply.disabled = false;
      status.textContent = "Ready: " + result.timed + " of " + expected + " " + TARGETS[key] +
        " timed, from " + stamp(result.first) + " to " + stamp(result.last) + ". Applying replaces the current " +
        timingsOf(key) + ".";
    }

    apply.addEventListener("click", () => {
      const h = hymn();
      if (!ready || !h || h.id !== ready.hymnId) { refresh(); return; }
      if (count(h, ready.key) !== ready.values.length) { refresh(); return; }
      h[ready.key] = ready.values.slice();
      if (typeof markUnsaved === "function") markUnsaved();
      if (typeof renderReader === "function") renderReader();
      status.textContent = "Applied the " + timingsOf(ready.key) + " (" + ready.values.length +
        "). Saved as a draft — press “Complete for listeners” when you are happy with it.";
      input.value = "";
      ready = null;
      apply.disabled = true;
    });

    copy.addEventListener("click", async () => {
      const h = hymn();
      if (!h) return;
      const text = JSON.stringify(h[target.value] || []);
      try { await navigator.clipboard.writeText(text); status.textContent = "Copied the current " + timingsOf(target.value) + "."; }
      catch { input.value = text; status.textContent = "Couldn’t reach the clipboard, so the current timings are in the box above."; }
    });

    target.addEventListener("change", refresh);
    input.addEventListener("input", refresh);
    box.addEventListener("toggle", () => { if (box.open) refresh(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
