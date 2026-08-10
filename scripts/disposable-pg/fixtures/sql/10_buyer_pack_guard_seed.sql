-- Liveness seed for migration 10's destructive-rollback guard.
--
-- The guard refuses to drop the buyer-pack tables while any issued snapshot,
-- audit event or download record exists, because those three tables ARE the
-- immutable record of what was released to a buyer, under whose approval, and
-- who fetched it. A guard that has never been shown data cannot be shown to
-- refuse, so one row is inserted here before the rollback is attempted.
--
-- Written to satisfy every CHECK the table declares rather than the minimum the
-- guard reads. A seed that only fills the counted column would still exercise
-- the guard, but it would stop exercising the table's own constraints the moment
-- one of them changed, and this is the only fixture that inserts here at all.
--
-- content_hash is CHAR(64) matching ^[0-9a-f]{64}$; procurement_decision is
-- pinned to 'progress' by CHECK — the human-approval gate at the database layer.
INSERT INTO public.buyer_pack_snapshots (
  pack_id, version, content_hash, approval_id, approval_timestamp,
  procurement_decision, approved_by, generated_by, frozen_evidence
) VALUES (
  'fixture-pack-10', 1,
  repeat('a', 64),
  'fixture-approval-1', now(),
  'progress', 'fixture approver', 'fixture harness',
  '{"fixture": true}'::jsonb
);

-- The audit log and the download log are counted by the guard separately, so
-- seed them too: a guard that only ever sees one of its three tables populated
-- is only a third tested, and its message reports all three counts.
-- `action` is CHECK-constrained to four values; 'pack_generated' is the one that
-- corresponds to the snapshot inserted above.
INSERT INTO public.buyer_pack_audit_log (pack_id, snapshot_version, action, actor)
VALUES ('fixture-pack-10', 1, 'pack_generated', 'fixture harness');

INSERT INTO public.buyer_pack_download_log (pack_id, snapshot_version, actor, format)
VALUES ('fixture-pack-10', 1, 'fixture harness', 'summary-copy');
