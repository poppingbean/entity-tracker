// The evidence pack: one short brief about an incident for the people who can act on it (the victim, SEAL 911, NEAR Intents / 1Click,
// bridges, exchanges), always built from the latest trace. Sent by the bot (/hack) as a message and a Markdown file.
import { config } from '../config.js';

const usd = (x) => (x == null ? '?' : '$' + Math.round(x).toLocaleString('en-US'));
const amt = (x) => (x == null ? '?' : Number(x).toLocaleString('en-US', { maximumFractionDigits: 4 }));
const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '?');
/** Markdown brief of an incident for the people who can act. */
export function evidencePack(inc, { siteUrl = config.alerts.siteUrl, held = true } = {}) {
  const T = inc.trail || {}, src = (inc.sources || []).filter((s) => s.kind === 'exchange');
  const lines = [];
  lines.push(`# ${inc.kind === 'exchange_drain' ? `Exchange hot-wallet drain${inc.drain?.exchange ? ` (${inc.drain.exchange})` : ''}` : inc.kind === 'protocol_exploit' ? `Exploit of ${inc.target?.account || 'a contract'}` : 'Incident'} on NEAR`);
  lines.push('', `Prepared by Safe Near from executed on-chain transactions. USD at today's prices. Investigation: ${siteUrl ? `${siteUrl}/firewall/${encodeURIComponent(inc._id)}` : inc._id}`, '');
  if (inc.ai?.headline) lines.push(`**Summary.** ${inc.ai.headline}`, '');
  lines.push(`- **Taken:** ${usd(inc.stolen_usd)}${inc.started_ts ? `, starting ${when(inc.started_ts)}` : ''}`);
  lines.push(`- **Attacker's main wallet:** \`${inc.attacker?.account}\`${inc.attacker?.created_ts ? ` (created ${when(inc.attacker.created_ts)})` : ''}`);
  if (held) lines.push(`- **Still on NEAR:** ${usd(inc.held_usd)} across the attacker's wallets (see "Still held")`);
  if (src.length) {
    lines.push('', '## Where the money came from');
    for (const s of src) lines.push(`- \`${s.account}\`: ${s.name} (${s.how}) sent ${s.tokens.map((t) => `${amt(t.amount)} ${t.symbol}`).join(', ')} (${usd(s.usd)}) to \`${s.to}\` at ${when(s.first_ts)}; tx ${(s.txs || []).slice(0, 2).map((h) => `\`${h}\``).join(', ')}`);
  } else if (inc.target) {
    lines.push('', '## Target', `- \`${inc.target.account}\` lost ${usd(inc.target.lost_usd)}: ${(inc.target.tokens || []).map((t) => `${amt(t.amount)} ${t.symbol}`).join(', ')}`);
    for (const t of (inc.attack_txs || []).slice(0, 5)) lines.push(`- attack tx \`${t.tx}\` at ${when(t.ts)}: ${t.methods.join(', ')} on ${t.receiver}`);
  }
  const wallets = (inc.accounts || []).filter((a) => ['attacker', 'cash_out_wallet', 'sub_account', 'intents_account'].includes(a.role));
  lines.push('', '## Attacker wallets on NEAR (please refuse swaps, deposits and bridging from these)');
  for (const a of wallets) { const h = (inc.held || []).find((x) => x.account === a.account); lines.push(`- \`${a.account}\` (${a.role.replace(/_/g, ' ')})${h ? `: holds ${h.tokens.map((t) => `${amt(t.amount)} ${t.symbol}`).join(', ')} (${usd(h.usd)})` : ''}`); }
  const xs = (T.exits || []).filter((e) => e.recipient || e.chain);
  if (xs.length) {
    lines.push('', '## Where it went off NEAR');
    const byRecipient = new Map();
    for (const e of xs) { const k = `${e.chain || '?'}|${e.recipient || e.to}`; const x = byRecipient.get(k) || { chain: e.chain, recipient: e.recipient || e.to, usd: 0, out: [], txs: [] }; x.usd += e.usd || 0; if (e.amount_out) x.out.push(`${amt(Number(e.amount_out))} ${e.asset || ''}`.trim()); x.txs.push(...(e.dest_txs || [])); byRecipient.set(k, x); }
    for (const x of byRecipient.values()) lines.push(`- ${x.chain || '?'} \`${x.recipient}\`: ${usd(x.usd)}${x.out.length ? ` (received ${x.out.join(' + ')})` : ''}${x.txs.length ? `; destination tx ${x.txs.slice(0, 4).map((h) => `\`${h}\``).join(', ')}` : ''}`);
  }
  const bridge = (T.exits || []).filter((e) => e.kind === 'bridge' || /bridge/i.test(e.to || ''));
  if (bridge.length) lines.push('', '## Bridged', ...bridge.slice(0, 10).map((e) => `- ${amt(e.amount)} ${e.symbol} (${usd(e.usd)}) via \`${e.to}\`, tx \`${e.tx}\``));
  lines.push('', '## How the source was identified', inc.kind === 'exchange_drain'
    ? 'The source wallets have no NEAR name. They are identified as the exchange\'s hot wallets because each one sends its reserves to the exchange\'s named cold wallet, and each sent most or all of its balance, far above its usual withdrawals, to a wallet created by that very transfer.'
    : (inc.signals || []).map((s) => `- ${s}`).join('\n'));
  lines.push('', `Live: every attacker wallet above is watched block by block; any new move is reported at once. Contact: reply to the sender of this brief.`);
  return lines.join('\n');
}
