// ================================================================== SYSTEM
views.logs = async () => {
  const j = await get('/api/logs', { level: ST.logs.level, limit: 300 });
  return `<div class="card"><div class="bar">${seg('logs', 'level', [['', 'All'], ['INFO', 'Info'], ['WARN', 'Warn'], ['ERROR', 'Error']])}</div>
    <table>${j.rows.map((r) => `<tr><td class="muted">${when(r.ts)}</td><td>${r.level === 'ERROR' ? '<span class="v bad">error</span>' : r.level === 'WARN' ? '<span class="v neutral">warn</span>' : '<span class="v unknown">info</span>'}</td><td class="wrap">${esc(r.msg)}</td></tr>`).join('') || empty(3, 'no log entries')}</table></div>`;
};
views.config = async () => {
  const c = await get('/api/config');
  const block = (title, o) => `<div class="card"><h2>${title}</h2><table class="kv">${Object.entries(o).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="wrap mono small">${esc(JSON.stringify(v))}</td></tr>`).join('')}</table></div>`;
  return `<div class="card muted">Read-only view of the settings in .env (never any secret). AI: ${c.ai.enabled ? 'NEAR AI on' : 'off'} · database ${esc(c.db)} · launchpads ${esc(c.launchpads.join(', '))}</div>
    <div class="grid2"><div>${block('Scanner timing', c.scan)}${block('AI analyst', c.analyst)}${SHOW_SIM ? block('Simulated wallet', c.sim) : ''}</div><div>${block('Hard gates', c.rules)}${block('Follow-up reviews', c.followUp)}${block('Early-investor tracking', { entry: c.entry, outcome: c.outcome })}</div></div>`;
};
