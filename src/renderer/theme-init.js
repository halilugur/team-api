// Anti-flash theme init — runs synchronously in <head> before first paint.
// Sets the data-theme attribute on <html> from the stored preference (or the
// OS preference when none is stored) so the correct palette applies immediately
// and the window never flashes the wrong theme on load.
// CSP is script-src 'self', so this must be an external file (no inline script).
(function () {
  try {
    var stored = localStorage.getItem('theme'); // 'light' | 'dark' | null
    var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme = stored || (prefersLight ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
