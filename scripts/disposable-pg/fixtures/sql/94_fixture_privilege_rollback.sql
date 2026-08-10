-- Deliberately defective ROLLBACK: it revokes a privilege from the WRONG table.
--
-- REVOKE on a privilege that was never granted is not an error, so this exits 0
-- while `anon` keeps DELETE on public.profiles. Only a snapshot that records
-- privileges sees it.

REVOKE DELETE ON public.farms FROM anon;
