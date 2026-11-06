// Update log UI: "What's new" card on the home page, the full history page (#/updates)
// and the editors' review page (#/updates/pending) where pending changes are approved as a numbered update.
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
    }
    node.append(...children.filter(Boolean));
    return node;
  };
  const HOME_NOTES = 5;
  let editor = false;
  let pendingState = null;

  const formatDate = ms => {
    try { return new Date(ms).toLocaleDateString(document.documentElement.lang === "ar" ? "ar-EG" : "en-US", { year: "numeric", month: "long", day: "numeric" }); }
    catch { return new Date(ms).toDateString(); }
  };
  const getJson = async url => {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load updates.");
    return data;
  };
  const postJson = async (url, body) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || "Something went wrong. Try again."), { status: response.status });
    return data;
  };
  const notesList = (notes, limit = Infinity) => {
    const list = el("ul", { className: "update-notes" }, ...notes.slice(0, limit).map(note => el("li", { text: note, lang: "en", dir: "auto" })));
    return list;
  };
  const updateHeading = (tag, update) => el(tag, { text: "Update " + update.version });

  async function renderHome() {
    const host = $("updateHome");
    if (!host) return;
    let latest = null, pendingCount = 0;
    try { latest = (await getJson("/api/updates?limit=1")).updates?.[0] || null; } catch {}
    if (editor) { try { pendingCount = (await getJson("/api/updates/pending")).entries.length; } catch {} }
    host.replaceChildren();
    if (!latest && !editor) { host.hidden = true; return; }
    const card = el("section", { className: "update-card", "aria-labelledby": "updateHomeTitle" });
    if (latest) {
      const extra = latest.notes.length - HOME_NOTES;
      card.append(
        el("div", { className: "update-card-head" }, el("p", { className: "eyebrow", text: "What's new" }), el("a", { className: "update-link", href: "#/updates", text: "All updates →" })),
        Object.assign(updateHeading("h2", latest), { id: "updateHomeTitle" }),
        el("span", { className: "update-date", text: formatDate(latest.approvedAt) }),
        notesList(latest.notes, HOME_NOTES)
      );
      if (extra > 0) card.append(el("a", { className: "update-more", href: "#/updates", text: "+ " + extra + " more" }));
    } else {
      card.append(el("div", { className: "update-card-head" }, el("p", { className: "eyebrow", id: "updateHomeTitle", text: "What's new" })), el("p", { className: "update-empty", text: "No updates published yet." }));
    }
    if (editor) {
      // Editors always get a way in, even before anything is pending.
      card.append(el("div", { className: "update-pending-banner" },
        el("span", { text: !pendingCount ? "No pending changes yet. Edits show up here for approval." : pendingCount === 1 ? "1 pending change waiting for approval" : pendingCount + " pending changes waiting for approval" }),
        el("a", { className: "update-link", href: "#/updates/pending", text: "Review & approve →" })));
    }
    host.append(card);
    host.hidden = false;
  }

  async function renderHistory() {
    const body = $("updatesBody");
    $("updatesTitle").textContent = "What's new";
    $("updatesIntro").textContent = "Every change to the hymn library, newest first.";
    body.replaceChildren(el("p", { className: "update-empty", text: "Loading updates…" }));
    try {
      const { updates } = await getJson("/api/updates?limit=200");
      const list = el("div", { className: "update-list" });
      if (editor) list.append(el("a", { className: "update-link", href: "#/updates/pending", text: "Review pending changes →" }));
      for (const update of updates) list.append(el("article", { className: "update-entry" }, updateHeading("h2", update), el("span", { className: "update-date", text: formatDate(update.approvedAt) }), notesList(update.notes)));
      if (!updates.length) list.append(el("p", { className: "update-empty", text: "No updates published yet." }));
      body.replaceChildren(list);
    } catch (error) { body.replaceChildren(el("p", { className: "update-empty", text: error.message })); }
  }

  function setStatus(message, ok = false) {
    const status = $("pendingStatus");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("ok", ok);
  }

  async function renderPending(message = "", ok = false) {
    const body = $("updatesBody");
    $("updatesTitle").textContent = "Pending changes";
    $("updatesIntro").textContent = "Edits are logged here automatically. Reword or remove notes, add your own, then approve them as an update everyone can see.";
    if (!pendingState) body.replaceChildren(el("p", { className: "update-empty", text: "Loading pending changes…" }));
    try { pendingState = await getJson("/api/updates/pending"); }
    catch (error) { body.replaceChildren(el("p", { className: "update-empty", text: error.message })); return; }
    const { entries, nextVersion } = pendingState;
    const list = el("ul", { className: "pending-list", "aria-label": "Pending changes" });
    for (const entry of entries) list.append(pendingItem(entry));
    const addInput = el("input", { type: "text", maxlength: "300", placeholder: "Add a note, e.g. Renamed seasons (Nayrouz, Theophany…)", "aria-label": "New note" });
    const addForm = el("form", { className: "pending-add", onsubmit: async event => {
      event.preventDefault();
      const summary = addInput.value.trim();
      if (!summary) return;
      try { await postJson("/api/updates/pending", { action: "add", summary }); await renderPending("Note added.", true); }
      catch (error) { setStatus(error.message); }
    } }, addInput, el("button", { className: "button button-outline", type: "submit", text: "Add note" }));
    const minor = el("input", { type: "radio", name: "updateBump", value: "minor", checked: true });
    const major = el("input", { type: "radio", name: "updateBump", value: "major" });
    const approveButton = el("button", { className: "button button-gold", type: "button", text: "Approve as Update " + nextVersion.minor, disabled: !entries.length });
    const versionFor = () => major.checked ? nextVersion.major : nextVersion.minor;
    const relabel = () => { approveButton.textContent = "Approve as Update " + versionFor(); };
    minor.addEventListener("change", relabel);
    major.addEventListener("change", relabel);
    approveButton.addEventListener("click", async () => {
      const versionLabel = versionFor();
      const count = entries.length;
      if (!window.confirm("Publish Update " + versionLabel + " with " + count + (count === 1 ? " note" : " notes") + "? Everyone visiting the site will see it.")) return;
      approveButton.disabled = true;
      try {
        await postJson("/api/updates/approve", { entryIds: entries.map(entry => entry.id), bump: major.checked ? "major" : "minor", expectedVersion: versionLabel });
        pendingState = null;
        await renderPending("Update " + versionLabel + " is published.", true);
        void renderHome();
      } catch (error) {
        approveButton.disabled = false;
        if (error.status === 409) { pendingState = null; await renderPending(error.message); }
        else setStatus(error.message);
      }
    });
    const approve = el("section", { className: "pending-approve", "aria-label": "Approve update" },
      el("fieldset", {},
        el("legend", { text: "Number this update" }),
        el("label", {}, minor, el("span", { text: "Update " + nextVersion.minor })),
        nextVersion.major !== nextVersion.minor ? el("label", {}, major, el("span", { text: "Major update " + nextVersion.major })) : null),
      el("div", {}, approveButton));
    body.replaceChildren(
      el("a", { className: "update-link", href: "#/updates", text: "See published updates →" }),
      el("p", { className: "pending-status", id: "pendingStatus", role: "status", "aria-live": "polite" }),
      entries.length ? list : el("p", { className: "update-empty", text: "No pending changes. New edits will show up here." }),
      addForm,
      approve
    );
    setStatus(message, ok);
  }

  function pendingItem(entry) {
    const text = el("span", { className: "pending-item-text", text: entry.summary, lang: "en", dir: "auto" });
    const meta = el("span", { className: "pending-item-meta", text: [entry.editor, formatDate(entry.updatedAt)].filter(Boolean).join(" · ") });
    const main = el("div", { className: "pending-item-main" }, text, meta);
    const editButton = el("button", { className: "button button-outline update-button-small", type: "button", text: "Edit" });
    const removeButton = el("button", { className: "button button-outline update-button-small", type: "button", text: "Remove" });
    const item = el("li", { className: "pending-item" }, main, el("div", { className: "pending-item-actions" }, editButton, removeButton));
    editButton.addEventListener("click", () => {
      const input = el("input", { type: "text", maxlength: "300", value: entry.summary, "aria-label": "Edit note" });
      const save = el("button", { className: "button button-gold update-button-small", type: "submit", text: "Save" });
      const cancel = el("button", { className: "button button-outline update-button-small", type: "button", text: "Cancel", onclick: () => void renderPending() });
      const form = el("form", { className: "pending-item-main", onsubmit: async event => {
        event.preventDefault();
        try { await postJson("/api/updates/pending", { action: "edit", id: entry.id, summary: input.value }); await renderPending("Note saved.", true); }
        catch (error) { setStatus(error.message); }
      } }, input, el("div", { className: "pending-item-actions" }, save, cancel));
      item.replaceChildren(form);
      input.focus();
    });
    removeButton.addEventListener("click", async () => {
      try { await postJson("/api/updates/pending", { action: "dismiss", id: entry.id }); await renderPending("Note removed.", true); }
      catch (error) { setStatus(error.message); }
    });
    return item;
  }

  globalThis.UpdateLog = {
    init(canEdit) { editor = Boolean(canEdit); },
    refreshHome() { void renderHome(); },
    async show(pending) {
      pendingState = null;
      if (pending && editor) await renderPending();
      else await renderHistory();
    }
  };
})();
