// The checks the Agent Guard asks, in two forms with the same shape:
//   localApi()   inside the Safe Near server (the remote MCP endpoint /mcp): calls the checks directly
//   httpApi()    anywhere else (the stdio MCP server on someone's machine): calls the public API of a Safe Near deployment, no database needed

/** The checks, called in this process (needs the database: used by the web server). */
export async function localApi() {
  const [{ checkRequest, accountReputation }, { inspect }, { contractReport }] = await Promise.all([
    import('../firewall/service.js'), import('../firewall/inspect.js'), import('../audit/report.js')]);
  const { entityView } = await import('../ontology/index.js');
  return {
    checkTx: (body) => checkRequest(body),
    inspect: (q) => inspect(q),
    contract: (id) => contractReport(id),
    account: (id) => accountReputation(id),
    whatIs: (id) => entityView(id),
    incidents: () => incidentsList(),
    incident: (q) => incidentLookup(q),
  };
}

/** The latest confirmed cases (the same list as GET /api/v1/incidents). */
export async function incidentsList(limit = 100) {
  const { col } = await import('../db.js');
  const rows = await col('incidents').find({ status: 'confirmed' }, { projection: { status: 1, kind: 1, 'attacker.account': 1, 'target.account': 1, stolen_usd: 1, held_usd: 1, started_ts: 1, 'ai.headline': 1, 'trail.exit_usd': 1 } }).sort({ started_ts: -1 }).limit(limit).toArray();
  return { incidents: rows };
}

/** The confirmed case an account, transaction, link or case id belongs to: { incident, role } | { checked: true } | {} (GET /api/v1/incident?q=). */
export async function incidentLookup(q) {
  const { findIncident } = await import('../incident/botinfo.js');
  const f = await findIncident(q);
  if (!f) return {};
  if (f.checked) return { checked: true };
  const { trail, ...inc } = f.inc;
  return { incident: { ...inc, trail: { exit_usd: trail?.exit_usd || {}, exits: (trail?.exits || []).slice(0, 20) } }, role: f.role || null };
}

/** The checks, through the public API of a deployment (default the hosted one). `apiKey` lifts the per-IP rate limit. */
export function httpApi({ base = process.env.SAFE_NEAR_URL || 'https://app.safe-near.org', apiKey = process.env.SAFE_NEAR_API_KEY || '', timeoutMs = 20000 } = {}) {
  const root = base.replace(/\/+$/, '') + '/api/v1';
  const call = async (path, init = {}) => {
    const r = await fetch(root + path, { ...init, headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}), ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  return {
    checkTx: (body) => call('/tx/check', { method: 'POST', body: JSON.stringify(body) }),
    inspect: (q) => call(`/inspect?q=${encodeURIComponent(q)}`),
    contract: (id) => call(`/contract?id=${encodeURIComponent(id)}`),
    account: (id) => call(`/account?id=${encodeURIComponent(id)}`),
    whatIs: (id) => call(`/entity?id=${encodeURIComponent(id)}`),
    incidents: () => call('/incidents'),
    incident: (q) => call(`/incident?q=${encodeURIComponent(q)}`),
  };
}
