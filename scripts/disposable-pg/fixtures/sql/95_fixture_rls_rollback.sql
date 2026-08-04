-- Deliberately defective ROLLBACK: it disables RLS on the WRONG table.
--
-- public.farms already has RLS disabled, so this statement succeeds and changes
-- nothing, leaving public.profiles with RLS still enabled. Exits 0.

ALTER TABLE public.farms DISABLE ROW LEVEL SECURITY;
