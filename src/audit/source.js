// The source a contract claims (NEP-330 `contract_source_metadata.link`): fetch the repository at that commit and check that the methods
// the deployed code exports exist in it. A deployed method missing from the claimed source means the published code is not what runs.
// This can't prove the bytes match (no reproducible build); it can catch a claim that doesn't hold. Excerpts of the admin functions are
// kept for the AI review.
import { config } from '../config.js';

const GH = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/#?]+)(?:\/(.*))?)?\/?$/;
const headers = () => ({ accept: 'application/vnd.github+json', 'user-agent': 'safe-near-audit', ...(config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {}) });
const get = async (url, json = true) => { const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${r.status} ${url}`); return json ? r.json() : r.text(); };

/** { owner, repo, ref, dir } from a NEP-330 link, or null when it isn't a GitHub link. */
export function parseSourceLink(link) {
  const m = String(link || '').match(GH);
  return m ? { owner: m[1], repo: m[2], ref: m[3] || null, dir: m[4] || '' } : null;
}

// methods that macros generate (near-plugins access control / pausable / upgradable, the token-standard impl macros, the ABI): they never
// appear as `fn` in the source
const MACRO_MADE = /^(acl_|pa_|up_|__contract_abi$|contract_source_metadata$|ft_|nft_|mt_|storage_)/;
/** Methods of a contract's write list that the source files never define (Rust `fn name`, JS/TS `name(`). Pure. */
export function missingFromSource(methods, files) {
  const text = files.map((f) => f.text).join('\n');
  return methods.filter((m) => !MACRO_MADE.test(m) && !new RegExp(`\\bfn\\s+${m}\\b|\\b${m}\\s*\\(|["'\`]${m}["'\`]`).test(text));
}

/**
 * Review the claimed source. Returns { link, ref, files_read, missing: [...], excerpts: [{ path, method, text }] } or { error }.
 * Reads Rust / TS / JS files under the linked directory (at most 80 files, 2 MB).
 */
export async function reviewSource(link, writeMethods, powerMethods) {
  const p = parseSourceLink(link);
  if (!p) return { error: 'not a GitHub link' };
  try {
    const ref = p.ref || (await get(`https://api.github.com/repos/${p.owner}/${p.repo}`)).default_branch;
    const tree = await get(`https://api.github.com/repos/${p.owner}/${p.repo}/git/trees/${ref}?recursive=1`);
    const paths = (tree.tree || []).filter((x) => x.type === 'blob' && /\.(rs|ts|js)$/.test(x.path) && x.path.startsWith(p.dir) && !/(^|\/)(tests?|target|node_modules|examples?|scripts|sandbox|integration)(\/|$)|\.test\.|_test\.rs$/.test(x.path) && (x.size || 0) < 300000)
      .sort((a, b) => (/(^|\/)src\//.test(b.path) ? 1 : 0) - (/(^|\/)src\//.test(a.path) ? 1 : 0)).slice(0, 120);
    const files = [];
    let bytes = 0;
    for (const x of paths) {
      if (bytes > 2e6 || files.length >= 80) break;
      const text = await get(`https://raw.githubusercontent.com/${p.owner}/${p.repo}/${ref}/${x.path}`, false).catch(() => '');
      bytes += text.length; files.push({ path: x.path, text });
    }
    // entry-point files (#[near] / #[near_bindgen]) first, for the excerpts
    files.sort((a, b) => (/#\[near/.test(b.text) ? 1 : 0) - (/#\[near/.test(a.text) ? 1 : 0));
    if (!files.length) return { link, ref, files_read: 0, error: 'no source files found at that path' };
    const missing = missingFromSource(writeMethods, files);
    // the body of each power method, for the AI (first ~60 lines after `fn name`)
    const excerpts = [];
    for (const m of powerMethods.slice(0, 8)) for (const f of files) {
      const i = f.text.search(new RegExp(`\\bfn\\s+${m}\\b`));
      if (i >= 0) { excerpts.push({ path: f.path, method: m, text: f.text.slice(i, i + 2500).split('\n').slice(0, 60).join('\n') }); break; }
    }
    return { link, ref, files_read: files.length, missing, excerpts };
  } catch (e) { return { link, error: e.message.slice(0, 160) }; }
}
