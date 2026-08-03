-- Deliberately defective ROLLBACK: it drops a policy that was never created,
-- which succeeds, and leaves the real one on storage.objects in place.
--
-- Exits 0. Only a catalog sweep that includes the storage schema sees the leak.

DROP POLICY IF EXISTS "fixture: a policy that never existed" ON storage.objects;
