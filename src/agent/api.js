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
  };
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
  };
}
