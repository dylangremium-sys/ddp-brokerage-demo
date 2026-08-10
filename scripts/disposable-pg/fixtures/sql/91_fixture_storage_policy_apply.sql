-- Harness self-proof fixture (negative scenario) — storage-schema blindness.
--
-- Migration 38 creates its RLS policies on storage.objects, not on a table in
-- public. A catalog sweep scoped to `public` observes nothing at all for that
-- migration: it measured 15 -> 15 -> 15 objects, so a rollback removing none of
-- the policies would still have been reported symmetric.
--
-- This stage creates a policy on storage.objects. Its rollback removes nothing.

CREATE POLICY "fixture: storage leak probe"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (true);
