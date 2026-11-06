import { col } from '../db.js';
import { info } from '../log.js';
import { retractMoveAlerts } from './service.js';

const isDrain = (inc) => inc.kind === 'exchange_drain' || !!inc.drain;

/**
 * What the re-flag does with one incident: null (leave it), or { status, tag, reason }.
 * - Confirmed by a human (confirmed_by): left alone.
 * - An exchange hot-wallet drain is what a hack of the exchange looks like, never routine: it goes to suspected (a human confirms it),
 *   never cleared. A drain an earlier version of this re-flag cleared is put back to suspected too.
 * - Auto-confirmed money that only came through exchanges / solvers (not a drain): cleared as a normal fund movement.
 * - Any other auto-confirmed case: suspected, it waits for a human.
 */
export function reflagDecision(inc) {
  if (inc.confirmed_by) return null;
  if (inc.status === 'cleared' && inc.cleared?.by === 'system_reflag' && isDrain(inc))
    return { status: 'suspected', tag: 'review', reason: 'Re-flagged: an exchange hot-wallet drain is never cleared automatically - requires manual human confirmation' };
  if (inc.status !== 'confirmed') return null;
  if (isDrain(inc)) return { status: 'suspected', tag: 'review', reason: 'Re-flagged: exchange hot-wallet drain - requires manual human confirmation' };
  if ((inc.sources || []).some((s) => s.kind === 'exchange' || s.kind === 'service'))
    return { status: 'cleared', tag: 'safe', reason: 'Re-flagged: moved funds from exchange hot wallets / solvers (not confirmed as hack)' };
  return { status: 'suspected', tag: 'review', reason: 'Re-flagged: large fund movement - requires manual human confirmation' };
}

/**
 * Re-flag all incidents that were auto-classified as hacks without human confirmation (see reflagDecision):
 * - Exchange hot-wallet drains and other unconfirmed cases go to suspected; only exchange / solver fund moves that are not a drain are cleared.
 * - Corresponding firewall_flags are deleted.
 * - Alerts are retracted.
 */
export async function reflagIncidents({ log = info } = {}) {
  const allIncidents = await col('incidents').find({}).toArray();
  log(`Scanning ${allIncidents.length} incidents in MongoDB...`);

  const reflagged = [];
  const removedFlagIds = [];

  for (const inc of allIncidents) {
    if (inc.confirmed_by) {
      log(`Preserving manually confirmed incident: ${inc._id} (${inc.confirmed_by.reason || 'by operator'})`);
      continue;
    }
    const d = reflagDecision(inc);
    if (d) {
      const newStatus = d.status, reason = d.reason, newTag = d.tag, isExchangeOrSolver = d.status === 'cleared';

      const update = {
        $set: {
          status: newStatus,
          updated_ts: Date.now(),
          ...(isExchangeOrSolver ? { cleared: { ts: Date.now(), why: reason, by: 'system_reflag' } } : {}),
        },
        ...(isExchangeOrSolver ? {} : { $unset: { cleared: '' } }),
        $push: {
          tags: {
            $each: [{ tag: newTag, ts: Date.now(), why: reason, by: 'system_reflag' }],
            $slice: -10,
          },
        },
      };

      await col('incidents').updateOne({ _id: inc._id }, update);
      removedFlagIds.push(inc._id);
      reflagged.push({ id: inc._id, old_status: inc.status, new_status: newStatus, kind: inc.kind, reason });
      log(`Re-flagged ${inc._id}: ${inc.status} -> ${newStatus} (${reason})`);
    }
  }

  // Delete all firewall flags created for unconfirmed incidents
  let deletedFlagsCount = 0;
  if (removedFlagIds.length) {
    const delRes = await col('firewall_flags').deleteMany({ source: 'incident', incident: { $in: removedFlagIds } });
    deletedFlagsCount = delRes.deletedCount || 0;
    log(`Deleted ${deletedFlagsCount} firewall flags for unconfirmed incidents`);

    // Retract incident alerts
    const alertRes = await col('alerts').updateMany(
      { type: 'incident', 'data.incident': { $in: removedFlagIds }, title: { $not: /^Retracted/ } },
      [{ $set: { title: { $concat: ['Retracted (not a hack): ', '$title'] }, severity: 'info' } }]
    );
    log(`Retracted ${alertRes.modifiedCount || 0} incident alerts`);

    // Retract move alerts
    const moveAlertsCount = await retractMoveAlerts(removedFlagIds);
    log(`Retracted ${moveAlertsCount} stolen_funds_moved alerts`);
  }

  // Clean up any remaining incident firewall flags not tied to confirmed incidents (a case a human confirmed keeps its flags whatever
  // its status says)
  const confirmedIncidentIds = await col('incidents').distinct('_id', { status: 'confirmed' });
  const humanIds = await col('incidents').distinct('_id', { confirmed_by: { $exists: true, $ne: null } });
  const orphanedFlags = await col('firewall_flags').deleteMany({
    source: 'incident',
    incident: { $nin: [...new Set([...confirmedIncidentIds, ...humanIds])] },
  });
  if (orphanedFlags.deletedCount) {
    deletedFlagsCount += orphanedFlags.deletedCount;
    log(`Deleted ${orphanedFlags.deletedCount} orphaned incident firewall flags`);
  }

  // Clean up incident detections that had false hack tags (not the detections of a hack a human confirmed)
  const updatedDetections = await col('incident_detections').updateMany(
    { 'tags.tag': 'hack', 'review.incident': { $nin: humanIds } },
    { $pull: { tags: { tag: 'hack' } } }
  );

  return {
    reflagged_count: reflagged.length,
    reflagged,
    deleted_flags_count: deletedFlagsCount,
    updated_detections: updatedDetections.modifiedCount || 0,
    active_confirmed_incidents: confirmedIncidentIds,
  };
}
