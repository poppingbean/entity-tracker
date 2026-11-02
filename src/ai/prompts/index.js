// Every system prompt the AI is given, as plain Markdown files in this folder, so they can be read and edited without touching code.
//   {{include:name}}  inserts another prompt file (shared parts: the TrustFlow analyst standards, the NFT analyst rules …)
//   {{name}}          a value the caller fills in (a config number, the list of contract types …); a missing one is an error
// prompt('audit-code-review', { roles, powers }) returns the finished text. Files are read once and cached.
import fs from 'node:fs';

const dir = new URL('./', import.meta.url);
const cache = new Map();
const raw = (name) => {
  if (!cache.has(name)) cache.set(name, fs.readFileSync(new URL(`${name}.md`, dir), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, ''));
  return cache.get(name);
};

/** The prompt `name` with its includes resolved and its {{slots}} filled from `vars`. */
export function prompt(name, vars = {}) {
  const text = raw(name).replace(/\{\{include:([a-z0-9-]+)\}\}/g, (_, n) => prompt(n, vars));
  return text.replace(/\{\{([A-Za-z_]\w*)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`prompt ${name}: no value for {{${k}}}`);
    return String(vars[k]);
  });
}

/** The names of every prompt file (for tests and listings). */
export const promptNames = () => fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
