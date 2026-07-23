-- Negative-scenario apply file (harness self-test asset — NOT a migration).
--
-- Applied against a REAL disposable PostgreSQL cluster to prove the harness
-- catches a genuine runtime apply failure (non-zero exit + retained evidence),
-- not merely a mocked one. The RAISE below aborts under ON_ERROR_STOP=1 exactly
-- as a broken real migration would.
DO $$
BEGIN
  RAISE EXCEPTION 'negative-scenario: intentional apply failure to prove the harness fails closed';
END $$;
