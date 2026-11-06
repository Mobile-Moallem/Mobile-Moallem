(() => {
  const key = "mobile-moallem-theme";
  const saved = () => { try { return localStorage.getItem(key); } catch { return null; } };
  const setTheme = theme => {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const button = document.getElementById("themeToggle");
    if (button) {
      button.textContent = dark ? "Light Mode" : "Dark Mode";
      button.setAttribute("aria-pressed", String(dark));
      button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    }
  };
  const initial = saved() || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  setTheme(initial);
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("themeToggle")?.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(key, next); } catch {}
      setTheme(next);
    });
  });
})();
