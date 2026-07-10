-- 10_BUYER_PACK_SNAPSHOTS_MVP.sql
-- Buyer Pack Phase B, Step 2 — durable, append-only Buyer Pack evidence schema.
--
-- STATUS: DRAFT — FOR REVIEW ONLY. NOT APPLIED. NOT RUN. NOT DEPLOYED.
-- Apply order: after AUTH_RLS_SCHEMA.sql (needs public.is_ddp_admin()) and after
-- the tables it references (public.profiles, public.inventory_batches) exist.
--
-- What this migration provides (server side of Buyer Pack Phase B):
--   • Three admin-only, append-only tables: snapshots, audit log, download log.
--   • RLS with admin-only SELECT/INSERT; NO update/delete policy at all.
--   • Triggers that block UPDATE/DELETE (row-level) and TRUNCATE (statement-
--     level) even for elevated roles (extends the compliance_audit_log pattern
--     in 9_COMPLIANCE_WATCHTOWER_MVP.sql, which guarded UPDATE/DELETE only).
--   • A SECURITY DEFINER RPC skeleton that atomically assigns the next version,
--     inserts the snapshot, and writes the pack_generated / pack_superseded
--     audit rows in one transaction, preserving the human-approval gate.
--
-- Scope / honesty notes (read before relying on any wording elsewhere):
--   • "Immutable within the application" only: append-only is enforced for the
--     application's roles (anon/authenticated) via RLS + trigger. This is NOT a
--     claim of legal, evidentiary, or WORM immutability; a platform owner with
--     direct Postgres/service-role access can still alter data at the
--     infrastructure layer. Do not describe this as legally immutable.
--   • Tamper-EVIDENT via a stored SHA-256 content hash — not tamper-proof.
--   • Personal-data capture (browser / ip_address / device / buyer_organisation)
--     is NOT populated by default; those columns exist but are left null. See the
--     download-log comment; enabling capture is a separate, privacy-reviewed step.
--   • Human approval gate preserved: a snapshot can only be created for a
--     recorded 'progress' procurement decision with a named approver (enforced by
--     column CHECKs AND re-asserted inside the RPC).
--   • Identity: issued_by = auth.uid() is the AUTHORITATIVE, server-captured
--     record of who issued the snapshot. approved_by is client-supplied METADATA
--     (it is part of the hashed evidence) and is NOT a cryptographically verified
--     identity — treat it as a display/label field, not proof of who approved,
--     until canonical server-side hash parity is implemented (see the hash-parity
--     TODO in the RPC). Do not present approved_by as verified identity.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. buyer_pack_snapshots — one immutable row per (pack, version)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.buyer_pack_snapshots (
  snapshot_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id               TEXT NOT NULL,                       -- = inventory batch id (business key)
  version               INTEGER NOT NULL CHECK (version >= 1),
  previous_snapshot_id  UUID REFERENCES public.buyer_pack_snapshots(snapshot_id),
  -- SHA-256 SHAPE constraint only. NOTE: the value is currently client-supplied
  -- and NOT recomputed server-side — see hash-parity TODO in the RPC below.
  content_hash          CHAR(64) NOT NULL
                          CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  approval_id           TEXT NOT NULL,
  approval_timestamp    TIMESTAMPTZ NOT NULL,
  -- Human-approval gate at the DB layer: only a recorded 'progress' decision
  -- with a named approver may exist.
  procurement_decision  TEXT NOT NULL CHECK (procurement_decision = 'progress'),
  approved_by           TEXT NOT NULL CHECK (length(btrim(approved_by)) > 0), -- client METADATA, NOT verified identity; see issued_by
  generated_by          TEXT NOT NULL,                       -- mirrors client manifest.generatedBy (not hashed)
  issued_by             UUID REFERENCES public.profiles(id), -- server-captured auth.uid() — AUTHORITATIVE issuer identity
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  frozen_evidence       JSONB NOT NULL,                      -- exactly the evidence portion that was hashed
  batch_id              UUID REFERENCES public.inventory_batches(id), -- nullable soft link
  UNIQUE (pack_id, version)                                  -- append-only version guard
);

