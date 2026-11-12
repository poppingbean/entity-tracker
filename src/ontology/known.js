// Facts that live in code today: the router lists, the launchpads, the firewall's trusted dapps, KNOWN_ACTORS and the name patterns.
// They are computed for an account on the fly ("virtual" facts, never stored), so every account gets an answer without a backfill,
// and the lists stay where they are until the migration moves them (docs/ontology-design.md, section 6).
import { builtinLabel } from '../labels.js';
import { TRUSTED } from '../firewall/rules.js';
import { KNOWN_ACTORS, PRIVACY_RELAY } from '../analysis/prompt.js';

const IMPLICIT = /^[0-9a-f]{64}$/;

// One class for each account the code names somewhere today. Where the old lists disagree (section 2), this is the decision.
export const KNOWN = {
  'near': ['system', 'NEAR system account'], 'system': ['system', 'NEAR system account'],
  'wrap.near': ['service/router', 'Wrapped NEAR'], 'intents.near': ['service/router', 'NEAR Intents', 'org:near-intents'],
  'aggregatedex.near': ['service/router', 'DEX aggregator'], 'dex.intear.near': ['service/router', 'Intear DEX', 'org:intear'],
  'dex-aggregator.intear.near': ['service/router', 'Intear aggregator', 'org:intear'], 'router.banana-gun.near': ['service/router', 'Banana Gun router'],
  'aa-router.justhoot.near': ['service/router', 'Justhoot router', 'org:justhoot'],
  'v2.ref-finance.near': ['contract/amm', 'Ref Finance', 'org:ref-finance'], 'dclv2.ref-labs.near': ['contract/amm', 'Ref Finance DCL', 'org:ref-finance'],
  'veax.near': ['contract/amm', 'Veax'],
  'meteor-relayer.near': ['service/relayer', 'Meteor Wallet relayer', 'org:meteor'], 'relay.aurora': ['service/relayer', 'Aurora relayer', 'org:aurora'],
  'relayer.nearmobile.near': ['service/relayer', 'NEAR Mobile relayer'], 'wallet.intear.near': ['service/relayer', 'Intear wallet', 'org:intear'],
  'aurora': ['service/bridge', 'Aurora engine', 'org:aurora'], 'bridge-mng.near': ['service/bridge', 'NEAR Intents 1Click deposits', 'org:near-intents'],
  'nearlytrade.near': ['service/launchpad', 'Nearly.trade', 'org:nearlytrade'], 'lock2.nearlytrade.near': ['service/launchpad', 'Nearly.trade locker', 'org:nearlytrade'],
  'launchpad.justhoot.near': ['service/launchpad', 'Justhoot', 'org:justhoot'], 'v2-launchpad.justhoot.near': ['service/launchpad', 'Justhoot v2', 'org:justhoot'],
  'v2-pool-creator.justhoot.near': ['service/launchpad', 'Justhoot pool creator', 'org:justhoot'], 'meme-cooking.near': ['service/launchpad', 'Meme.cooking'],
  'tkn.near': ['service/launchpad', 'tkn.near'], 'gaypad.j1-racing.near': ['service/launchpad', 'Gaypad'], 'liquidity.qlyphs.near': ['service/launchpad', 'Qlyphs'],
  'token-locker.ref-labs.near': ['service/launchpad', 'Ref token locker', 'org:ref-finance'],
  'reward-distribute.justhoot.near': ['service/treasury_or_reward', 'Justhoot fee distributor', 'org:justhoot'], 'nearkitfee.near': ['service/treasury_or_reward', 'NearKit fees'],
  'contract.main.burrow.near': ['contract/lending', 'Rhea (Burrow) lending', 'org:rhea'],
};
// Accounts the money tracers treat as pass-through today, outside the classes that pass money anyway.
export const PASS_THROUGH = new Set(['v2.ref-finance.near', 'dclv2.ref-labs.near', 'aurora']);

/** A fact made in code. */
const v = (subject, predicate, object, source, confidence, evidence, by) => ({ subject, predicate, object, source, confidence, evidence, by, virtual: true });

