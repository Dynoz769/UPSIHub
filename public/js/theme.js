// Applied before first paint to avoid a flash of the wrong theme.
try {
  const t = localStorage.getItem('uh_theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch {}
