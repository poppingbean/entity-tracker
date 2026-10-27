// Accuracy metrics, pure (unit-tested). "Positive" always means the thing we try to catch: a bad outcome (the buyer lost money / a rug).
const r = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Ground truth of one launch from what a buyer at the check would have seen 24 h later: bad when the price fell below `badBelow` of it. */
export function outcomeLabel({ priceAtCheck, price24h, rugged = false, manual = null, badBelow = 0.85 }) {
  if (manual === 'bad' || manual === 'good') return { label: manual, source: 'manual' };
  if (!(priceAtCheck > 0) || price24h == null) return { label: null, source: 'no price' };
  const ret = price24h / priceAtCheck;
  return { label: ret < badBelow ? 'bad' : 'good', ret: r(ret, 4), source: 'price after 24 h', rugged };
}

/** rows: [{ flagged: bool, bad: bool }] -> confusion matrix and rates. "flagged" = the system warned / refused. */
export function confusion(rows) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const x of rows) { if (x.flagged && x.bad) tp++; else if (x.flagged) fp++; else if (x.bad) fn++; else tn++; }
  const n = tp + fp + tn + fn;
  return { n, tp, fp, tn, fn, base_rate: n ? r((tp + fn) / n) : null, precision: tp + fp ? r(tp / (tp + fp)) : null, recall: tp + fn ? r(tp / (tp + fn)) : null,
    accuracy: n ? r((tp + tn) / n) : null, false_alarm_rate: fp + tn ? r(fp / (fp + tn)) : null,
    // of what it let through, how much went bad (what a follower of the system actually experiences)
    bad_rate_passed: tn + fn ? r(fn / (tn + fn)) : null, bad_rate_flagged: tp + fp ? r(tp / (tp + fp)) : null };
}

/** Area under the ROC curve: the chance a random bad case scores riskier than a random good one (0.5 = no signal). rows: [{ risk, bad }]. */
export function auc(rows) {
  const xs = rows.filter((x) => x.risk != null && Number.isFinite(x.risk));
  const pos = xs.filter((x) => x.bad), neg = xs.filter((x) => !x.bad);
  if (!pos.length || !neg.length) return null;
  const sorted = [...xs].sort((a, b) => a.risk - b.risk);
  let rank = 0, sumPos = 0;
  for (let i = 0; i < sorted.length;) { let j = i; while (j < sorted.length && sorted[j].risk === sorted[i].risk) j++; const avg = (i + 1 + j) / 2; for (let k = i; k < j; k++) if (sorted[k].bad) sumPos += avg; rank = j; i = j; }
  return r((sumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length));
}

/** Bad rate per bucket of a score. rows: [{ value, bad }]; edges ascending, e.g. [0, 40, 55, 70, 101]. */
export function calibration(rows, edges) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const b = rows.filter((x) => x.value != null && x.value >= edges[i] && x.value < edges[i + 1]);
    out.push({ from: edges[i], to: edges[i + 1], n: b.length, bad_rate: b.length ? r(b.filter((x) => x.bad).length / b.length) : null });
  }
  return out;
}

/** Per gate: bad rate among checks that failed it vs passed it, and the lift. rows: [{ failed: Set(gate ids), bad }]. */
export function gateLift(rows, gates) {
  const all = rows.length ? rows.filter((x) => x.bad).length / rows.length : null;
  return gates.map((g) => {
    const f = rows.filter((x) => x.failed.has(g)), p = rows.filter((x) => !x.failed.has(g));
    const bf = f.length ? f.filter((x) => x.bad).length / f.length : null, bp = p.length ? p.filter((x) => x.bad).length / p.length : null;
    return { gate: g, failed_n: f.length, bad_rate_failed: r(bf), passed_n: p.length, bad_rate_passed: r(bp), lift: bf != null && all ? r(bf / all, 2) : null,
      // a gate that fails mostly good launches costs opportunities without catching much
      good_blocked: f.filter((x) => !x.bad).length };
  }).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
}

/** What a follower of a decision gets: the 24 h return (price multiple) of what it let through vs what it blocked. rows: [{ flagged, ret }]. */
export function returnSplit(rows) {
  const part = (xs) => { const v = xs.map((x) => x.ret).filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    return { n: v.length, mean: v.length ? r(v.reduce((s, x) => s + x, 0) / v.length) : null, median: v.length ? r(v[v.length >> 1]) : null }; };
  return { passed: part(rows.filter((x) => !x.flagged)), flagged: part(rows.filter((x) => x.flagged)) };
}