/** KNOWN_ACTORS id (a full name, or the first 8 characters of an implicit account) matching this account. */
const matches = (id, account) => id === account || (id.length === 8 && IMPLICIT.test(account) && account.startsWith(id));

/** Every virtual fact about one account. */
export function virtualFacts(account) {
  const a = String(account || ''), out = [];
  // a wallet group (grp:…), a case (inc:…) or an address on another chain (eth:0x…) is not a NEAR account: no account-name pattern applies
  // (a group named "binance-hack-…" would otherwise be classed an exchange because its name says Binance)
  if (!a || /^[a-z]+:/.test(a)) return out;
  const k = KNOWN[a];
  if (k) {
    out.push(v(a, 'is_a', k[0], 'manual', 0.95, 'named in Safe Near\'s code', 'ontology/known'));
    out.push(v(a, 'label', k[1], 'manual', 0.95, 'named in Safe Near\'s code', 'ontology/known'));
    if (k[2]) out.push(v(a, 'operated_by', k[2], 'manual', 0.9, 'named in Safe Near\'s code', 'ontology/known'));
  }
  if (PASS_THROUGH.has(a)) out.push(v(a, 'pass_through', true, 'manual', 0.95, 'the money tracers pass through it', 'ontology/known'));
  if (TRUSTED.has(a)) out.push(v(a, 'trusted', true, 'manual', 0.95, 'a contract users interact with every day (firewall)', 'firewall/rules'));
  if (matches(PRIVACY_RELAY, a)) out.push(v(a, 'is_a', 'service/intents_solver', 'manual', 0.9, 'NEAR Intents privacy relay shared by many users', 'analysis/prompt'));
  KNOWN_ACTORS.forEach((g, i) => {
    if (!g.ids.some((id) => matches(id, a))) return;
    if (g.hub) out.push(v(a, 'is_a', 'exchange', 'manual', 0.6, g.note, 'analysis/prompt'));
    else out.push(v(a, 'member_of', `grp:known:${i}`, 'manual', 0.8, g.note, 'analysis/prompt'));
  });

  // name patterns: the weakest source, only what an account's name says
  const N = (cls, conf, why) => out.push(v(a, 'is_a', cls, 'name_pattern', conf, why, 'ontology/names'));
  if (/\.user\.intear\.near$|\.racerbot\.near$|\.trade\.unrlzd\.near$/.test(a)) N('person/app_user', 0.7, 'an account a wallet / trading app made for its user');
  else if (/\.tg$/.test(a)) N('person/app_user', 0.7, 'a Telegram-wallet account');
  else if (/(^|[.-])solver([.-]|$)/.test(a)) N('service/intents_solver', 0.6, 'its name says it is a NEAR Intents solver');
  else if (/relayer|wallet-relay|registrar/.test(a)) N('service/relayer', 0.5, 'its name says it is a relayer');
  else if (/(^|\.)factory\./.test(a)) N('service/factory', 0.5, 'its name says it is a factory');
  else if (/reward|treasury|airdrop|faucet|payout/i.test(a)) N('service/treasury_or_reward', 0.4, 'its name says it pays many accounts');
  else if (/\.(nearlytrade|launchpad\.justhoot|v2-launchpad\.justhoot|gaypad\.j1-racing|qlyphs|tkn|meme-cooking)\.near$/.test(a)) N('contract/token', 0.5, 'a token made on a launchpad');
  else if (/omni.*bridge|\.factory\.bridge\.near$|omft\.near$|rainbow/i.test(a)) N('service/bridge', 0.5, 'its name says it is a bridge');
  const b = builtinLabel(a);
  if (b) {
    out.push(v(a, 'label', b.label, 'name_pattern', 0.5, 'account name', 'labels'));
    if (b.type === 'exchange') { N('exchange', 0.5, `its name says ${b.label}`); out.push(v(a, 'operated_by', `org:${b.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, 'name_pattern', 0.5, 'account name', 'labels')); }
    else if (b.type === 'bridge') N('service/bridge', 0.5, 'account name');
  }
  return out;
}
