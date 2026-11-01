// Who controls a contract: its full-access keys, the owner / admin / guardian / operator accounts it names through its own views or
// keeps in its STATE, and what each of those is (a DAO, a multisig, a locked contract, a single wallet) with what the tracker knows
// about it (dev-rug blacklist, creators with rugged launches, hand-reported accounts).
import { col } from '../db.js';
import { viewAccount, viewAccessKeyList, viewFunction, viewStatePrefix, EMPTY_CODE_HASH } from './rpc.js';
import { stateAccounts } from './analysis.js';
import { validNearAddress } from './service.js';

// views that name who is in charge, and how to read accounts out of what they return
const OWNER_VIEWS = ['get_owner', 'get_owner_id', 'owner', 'owner_id', 'get_owner_account_id', 'query_owner', 'acl_get_super_admins', 'acl_get_admins', 'get_guardians', 'guardians',
  'get_operator_account_id', 'get_operators', 'get_upgraders', 'get_admin', 'get_admins', 'get_managers', 'get_pause_operator_id'];
const ACCOUNTISH = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
function accountsInValue(v, out = new Set(), depth = 0) {
  if (depth > 4 || out.size > 20) return out;
  if (typeof v === 'string') { if (v.length >= 2 && v.length <= 64 && ACCOUNTISH.test(v) && (v.includes('.') || /^[0-9a-f]{64}$/.test(v))) out.add(v); }
  else if (Array.isArray(v)) v.forEach((x) => accountsInValue(x, out, depth + 1));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => accountsInValue(x, out, depth + 1));
  return out;
}

/** What the tracker knows about accounts: [{ account, flags: [text] }]. */
export async function reputationOf(ids) {
  if (!ids.length) return new Map();
  const [black, reported, created] = await Promise.all([
    col('blacklist').find({ _id: { $in: ids } }).toArray(),
    col('firewall_flags').find({ _id: { $in: ids } }).toArray(),
    col('tokens').aggregate([{ $match: { creator: { $in: ids } } }, { $group: { _id: '$creator', launches: { $sum: 1 }, rugged: { $sum: { $cond: ['$outcome.rugged', 1, 0] } } } }]).toArray(),
  ]);
  const out = new Map(ids.map((id) => [id, []]));
  for (const b of black) out.get(b._id).push(`on the dev-rug blacklist (dumped ${b.symbol || b.token || 'its token'})`);
  for (const r of reported) out.get(r._id).push(`reported: ${r.reason}`);
  for (const c of created) if (c.rugged >= 1) out.get(c._id).push(`created ${c.launches} token${c.launches > 1 ? 's' : ''}, ${c.rugged} rugged`);
  return out;
}

/** What kind of account a controller is. `roleOf(account)` returns the classified role of a contract (code audits are cached). */
async function controllerKind(id, roleOf) {
  if (/\.sputnik-dao\.near$|\.sputnikv2\.testnet$/.test(id)) return 'dao';
  const a = await viewAccount(id).catch(() => null);
  if (!a) return 'missing';
  const hasCode = a.code_hash !== EMPTY_CODE_HASH || !!a.global_contract_hash || !!a.global_contract_account_id;
  if (!hasCode) return 'wallet';
  const role = await roleOf(id).catch(() => null);
  if (role === 'dao' || role === 'multisig') return role;
  const keys = await viewAccessKeyList(id).catch(() => []);
  return keys.some((k) => k.access_key?.permission === 'FullAccess') ? 'contract' : 'locked';
}

/**
 * Control of `account` given its exports. Returns { full_keys, keys_total, controllers: [{ account, kind, via, flags }] }.
 */
export async function controlOf(account, exports, { roleOf = async () => null } = {}) {
  const keys = await viewAccessKeyList(account).catch(() => []);
  const full_keys = keys.filter((k) => k.access_key?.permission === 'FullAccess').length;
  const found = new Map(); // account -> via
  for (const v of OWNER_VIEWS.filter((m) => exports?.includes(m))) {
    // ACL views (near-plugins) are paged: try them with paging args when the bare call returns nothing
    let r = await viewFunction(account, v);
    if (r == null && /^acl_/.test(v)) r = await viewFunction(account, v, v === 'acl_get_admins' ? { role: 'DAO', skip: 0, limit: 10 } : { skip: 0, limit: 10 });
    for (const id of accountsInValue(r)) if (id !== account && !found.has(id)) found.set(id, v.replace(/^get_|^acl_get_/, '').replace(/_id$|_account_id$/, ''));
  }
  // a config struct: only the fields that name who is in charge (not oracles, tokens or pools)
  for (const v of ['get_config', 'get_contract_info', 'get_contract_config'].filter((m) => exports?.includes(m))) {
    const r = await viewFunction(account, v);
    if (r && typeof r === 'object') for (const [k, val] of Object.entries(r)) if (/owner|admin|guardian|operator|manager|controller/i.test(k)) for (const id of accountsInValue(val)) if (id !== account && !found.has(id)) found.set(id, k.replace(/_id$|_account_id$/, ''));
  }
  if (exports?.includes('get_policy')) { // a Sputnik DAO: its council
    const pol = await viewFunction(account, 'get_policy');
    for (const role of pol?.roles || []) for (const id of role.kind?.Group || []) if (!found.has(id)) found.set(id, `policy role ${role.name}`);
  }
  if (!found.size) for (const id of stateAccounts(await viewStatePrefix(account, 'STATE'), account)) found.set(id, 'STATE');
  const ids = [...found.keys()].filter(validNearAddress).slice(0, 6);
  const rep = await reputationOf(ids);
  const controllers = [];
  for (const id of ids) controllers.push({ account: id, kind: await controllerKind(id, roleOf), via: found.get(id), flags: rep.get(id) || [] });
  return { full_keys, keys_total: keys.length, controllers };
}
