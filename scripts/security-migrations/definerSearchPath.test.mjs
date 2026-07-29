import { describe, it, expect } from 'vitest'
import { findMutableSearchPathDefiners } from './definerSearchPath.mjs'

const TOKEN = 'ACL-TEST-EXEMPT: INTENTIONAL-DRAFT'
const opts = { exemptionToken: TOKEN }

describe('findMutableSearchPathDefiners (DDP audit F1)', () => {
  it('FLAGS a SECURITY DEFINER function with no pinned search_path', () => {
    const files = [{
      name: 'BASELINE.sql',
      body: 'CREATE OR REPLACE FUNCTION is_ddp_admin()\nRETURNS BOOLEAN\nLANGUAGE sql\nSECURITY DEFINER\nSTABLE\nAS $$ SELECT true $$;',
    }]
    expect(findMutableSearchPathDefiners(files, opts)).toEqual([{ file: 'BASELINE.sql', fn: 'is_ddp_admin' }])
  })

  it('does NOT flag a SECURITY DEFINER function that pins search_path', () => {
    const files = [{
      name: 'BASELINE.sql',
      body: 'CREATE OR REPLACE FUNCTION is_ddp_admin()\nRETURNS BOOLEAN\nLANGUAGE sql\nSECURITY DEFINER\nSTABLE\nSET search_path = public, auth, pg_temp\nAS $$ SELECT true $$;',
    }]
    expect(findMutableSearchPathDefiners(files, opts)).toEqual([])
  })

  it('does NOT flag a SECURITY INVOKER (default) function', () => {
    const files = [{ name: 'x.sql', body: 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;' }]
    expect(findMutableSearchPathDefiners(files, opts)).toEqual([])
  })

  it('separates multiple functions in one file (only the unpinned one is flagged)', () => {
    const files = [{
      name: 'two.sql',
      body: [
        'CREATE FUNCTION good() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT 1 $$;',
        'CREATE FUNCTION bad() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;',
      ].join('\n'),
    }]
    expect(findMutableSearchPathDefiners(files, opts)).toEqual([{ file: 'two.sql', fn: 'bad' }])
  })

  it('ignores *_VERIFY.sql scaffolding and token-exempt drafts', () => {
    const unpinned = 'CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;'
    const files = [
      { name: '19_X_VERIFY.sql', body: unpinned },
      { name: 'DRAFT.sql', body: `-- ${TOKEN}\n${unpinned}` },
    ]
    expect(findMutableSearchPathDefiners(files, opts)).toEqual([])
  })

  it('does not treat a commented-out definer definition as real code', () => {
    const files = [{ name: 'x.sql', body: '-- CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;' }]
    expect(findMutableSearchPathDefiners(files, opts)).toEqual([])
  })
})
