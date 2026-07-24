-- =============================================================================
-- Migration 25 — VERIFY (Watchtower ingestion provenance & dedup)
--
-- Production-safe: the whole script runs inside ONE transaction that ends in
-- ROLLBACK, so every fixture it creates is discarded. It contains no COMMIT.
--
-- These are BEHAVIOURAL checks, not catalog spot-checks: each section builds a
-- real fixture and proves the database actually refuses the thing this
-- migration says it must refuse. A section that cannot build its fixture
-- RAISES rather than silently passing, so the script can never pass vacuously.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 25_WATCHTOWER_INGESTION_PROVENANCE_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- VERIFY A — every migration-25 object exists with the required security shape.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
  f text;
  c text;
  tables text[] := ARRAY['watchtower_ingestion_runs','watchtower_ingestion_items'];
  fns text[] := ARRAY['prevent_watchtower_ingestion_item_mutation',
                      'guard_watchtower_ingestion_run_update',
                      'guard_watchtower_ingestion_item_insert'];
  cols text[] := ARRAY['content_hash','canonical_url','external_document_id',
                       'source_tier','ingestion_run_id','ingestion_item_key'];
  rls_off text[] := ARRAY[]::text[];
  insecure text[] := ARRAY[]::text[];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;

  FOREACH f IN ARRAY fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname = f)
    THEN missing := missing || ('function ' || f); END IF;
  END LOOP;

  FOREACH c IN ARRAY cols LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'legal_updates' AND column_name = c)
    THEN missing := missing || ('legal_updates.' || c); END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'watchtower_ingestion_items_no_update_delete')
  THEN missing := missing || 'trigger watchtower_ingestion_items_no_update_delete'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'watchtower_ingestion_runs_update_guard')
  THEN missing := missing || 'trigger watchtower_ingestion_runs_update_guard'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'watchtower_ingestion_items_run_open_guard')
  THEN missing := missing || 'trigger watchtower_ingestion_items_run_open_guard'; END IF;

  IF array_length(missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: missing object(s): %', array_to_string(missing, ', ');
  END IF;

  SELECT array_agg(cl.relname::text) INTO rls_off
  FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
  WHERE n.nspname = 'public' AND cl.relname = ANY(tables) AND cl.relrowsecurity = false;
  IF rls_off IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: RLS not enabled on: %', array_to_string(rls_off, ', ');
  END IF;

  SELECT array_agg(p.proname::text) INTO insecure
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY(fns)
    AND (p.prosecdef = false OR p.proconfig IS NULL
         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'));
  IF insecure IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: not SECURITY DEFINER with search_path: %',
      array_to_string(insecure, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: migration-25 tables, columns, triggers and functions exist; RLS on.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- VERIFY B — nobody holds DELETE/TRUNCATE on the ingestion evidence tables, and
-- anon holds nothing at all.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  leaks text[] := ARRAY[]::text[];
  r record;
BEGIN
  FOR r IN
    SELECT table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('watchtower_ingestion_runs','watchtower_ingestion_items')
      AND (
        (grantee IN ('anon','PUBLIC'))
        OR (grantee IN ('authenticated','service_role') AND privilege_type IN ('DELETE','TRUNCATE'))
        OR (grantee = 'authenticated' AND table_name = 'watchtower_ingestion_items'
            AND privilege_type = 'UPDATE')
      )
  LOOP
    leaks := leaks || format('%s: %s has %s', r.table_name, r.grantee, r.privilege_type);
  END LOOP;

  IF array_length(leaks,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: unexpected privilege(s): %', array_to_string(leaks, '; ');
  END IF;

  -- And the grants the runner genuinely needs must be present, or Phase C
  -- cannot record anything at all.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='watchtower_ingestion_runs'
      AND grantee='authenticated' AND privilege_type='INSERT'
  ) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: authenticated cannot INSERT ingestion runs';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='watchtower_ingestion_items'
      AND grantee='authenticated' AND privilege_type='INSERT'
  ) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: authenticated cannot INSERT ingestion items';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: no DELETE/TRUNCATE anywhere, anon has nothing, runner grants intact.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- VERIFY C — the fail-conservative run status algebra is enforced by the
-- database, not merely by the application.
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  src_id uuid;
  refused int := 0;
BEGIN
  INSERT INTO public.regulatory_sources (name, jurisdiction, source_type, url)
  VALUES ('VERIFY25 fixture source', 'TH', 'government_regulator', 'https://verify25.example.gov/feed.xml')
  RETURNING id INTO src_id;

  IF src_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: could not build the fixture source (script would pass vacuously)';
  END IF;

  -- C1: a "successful" run may not carry a failure reason.
  BEGIN
    INSERT INTO public.watchtower_ingestion_runs
      (source_id, connector_kind, status, failure_reason, finished_at)
    VALUES (src_id, 'rss', 'succeeded', 'fetch_failed', NOW());
    RAISE EXCEPTION 'VERIFY C FAILED: a succeeded run was allowed to carry a failure_reason';
  EXCEPTION WHEN check_violation THEN refused := refused + 1;
  END;

  -- C2: THE central governance rule — an unavailable source cannot be recorded
  -- as a terminal outcome without an explicit reason.
  BEGIN
    INSERT INTO public.watchtower_ingestion_runs
      (source_id, connector_kind, status, finished_at)
    VALUES (src_id, 'rss', 'failed', NOW());
    RAISE EXCEPTION 'VERIFY C FAILED: a failed run was allowed with no failure_reason';
  EXCEPTION WHEN check_violation THEN refused := refused + 1;
  END;

  -- C3: a terminal run must be closed off with a completion timestamp.
  BEGIN
    INSERT INTO public.watchtower_ingestion_runs
      (source_id, connector_kind, status, failure_reason)
    VALUES (src_id, 'rss', 'failed', 'timeout');
    RAISE EXCEPTION 'VERIFY C FAILED: a failed run was allowed with no finished_at';
  EXCEPTION WHEN check_violation THEN refused := refused + 1;
  END;

  -- C4: 'succeeded' is unreachable while any item failed.
  BEGIN
    INSERT INTO public.watchtower_ingestion_runs
      (source_id, connector_kind, status, finished_at, items_seen, items_failed)
    VALUES (src_id, 'rss', 'succeeded', NOW(), 1, 1);
    RAISE EXCEPTION 'VERIFY C FAILED: a succeeded run was allowed with items_failed > 0';
  EXCEPTION WHEN check_violation THEN refused := refused + 1;
  END;

  -- C5: 'partial' requires at least one failed item.
  BEGIN
    INSERT INTO public.watchtower_ingestion_runs
      (source_id, connector_kind, status, failure_reason, finished_at, items_seen, items_new)
    VALUES (src_id, 'rss', 'partial', 'partial_item_failure', NOW(), 1, 1);
    RAISE EXCEPTION 'VERIFY C FAILED: a partial run was allowed with items_failed = 0';
  EXCEPTION WHEN check_violation THEN refused := refused + 1;
  END;

  -- C6: the per-outcome counters must account for every item seen.
  BEGIN
    INSERT INTO public.watchtower_ingestion_runs
      (source_id, connector_kind, status, finished_at, items_seen, items_new)
    VALUES (src_id, 'rss', 'succeeded', NOW(), 5, 1);
    RAISE EXCEPTION 'VERIFY C FAILED: run counters were allowed not to balance';
  EXCEPTION WHEN check_violation THEN refused := refused + 1;
  END;

  -- C7: an in-flight run may not pre-declare completion.
  BEGIN
    INSERT INTO public.watchtower_ingestion_runs
      (source_id, connector_kind, status, finished_at)
    VALUES (src_id, 'rss', 'running', NOW());
    RAISE EXCEPTION 'VERIFY C FAILED: a running run was allowed to carry finished_at';
  EXCEPTION WHEN check_violation THEN refused := refused + 1;
  END;

  IF refused <> 7 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: expected 7 refusals, observed %', refused;
  END IF;

  -- And the legitimate shapes must still be accepted.
  INSERT INTO public.watchtower_ingestion_runs
    (source_id, connector_kind, status, finished_at, items_seen, items_new, items_duplicate)
  VALUES (src_id, 'rss', 'succeeded', NOW(), 3, 1, 2);

  INSERT INTO public.watchtower_ingestion_runs
    (source_id, connector_kind, status, failure_reason, error_detail, finished_at)
  VALUES (src_id, 'rss', 'failed', 'source_unavailable', 'host did not respond within 10000ms', NOW());

  RAISE NOTICE 'VERIFY C PASSED: run status algebra enforced (7 refusals), valid runs accepted.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- VERIFY D — a terminal run cannot be reopened, re-characterised, or deleted,
-- and its identity/start facts are immutable.
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  src_id uuid;
  run_id uuid;
  refused int := 0;
BEGIN
  INSERT INTO public.regulatory_sources (name, jurisdiction, source_type, url)
  VALUES ('VERIFY25 fixture source D', 'TH', 'government_regulator', 'https://verify25d.example.gov/feed.xml')
  RETURNING id INTO src_id;

  INSERT INTO public.watchtower_ingestion_runs (source_id, connector_kind)
  VALUES (src_id, 'rss')
  RETURNING id INTO run_id;

  IF run_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY D FAILED: could not build the fixture run';
  END IF;

  -- An open run may legitimately be closed exactly once.
  UPDATE public.watchtower_ingestion_runs
  SET status = 'failed', failure_reason = 'timeout', finished_at = NOW()
  WHERE id = run_id;

  IF (SELECT status FROM public.watchtower_ingestion_runs WHERE id = run_id) <> 'failed' THEN
    RAISE EXCEPTION 'VERIFY D FAILED: closing an open run did not take effect';
  END IF;

  -- D1: a failed run can never be rewritten as a success.
  BEGIN
    UPDATE public.watchtower_ingestion_runs
    SET status = 'succeeded', failure_reason = NULL
    WHERE id = run_id;
    RAISE EXCEPTION 'VERIFY D FAILED: a terminal failed run was rewritten as succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'VERIFY D FAILED%' THEN RAISE; END IF;
    refused := refused + 1;
  END;

  -- D2: start facts are immutable.
  BEGIN
    UPDATE public.watchtower_ingestion_runs SET started_at = NOW() + interval '1 day' WHERE id = run_id;
    RAISE EXCEPTION 'VERIFY D FAILED: started_at was mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'VERIFY D FAILED%' THEN RAISE; END IF;
    refused := refused + 1;
  END;

  -- D3: evidence cannot be deleted.
  BEGIN
    DELETE FROM public.watchtower_ingestion_runs WHERE id = run_id;
    RAISE EXCEPTION 'VERIFY D FAILED: an ingestion run was deleted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'VERIFY D FAILED%' THEN RAISE; END IF;
    refused := refused + 1;
  END;

  IF refused <> 3 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: expected 3 refusals, observed %', refused;
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: terminal runs are immutable and undeletable; open runs close once.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- VERIFY E — ingestion items are append-only and can only be attached to a run
-- that is still in flight.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  src_id uuid;
  run_id uuid;
  item_id uuid;
  refused int := 0;
BEGIN
  INSERT INTO public.regulatory_sources (name, jurisdiction, source_type, url)
  VALUES ('VERIFY25 fixture source E', 'TH', 'government_regulator', 'https://verify25e.example.gov/feed.xml')
  RETURNING id INTO src_id;

  INSERT INTO public.watchtower_ingestion_runs (source_id, connector_kind)
  VALUES (src_id, 'rss')
  RETURNING id INTO run_id;

  INSERT INTO public.watchtower_ingestion_items
    (run_id, source_id, item_key, content_hash, dedup_decision)
  VALUES (run_id, src_id, src_id || '::item-1', repeat('a', 64), 'unchanged')
  RETURNING id INTO item_id;

  IF item_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY E FAILED: could not build the fixture item';
  END IF;

  -- E1: an item may not be rewritten.
  BEGIN
    UPDATE public.watchtower_ingestion_items SET dedup_decision = 'new' WHERE id = item_id;
    RAISE EXCEPTION 'VERIFY E FAILED: an ingestion item was updated';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'VERIFY E FAILED%' THEN RAISE; END IF;
    refused := refused + 1;
  END;

  -- E2: an item may not be removed.
  BEGIN
    DELETE FROM public.watchtower_ingestion_items WHERE id = item_id;
    RAISE EXCEPTION 'VERIFY E FAILED: an ingestion item was deleted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'VERIFY E FAILED%' THEN RAISE; END IF;
    refused := refused + 1;
  END;

  -- E3: the same entry cannot be double-counted within one run.
  BEGIN
    INSERT INTO public.watchtower_ingestion_items
      (run_id, source_id, item_key, content_hash, dedup_decision)
    VALUES (run_id, src_id, src_id || '::item-1', repeat('b', 64), 'unchanged');
    RAISE EXCEPTION 'VERIFY E FAILED: the same item_key was recorded twice in one run';
  EXCEPTION WHEN unique_violation THEN refused := refused + 1;
  END;

  -- E4: an error outcome must say why.
  BEGIN
    INSERT INTO public.watchtower_ingestion_items (run_id, source_id, item_key, dedup_decision)
    VALUES (run_id, src_id, src_id || '::item-2', 'error');
    RAISE EXCEPTION 'VERIFY E FAILED: an error item was allowed with no failure_reason';
  EXCEPTION WHEN check_violation THEN refused := refused + 1;
  END;

  -- E5: a non-error decision must carry the hash it claims to have compared.
  BEGIN
    INSERT INTO public.watchtower_ingestion_items (run_id, source_id, item_key, dedup_decision)
    VALUES (run_id, src_id, src_id || '::item-3', 'duplicate_content_hash');
    RAISE EXCEPTION 'VERIFY E FAILED: a duplicate decision was allowed with no content_hash';
  EXCEPTION WHEN check_violation THEN refused := refused + 1;
  END;

  -- Close the run, then prove no further evidence can be attached to it.
  UPDATE public.watchtower_ingestion_runs
  SET status = 'succeeded', finished_at = NOW(), items_seen = 1, items_unchanged = 1
  WHERE id = run_id;

  BEGIN
    INSERT INTO public.watchtower_ingestion_items
      (run_id, source_id, item_key, content_hash, dedup_decision)
    VALUES (run_id, src_id, src_id || '::item-late', repeat('c', 64), 'unchanged');
    RAISE EXCEPTION 'VERIFY E FAILED: an item was attached to an already-terminal run';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'VERIFY E FAILED%' THEN RAISE; END IF;
    refused := refused + 1;
  END;

  IF refused <> 6 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: expected 6 refusals, observed %', refused;
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: items are append-only, deduped per run, reason-bearing, and run-scoped.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- VERIFY F — dedup actually prevents duplicate legal_updates, while genuine
-- change detection on a stable URL still works.
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  src_a uuid;
  src_b uuid;
  refused int := 0;
  url_rows int;
BEGIN
  INSERT INTO public.regulatory_sources (name, jurisdiction, source_type, url)
  VALUES ('VERIFY25 fixture source F1', 'TH', 'government_regulator', 'https://verify25f1.example.gov/feed.xml')
  RETURNING id INTO src_a;
  INSERT INTO public.regulatory_sources (name, jurisdiction, source_type, url)
  VALUES ('VERIFY25 fixture source F2', 'TH', 'government_regulator', 'https://verify25f2.example.gov/feed.xml')
  RETURNING id INTO src_b;

  INSERT INTO public.legal_updates
    (source_id, title, jurisdiction, content_hash, canonical_url, external_document_id)
  VALUES (src_a, 'VERIFY25 notice', 'TH', repeat('d', 64), 'https://verify25f1.example.gov/n/1', 'DOC-1');

  -- F1: identical content is refused globally, even from a different source
  -- (the same notice mirrored on two sites must become ONE record).
  BEGIN
    INSERT INTO public.legal_updates (source_id, title, jurisdiction, content_hash)
    VALUES (src_b, 'VERIFY25 mirrored notice', 'TH', repeat('d', 64));
    RAISE EXCEPTION 'VERIFY F FAILED: duplicate content_hash was accepted';
  EXCEPTION WHEN unique_violation THEN refused := refused + 1;
  END;

  -- F2: the publisher's own document id is unique per source.
  BEGIN
    INSERT INTO public.legal_updates
      (source_id, title, jurisdiction, content_hash, external_document_id)
    VALUES (src_a, 'VERIFY25 same doc id', 'TH', repeat('e', 64), 'DOC-1');
    RAISE EXCEPTION 'VERIFY F FAILED: duplicate (source_id, external_document_id) was accepted';
  EXCEPTION WHEN unique_violation THEN refused := refused + 1;
  END;

  IF refused <> 2 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: expected 2 refusals, observed %', refused;
  END IF;

  -- F3: a DIFFERENT source may reuse the same document id (numbering schemes
  -- collide across authorities) — this must be accepted.
  INSERT INTO public.legal_updates
    (source_id, title, jurisdiction, content_hash, external_document_id)
  VALUES (src_b, 'VERIFY25 other authority DOC-1', 'TH', repeat('f', 64), 'DOC-1');

  -- F4: the SAME canonical URL with NEW content must be accepted — this is the
  -- change-detection path, and uniqueness on the URL alone would suppress it.
  INSERT INTO public.legal_updates
    (source_id, title, jurisdiction, content_hash, canonical_url)
  VALUES (src_a, 'VERIFY25 notice (revised)', 'TH', repeat('1', 64), 'https://verify25f1.example.gov/n/1');

  SELECT count(*) INTO url_rows FROM public.legal_updates
  WHERE canonical_url = 'https://verify25f1.example.gov/n/1';
  IF url_rows <> 2 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: expected 2 revisions on one canonical_url, observed %', url_rows;
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: content/document-id dedup enforced; URL revisions still recordable.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- VERIFY G — backward compatibility: manually pasted legal updates, which carry
-- no provenance at all, are completely unaffected by the new dedup indexes.
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  manual_rows int;
  bad_cols text[] := ARRAY[]::text[];
  c text;
BEGIN
  -- Several provenance-free rows must coexist: the partial indexes must not
  -- collapse them (NULL is not equal to NULL, and the WHERE clause excludes
  -- them entirely).
  INSERT INTO public.legal_updates (title, jurisdiction, raw_text)
  VALUES ('VERIFY25 manual paste 1', 'CZ', 'pasted text one');
  INSERT INTO public.legal_updates (title, jurisdiction, raw_text)
  VALUES ('VERIFY25 manual paste 2', 'CZ', 'pasted text two');

  SELECT count(*) INTO manual_rows FROM public.legal_updates
  WHERE title LIKE 'VERIFY25 manual paste%';
  IF manual_rows <> 2 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: provenance-free rows did not both persist (observed %)', manual_rows;
  END IF;

  -- Every added column must be nullable, or an existing writer would break.
  FOR c IN SELECT unnest(ARRAY['content_hash','canonical_url','external_document_id',
                               'source_tier','ingestion_run_id','ingestion_item_key'])
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='legal_updates'
        AND column_name = c AND is_nullable = 'NO'
    ) THEN bad_cols := bad_cols || c; END IF;
  END LOOP;

  IF array_length(bad_cols,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY G FAILED: migration 25 made these columns NOT NULL: %',
      array_to_string(bad_cols, ', ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: manual (provenance-free) legal updates are unaffected.';
END
$verify_g$;

-- -----------------------------------------------------------------------------
-- VERIFY H — an item may only claim to have created a legal_update when its
-- decision was 'new'.
-- -----------------------------------------------------------------------------
DO $verify_h$
DECLARE
  src_id uuid;
  run_id uuid;
  lu_id uuid;
BEGIN
  INSERT INTO public.regulatory_sources (name, jurisdiction, source_type, url)
  VALUES ('VERIFY25 fixture source H', 'TH', 'government_regulator', 'https://verify25h.example.gov/feed.xml')
  RETURNING id INTO src_id;

  INSERT INTO public.watchtower_ingestion_runs (source_id, connector_kind)
  VALUES (src_id, 'rss') RETURNING id INTO run_id;

  INSERT INTO public.legal_updates (source_id, title, jurisdiction, content_hash, ingestion_run_id)
  VALUES (src_id, 'VERIFY25 candidate', 'TH', repeat('2', 64), run_id)
  RETURNING id INTO lu_id;

  -- The candidate must have been created in draft/new status only.
  IF (SELECT status FROM public.legal_updates WHERE id = lu_id) <> 'new' THEN
    RAISE EXCEPTION 'VERIFY H FAILED: candidate legal_update did not default to status new';
  END IF;

  BEGIN
    INSERT INTO public.watchtower_ingestion_items
      (run_id, source_id, item_key, content_hash, dedup_decision, legal_update_id)
    VALUES (run_id, src_id, src_id || '::h1', repeat('2', 64), 'duplicate_content_hash', lu_id);
    RAISE EXCEPTION 'VERIFY H FAILED: a non-new item claimed to have created a legal_update';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- The legitimate shape is accepted.
  INSERT INTO public.watchtower_ingestion_items
    (run_id, source_id, item_key, content_hash, dedup_decision, legal_update_id)
  VALUES (run_id, src_id, src_id || '::h2', repeat('2', 64), 'new', lu_id);

  RAISE NOTICE 'VERIFY H PASSED: only a new decision may be linked to a created legal_update.';
END
$verify_h$;

DO $done$
BEGIN
  RAISE NOTICE '=== MIGRATION 25 VERIFY: ALL SECTIONS PASSED (A-H). Rolling back all fixtures. ===';
END
$done$;

ROLLBACK;
