import { col } from '../db.js';
import { info } from '../log.js';
import { retractMoveAlerts } from './service.js';

/**
 * Re-flag all incidents that were auto-classified as hacks without human confirmation:
 * - Solvers and hot wallet exchange transfers (e.g. exchange_drain) are re-flagged as cleared / normal fund movement.
 * - Other unconfirmed cases are reverted to suspected (tracing large fund moves without hack flags).
 * - Corresponding firewall_flags are deleted.
 * - Alerts are retracted.
 */
export async function reflagIncidents({ log = info } = {}) {
  const allIncidents = await col('incidents').find({}).toArray();
  log(`Scanning ${allIncidents.length} incidents in MongoDB...`);

  const reflagged = [];
  const removedFlagIds = [];

  for (const inc of allIncidents) {
    // If it has human confirmation (confirmed_by exists and has reason/by/source), preserve it as confirmed
    if (inc.confirmed_by) {
      log(`Preserving manually confirmed incident: ${inc._id} (${inc.confirmed_by.reason || 'by operator'})`);
      continue;
    }

    // If it is currently confirmed without confirmed_by (auto-confirmed bug):
    if (inc.status === 'confirmed') {
      const isExchangeOrSolver = inc.kind === 'exchange_drain' || inc.drain || (inc.sources || []).some(s => s.kind === 'exchange' || s.kind === 'service');
      const newStatus = isExchangeOrSolver ? 'cleared' : 'suspected';
      const reason = isExchangeOrSolver
        ? 'Re-flagged: moved funds from exchange hot wallets / solvers (not confirmed as hack)'
        : 'Re-flagged: large fund movement - requires manual human confirmation';
      const newTag = isExchangeOrSolver ? 'safe' : 'review';

      const update = {
        $set: {
          status: newStatus,
          updated_ts: Date.now(),
          ...(isExchangeOrSolver ? { cleared: { ts: Date.now(), why: reason, by: 'system_reflag' } } : {}),
        },
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

  // Clean up any remaining incident firewall flags not tied to confirmed incidents
  const confirmedIncidentIds = await col('incidents').distinct('_id', { status: 'confirmed' });
  const orphanedFlags = await col('firewall_flags').deleteMany({
    source: 'incident',
    incident: { $nin: confirmedIncidentIds },
  });
  if (orphanedFlags.deletedCount) {
    deletedFlagsCount += orphanedFlags.deletedCount;
    log(`Deleted ${orphanedFlags.deletedCount} orphaned incident firewall flags`);
  }

  // Clean up incident detections that had false hack tags
  const updatedDetections = await col('incident_detections').updateMany(
    { 'tags.tag': 'hack' },
    { $pull: { tags: { tag: 'hack' } } }
  );

  await (await import('../ontology/writers.js')).syncFacts(['incidents', 'firewall_flags']); // G1
  return {
    reflagged_count: reflagged.length,
    reflagged,
    deleted_flags_count: deletedFlagsCount,
    updated_detections: updatedDetections.modifiedCount || 0,
    active_confirmed_incidents: confirmedIncidentIds,
  };
}