CREATE INDEX IF NOT EXISTS idx_buyer_pack_snapshots_pack
  ON public.buyer_pack_snapshots (pack_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_buyer_pack_snapshots_hash
  ON public.buyer_pack_snapshots (content_hash);
CREATE INDEX IF NOT EXISTS idx_buyer_pack_snapshots_prev
  ON public.buyer_pack_snapshots (previous_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_buyer_pack_snapshots_batch
  ON public.buyer_pack_snapshots (batch_id);

-- ---------------------------------------------------------------------------
-- 2. buyer_pack_audit_log — append-only event trail, independent of snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.buyer_pack_audit_log (
  event_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id           TEXT NOT NULL,
  snapshot_version  INTEGER NOT NULL,
  action            TEXT NOT NULL
                      CHECK (action IN ('pack_generated','pack_viewed','pack_superseded','pack_archived')),
  actor             TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_buyer_pack_audit_pack
  ON public.buyer_pack_audit_log (pack_id, created_at);

-- ---------------------------------------------------------------------------
-- 3. buyer_pack_download_log — append-only download/export trail
-- ---------------------------------------------------------------------------
-- Personal-data columns (buyer_organisation / browser / ip_address / device)
-- are intentionally NOT populated by default. Capturing them is personal data
-- under PDPA (Thailand) / GDPR and conflicts with append-only "never delete";
-- enabling capture requires a separate, counsel-approved retention/erasure
-- decision. Left null here on purpose.
CREATE TABLE IF NOT EXISTS public.buyer_pack_download_log (
  download_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id            TEXT NOT NULL,
  snapshot_version   INTEGER NOT NULL,
  actor              TEXT NOT NULL,
  format             TEXT NOT NULL,        -- e.g. 'summary-copy' | 'print-pdf'
  buyer_organisation TEXT,                 -- not captured by default
  browser            TEXT,                 -- not captured by default
  ip_address         INET,                 -- not captured by default
  device             TEXT,                 -- not captured by default
  reason             TEXT,                 -- not captured by default
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_buyer_pack_download_pack
  ON public.buyer_pack_download_log (pack_id, created_at);

-- ---------------------------------------------------------------------------
-- 4. Append-only enforcement — block UPDATE/DELETE on all three tables
-- ---------------------------------------------------------------------------
-- Same technique as public.prevent_compliance_audit_log_mutation(). Two
-- independent guarantees together: (a) no RLS UPDATE/DELETE policy exists
-- (default-deny), and (b) this trigger raises even for elevated roles.
CREATE OR REPLACE FUNCTION public.prevent_buyer_pack_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; attempted % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_buyer_pack_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_buyer_pack_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_buyer_pack_mutation() FROM authenticated;

DROP TRIGGER IF EXISTS buyer_pack_snapshots_no_update_delete ON public.buyer_pack_snapshots;
CREATE TRIGGER buyer_pack_snapshots_no_update_delete
  BEFORE UPDATE OR DELETE ON public.buyer_pack_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.prevent_buyer_pack_mutation();

DROP TRIGGER IF EXISTS buyer_pack_audit_log_no_update_delete ON public.buyer_pack_audit_log;
CREATE TRIGGER buyer_pack_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON public.buyer_pack_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_buyer_pack_mutation();

DROP TRIGGER IF EXISTS buyer_pack_download_log_no_update_delete ON public.buyer_pack_download_log;
CREATE TRIGGER buyer_pack_download_log_no_update_delete
  BEFORE UPDATE OR DELETE ON public.buyer_pack_download_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_buyer_pack_mutation();

-- TRUNCATE is a statement-level operation that row-level BEFORE UPDATE/DELETE
-- triggers do NOT catch. Add statement-level BEFORE TRUNCATE guards so the
-- append-only guarantee also covers TRUNCATE. The same trigger function is
-- reused: it references only TG_TABLE_NAME / TG_OP (never NEW/OLD), so it is
-- valid for both row-level and statement-level triggers.
DROP TRIGGER IF EXISTS buyer_pack_snapshots_no_truncate ON public.buyer_pack_snapshots;
CREATE TRIGGER buyer_pack_snapshots_no_truncate
  BEFORE TRUNCATE ON public.buyer_pack_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_buyer_pack_mutation();

DROP TRIGGER IF EXISTS buyer_pack_audit_log_no_truncate ON public.buyer_pack_audit_log;
CREATE TRIGGER buyer_pack_audit_log_no_truncate
  BEFORE TRUNCATE ON public.buyer_pack_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_buyer_pack_mutation();

DROP TRIGGER IF EXISTS buyer_pack_download_log_no_truncate ON public.buyer_pack_download_log;
CREATE TRIGGER buyer_pack_download_log_no_truncate
  BEFORE TRUNCATE ON public.buyer_pack_download_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_buyer_pack_mutation();

-- ---------------------------------------------------------------------------
-- 5. RLS — admin-only SELECT + INSERT; deliberately NO update/delete policy
-- ---------------------------------------------------------------------------
ALTER TABLE public.buyer_pack_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_pack_audit_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_pack_download_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "buyer_pack_snapshots: admin select" ON public.buyer_pack_snapshots;
CREATE POLICY "buyer_pack_snapshots: admin select" ON public.buyer_pack_snapshots
  FOR SELECT USING (public.is_ddp_admin());
-- NO direct INSERT policy on buyer_pack_snapshots. Snapshots may be created ONLY
-- through public.issue_buyer_pack_snapshot (SECURITY DEFINER, which bypasses RLS
-- as owner). This makes the RPC the single write path, so every snapshot is
-- guaranteed to go through atomic version allocation, server-captured issued_by,
-- and the paired audit-log writes — a raw client INSERT cannot bypass them. The
-- two log tables below intentionally KEEP admin INSERT: that is the intended
-- direct-append path for audit/download events. The DROP below also clears any
-- INSERT policy left by an earlier revision.
DROP POLICY IF EXISTS "buyer_pack_snapshots: admin insert" ON public.buyer_pack_snapshots;

DROP POLICY IF EXISTS "buyer_pack_audit_log: admin select" ON public.buyer_pack_audit_log;
CREATE POLICY "buyer_pack_audit_log: admin select" ON public.buyer_pack_audit_log
  FOR SELECT USING (public.is_ddp_admin());
DROP POLICY IF EXISTS "buyer_pack_audit_log: admin insert" ON public.buyer_pack_audit_log;
CREATE POLICY "buyer_pack_audit_log: admin insert" ON public.buyer_pack_audit_log
  FOR INSERT WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "buyer_pack_download_log: admin select" ON public.buyer_pack_download_log;
CREATE POLICY "buyer_pack_download_log: admin select" ON public.buyer_pack_download_log
  FOR SELECT USING (public.is_ddp_admin());
DROP POLICY IF EXISTS "buyer_pack_download_log: admin insert" ON public.buyer_pack_download_log;
CREATE POLICY "buyer_pack_download_log: admin insert" ON public.buyer_pack_download_log
  FOR INSERT WITH CHECK (public.is_ddp_admin());

-- No UPDATE and no DELETE policies are defined for any of the three tables, and
-- no INSERT policy is defined for buyer_pack_snapshots (its only write path is
-- the SECURITY DEFINER RPC). Under RLS, the absence of a policy denies the
-- operation by default; the triggers above are the second, role-independent
-- guard (UPDATE/DELETE and TRUNCATE).

-- ---------------------------------------------------------------------------
-- 6. Atomic issue RPC (SECURITY DEFINER skeleton)
-- ---------------------------------------------------------------------------
-- Assigns the next version, inserts the snapshot, and writes the
-- pack_generated (+ pack_superseded for the prior version) audit rows in one
-- transaction. Runs as owner (bypasses RLS by design) but self-gates on
-- is_ddp_admin() so only an authenticated ddp_admin can issue.
--
-- HASH-PARITY TODO (UNRESOLVED — do NOT treat server verification as done):
--   The client computes content_hash as SHA-256 over a canonical JSON produced
--   by a recursive JavaScript String-sort of keys (canonicalJsonStringify in
--   src/lib/buyerPackSnapshot.ts). Postgres jsonb does NOT preserve that key
--   ordering (jsonb orders keys by length-then-bytes, not JS lexicographic),
--   so a naive pgcrypto digest(p_frozen_evidence::text) would NOT match the
--   client hash. Faithful server-side recomputation requires either a plpgsql
--   canonicaliser that reproduces the exact JS sort + serialization, or a
--   trusted extension. Until that exists this RPC:
--     • stores the client-supplied content_hash,
--     • enforces only its SHAPE (the CHECK on the column),
--     • DOES NOT verify the hash against p_frozen_evidence.
--   This is an explicit, known gap — not faked parity. Server-side hash
--   verification is a follow-up before this can be called tamper-evident
--   end-to-end at the DB layer.
CREATE OR REPLACE FUNCTION public.issue_buyer_pack_snapshot(
  p_pack_id              TEXT,
  p_content_hash         TEXT,
  p_approval_id          TEXT,
  p_approval_timestamp   TIMESTAMPTZ,
  p_procurement_decision TEXT,
  p_approved_by          TEXT,
  p_generated_by         TEXT,
  p_frozen_evidence      JSONB,
  p_batch_id             UUID DEFAULT NULL
)
RETURNS public.buyer_pack_snapshots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_prev public.buyer_pack_snapshots%ROWTYPE;
  v_next_version INTEGER;
  v_row public.buyer_pack_snapshots%ROWTYPE;
  v_actor TEXT;
BEGIN
  -- Human-approval gate + admin gate, re-asserted server-side.
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: ddp_admin role required';
  END IF;
  IF p_procurement_decision <> 'progress' THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: a recorded "progress" decision is required';
  END IF;
  IF p_approved_by IS NULL OR length(btrim(p_approved_by)) = 0 THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: a named human approver is required';
  END IF;

  -- Server-captured authoritative actor identity (preferred over client string).
  v_actor := COALESCE(auth.uid()::text, p_approved_by);

  -- Per-pack transaction serialization. hashtext(p_pack_id) is a deterministic,
  -- non-dynamic integer derived from the pack id; it implicitly widens to the
  -- bigint pg_advisory_xact_lock key. This serializes ALL concurrent issues for
  -- the same pack for the remainder of the transaction, closing BOTH:
  --   (a) the first-version race — where no row yet exists to lock, so two
  --       concurrent first issues would otherwise both compute version 1; and
  --   (b) the concurrent re-issue race — two issues both reading the same max().
  -- The lock is transaction-scoped and released automatically at COMMIT/ROLLBACK.
  -- The UNIQUE (pack_id, version) constraint remains the ultimate backstop.
  PERFORM pg_advisory_xact_lock(hashtext(p_pack_id));

  SELECT * INTO v_prev
  FROM public.buyer_pack_snapshots
  WHERE pack_id = p_pack_id
  ORDER BY version DESC
  LIMIT 1;

  v_next_version := COALESCE(v_prev.version, 0) + 1;

  INSERT INTO public.buyer_pack_snapshots (
    pack_id, version, previous_snapshot_id, content_hash,
    approval_id, approval_timestamp, procurement_decision, approved_by,
    generated_by, issued_by, frozen_evidence, batch_id
  ) VALUES (
    p_pack_id, v_next_version, v_prev.snapshot_id, p_content_hash,
    p_approval_id, p_approval_timestamp, p_procurement_decision, p_approved_by,
    p_generated_by, auth.uid(), p_frozen_evidence, p_batch_id
  )
  RETURNING * INTO v_row;

  INSERT INTO public.buyer_pack_audit_log (pack_id, snapshot_version, action, actor)
    VALUES (p_pack_id, v_next_version, 'pack_generated', v_actor);

  IF v_prev.snapshot_id IS NOT NULL THEN
    INSERT INTO public.buyer_pack_audit_log (pack_id, snapshot_version, action, actor)
      VALUES (p_pack_id, v_prev.version, 'pack_superseded', v_actor);
  END IF;

  RETURN v_row;
END;
$$;

-- The RPC is the only intended snapshot-write path. Lock down direct EXECUTE:
-- deny anon/PUBLIC and grant authenticated ONLY (the function self-gates on
-- is_ddp_admin). No service_role grant is issued: this is a frontend-only app
-- with no verified server-side caller for this RPC. Add a service_role grant
-- only if/when a real backend caller (e.g. an edge function) is introduced.
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) TO authenticated;

-- End of 10_BUYER_PACK_SNAPSHOTS_MVP.sql
