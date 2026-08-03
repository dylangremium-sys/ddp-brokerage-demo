/**
 * Test setup for AI modules
 * 
 * Provides mocked Supabase client and test utilities.
 * Uses in-memory mock when real credentials are not available.
 */

import { describe, beforeEach, afterEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Mock Supabase client for testing
 * Simulates basic CRUD operations without hitting a real database
 */
export class MockSupabaseClient {
  private data: Record<string, any[]> = {
    ai_jobs: [],
    ai_job_attempts: [],
    ai_usage_metrics: [],
    ai_cost_alerts: [],
    ai_budget_caps: [],
    ai_audit_events: [],
    ai_human_reviews: [],
    prompt_templates: [],
    prompt_versions: [],
    prompt_experiments: [],
  };

  from(tableName: string) {
    return {
      insert: (records: any[]) => ({
        select: (cols?: string) => ({
          single: async () => {
            if (!records.length) {
              return { data: null, error: new Error('No records') };
            }
            const record = { id: Math.random().toString(36).slice(2), ...records[0] };
            this.data[tableName] = this.data[tableName] || [];
            this.data[tableName].push(record);
            return { data: cols ? { id: record.id } : record, error: null };
          },
          then: async (cb: Function) => {
            if (!records.length) {
              return { data: [], error: new Error('No records') };
            }
            const inserted = records.map((r) => ({
              id: Math.random().toString(36).slice(2),
              ...r,
            }));
            this.data[tableName] = this.data[tableName] || [];
            this.data[tableName].push(...inserted);
            return cb({ data: inserted, error: null });
          },
        }),
        then: async (cb: Function) => {
          if (!records.length) {
            return { data: [], error: new Error('No records') };
          }
          const inserted = records.map((r) => ({
            id: Math.random().toString(36).slice(2),
            ...r,
          }));
          this.data[tableName] = this.data[tableName] || [];
          this.data[tableName].push(...inserted);
          return cb({ data: inserted, error: null });
        },
      }),
      select: (cols?: string) => ({
        eq: (col: string, val: any) => ({
          single: async () => {
            const record = this.data[tableName]?.find((r) => r[col] === val);
            return { data: record || null, error: record ? null : new Error('Not found') };
          },
          then: async (cb: Function) => {
            const records = this.data[tableName]?.filter((r) => r[col] === val) || [];
            return cb({ data: records, error: null });
          },
        }),
        then: async (cb: Function) => {
          return cb({ data: this.data[tableName] || [], error: null });
        },
      }),
      update: (updates: any) => ({
        eq: (col: string, val: any) => ({
          then: async (cb: Function) => {
            const found = this.data[tableName]?.find((r) => r[col] === val);
            if (found) {
              Object.assign(found, updates);
              return cb({ data: found, error: null });
            }
            return cb({ data: null, error: new Error('Not found') });
          },
        }),
      }),
      delete: () => ({
        eq: (col: string, val: any) => ({
          then: async (cb: Function) => {
            const idx = this.data[tableName]?.findIndex((r) => r[col] === val);
            if (idx !== undefined && idx > -1) {
              this.data[tableName].splice(idx, 1);
              return cb({ data: {}, error: null });
            }
            return cb({ data: null, error: new Error('Not found') });
          },
        }),
      }),
    };
  }

  rpc(funcName: string, params?: any) {
    return {
      then: async (cb: Function) => {
        // Mock RLS checking function
        if (funcName === 'has_farm_membership') {
          return cb({
            data: params?.p_farm_id === 'farm-user-farm' ? true : false,
            error: null,
          });
        }
        return cb({ data: null, error: new Error(`Unknown function: ${funcName}`) });
      },
    };
  }

  getTable(tableName: string) {
    return this.data[tableName] || [];
  }

  clear() {
    this.data = {
      ai_jobs: [],
      ai_job_attempts: [],
      ai_usage_metrics: [],
      ai_cost_alerts: [],
      ai_budget_caps: [],
      ai_audit_events: [],
      ai_human_reviews: [],
      prompt_templates: [],
      prompt_versions: [],
      prompt_experiments: [],
    };
  }
}

/**
 * Create a mock Supabase client for testing
 */
export function createMockSupabaseClient(): MockSupabaseClient {
  return new MockSupabaseClient();
}

/**
 * Test context helpers
 */
export const testContext = {
  /**
   * Set test mode environment variables
   */
  enableTestMode: () => {
    process.env.VITEST_MODE = 'true';
    process.env.AI_PROVIDER_MODE = 'mock';
  },

  /**
   * Clean up test mode
   */
  disableTestMode: () => {
    delete process.env.VITEST_MODE;
    delete process.env.AI_PROVIDER_MODE;
  },
};
