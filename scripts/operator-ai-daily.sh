#!/usr/bin/env bash
# The daily operator pass (operator mode, NEAR_AI_OPERATOR_DIR): AI requests the app could not send are written out, answered, then saved.
#   scripts/operator-ai-daily.sh ask    find what has no AI write-up and write each prompt to <dir>/requests (stale requests are cleared first)
#   (each answer goes to <dir>/answers/<same name>.json)
#   scripts/operator-ai-daily.sh save   the same run again: the app checks every answer (grounding, verdict rules, field shapes) and saves it to MongoDB
# Limits per run (env): OP_WATCHES=50 OP_AUDITS=40 OP_AUDIT_DAYS=3 OP_GROUPS=10 OP_INCIDENTS=3
set -u
cd "$(dirname "$0")/.."
export NEAR_AI_OPERATOR_DIR="${NEAR_AI_OPERATOR_DIR:-C:/TrustFlow/ai-operator}"
export ONTOLOGY_HEARTBEAT=false ONTOLOGY_SHADOW=false ONTOLOGY_BACKFILL_EVERY_HOURS=0
phase="${1:-ask}"
mkdir -p "$NEAR_AI_OPERATOR_DIR/requests" "$NEAR_AI_OPERATOR_DIR/answers"
# a request from an earlier day may be for data that has changed since: ask afresh, keep the answers
if [ "$phase" = ask ]; then rm -f "$NEAR_AI_OPERATOR_DIR"/requests/*.json; fi
since=$(node -e "console.log(new Date(Date.now() - ${OP_AUDIT_DAYS:-3} * 86400e3).toISOString())")
# ask: up to the limit of each kind (0 = skip it); save: exactly the items answered in <dir>/answers, whatever the limits
for job in "watches ${OP_WATCHES:-50}" "audits $since ${OP_AUDITS:-40}" "groups ${OP_GROUPS:-10}" "incidents ${OP_INCIDENTS:-3}"; do
  n="${job##* }"
  if [ "$phase" = ask ] && [ "$n" = 0 ]; then continue; fi
  echo "== $job ($phase)"
  if [ "$phase" = save ]; then extra=--answered; else extra=; fi
  timeout 1200 node src/cli.js operator-ai $job $extra 2>&1 | grep -v ' INFO ' | tail -4
done
# what still needs an answer
node -e "
const fs = require('fs'), d = process.env.NEAR_AI_OPERATOR_DIR;
const todo = fs.readdirSync(d + '/requests').filter((f) => f.endsWith('.json') && !fs.existsSync(d + '/answers/' + f));
console.log('PENDING ' + todo.length + ' request(s) in ' + d + '/requests');
for (const f of todo) { const r = JSON.parse(fs.readFileSync(d + '/requests/' + f, 'utf8')); console.log('  ' + f + '  ' + (r.user || '').length + ' chars  ' + String(r.system || '').slice(0, 70).replace(/\s+/g, ' ')); }
"
