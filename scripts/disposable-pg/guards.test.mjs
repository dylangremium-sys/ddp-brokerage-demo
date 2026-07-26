import { describe, it, expect } from 'vitest';
import {
  isTcpTarget,
  detectRemoteTargets,
  assertNoRemoteTargets,
  assertSocketOnlyConnection,
  assertListenAddressesEmpty,
  GuardError,
  FORBIDDEN_PROJECT_REFS,
} from './lib/guards.mjs';

describe('isTcpTarget', () => {
  it('treats absolute socket paths as NOT tcp', () => {
    expect(isTcpTarget('/tmp/dpg-abc')).toBe(false);
    expect(isTcpTarget('/var/run/postgresql')).toBe(false);
  });
  it('flags hostnames, host= params, urls and supabase hosts', () => {
    expect(isTcpTarget('db.example.com:5432')).toBe(true);
    expect(isTcpTarget('host=db.internal port=5432')).toBe(true);
    expect(isTcpTarget('postgres://user:pass@db.host/postgres')).toBe(true);
    expect(isTcpTarget('https://szqocdabwkjrggrddocx.supabase.co')).toBe(true);
    expect(isTcpTarget('hostaddr=10.0.0.1')).toBe(true);
  });
  it('treats a libpq url with a socket host as NOT tcp', () => {
    expect(isTcpTarget('postgresql:///harness?host=/tmp/dpg-abc')).toBe(false);
    expect(isTcpTarget('postgres://%2Ftmp%2Fdpg/harness')).toBe(false);
  });
  it('is empty-safe', () => {
    expect(isTcpTarget('')).toBe(false);
    expect(isTcpTarget(null)).toBe(false);
    expect(isTcpTarget(undefined)).toBe(false);
  });
});

describe('detectRemoteTargets / assertNoRemoteTargets', () => {
  it('flags staging/production DSN env vars', () => {
    const env = { STAGING_DATABASE_URL: 'postgres://x:y@db/postgres' };
    expect(detectRemoteTargets(env).length).toBeGreaterThan(0);
    expect(() => assertNoRemoteTargets(env)).toThrow(GuardError);
  });
  it('flags a SUPABASE_URL', () => {
    expect(() => assertNoRemoteTargets({ SUPABASE_URL: 'https://x.supabase.co' })).toThrow(GuardError);
  });
  it('flags any env value referencing a forbidden project ref', () => {
    for (const ref of FORBIDDEN_PROJECT_REFS) {
      expect(() => assertNoRemoteTargets({ SOME_VAR: `conn to ${ref}` })).toThrow(GuardError);
    }
  });
  it('flags PGHOST only when it is a TCP host, not a socket dir', () => {
    expect(detectRemoteTargets({ PGHOST: 'db.example.com' }).length).toBe(1);
    expect(detectRemoteTargets({ PGHOST: '/tmp/dpg-abc' }).length).toBe(0);
  });
  it('passes a clean environment', () => {
    expect(detectRemoteTargets({ PATH: '/usr/bin', HOME: '/home/x' })).toEqual([]);
    expect(() => assertNoRemoteTargets({ PATH: '/usr/bin' })).not.toThrow();
  });
});

describe('assertSocketOnlyConnection', () => {
  it('accepts a socket dir under the temp root', () => {
    expect(assertSocketOnlyConnection({ host: '/tmp/dpg-abc', port: 5432 }, { tmpRoot: '/tmp' })).toBe(true);
  });
  it('rejects a tcp host', () => {
    expect(() => assertSocketOnlyConnection({ host: 'db.example.com', port: 5432 })).toThrow(GuardError);
  });
  it('rejects a socket dir outside the temp root', () => {
    expect(() => assertSocketOnlyConnection({ host: '/opt/sock', port: 5432 }, { tmpRoot: '/tmp' })).toThrow(GuardError);
  });
  it('rejects a tcp-marked connection', () => {
    expect(() => assertSocketOnlyConnection({ host: '/tmp/x', port: 5432, tcp: true }, { tmpRoot: '/tmp' })).toThrow(GuardError);
  });
});

describe('assertListenAddressesEmpty', () => {
  it('passes for empty', () => {
    expect(assertListenAddressesEmpty('')).toBe(true);
    expect(assertListenAddressesEmpty('   ')).toBe(true);
  });
  it('throws when a TCP listener is configured', () => {
    expect(() => assertListenAddressesEmpty('localhost')).toThrow(GuardError);
    expect(() => assertListenAddressesEmpty('*')).toThrow(GuardError);
  });
});
