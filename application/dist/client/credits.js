// Credits popup: opened from "Made by the Mobile Moallem Team" on the home page.
// The church list lives in index.html (#creditsDialog) — add a church there.
(() => {
  const $ = id => document.getElementById(id);
  const dialog = $("creditsDialog");
  if (!dialog) return;
  let lastFocus = null;
  function open() {
    lastFocus = document.activeElement;
    dialog.hidden = false;
    document.body.classList.add("dialog-open");
    $("creditsClose").focus();
  }
  function close() {
    if (dialog.hidden) return;
    dialog.hidden = true;
    document.body.classList.remove("dialog-open");
    lastFocus?.focus?.();
  }
  $("creditsBtn")?.addEventListener("click", open);
  $("creditsClose")?.addEventListener("click", close);
  dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
})();
