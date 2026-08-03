/**
 * aiJobQueue.ts
 * 
 * Async job queue for AI processing.
 * Manages job lifecycle: pending → processing → completed/failed/timeout.
 * Phase 0: Foundation (poll-based, no background workers yet)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface AIJob {
  id: string;
  farm_id: string;
  feature_code: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'timeout';
  input_payload: Record<string, unknown>;
  output_payload?: Record<string, unknown>;
  error_message?: string;
  created_at: string;
  updated_at: string;
  requires_human_review: boolean;
}

/**
 * Async job queue
 */
export class AIJobQueue {
  private supabaseClient: SupabaseClient | null = null;
  private isTestMode = false;

  constructor(supabaseUrl?: string, serviceRoleKey?: string) {
    // Check if in test/mock mode
    if (process.env.AI_PROVIDER_MODE === 'mock' || 
        process.env.VITEST_MODE === 'true' ||
        !supabaseUrl && !process.env.SUPABASE_URL) {
      this.isTestMode = true;
      return;
    }

    const url = supabaseUrl || process.env.SUPABASE_URL;
    const key = serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (url && key) {
      this.supabaseClient = createClient(url, key);
    }
  }

  /**
   * Submit a new job
   */
  async submitJob(
    farmId: string,
    featureCode: string,
    inputPayload: Record<string, unknown>,
    requiresReview: boolean = true
  ): Promise<string> {
    if (this.isTestMode) {
      // Return mock job ID in test mode
      return `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    if (!this.supabaseClient) {
      throw new Error('Supabase client not configured');
    }

    const { data, error } = await this.supabaseClient
      .from('ai_jobs')
      .insert([
        {
          farm_id: farmId,
          feature_code: featureCode,
          status: 'pending',
          input_payload: inputPayload,
          requires_human_review: requiresReview,
        },
      ])
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to submit job: ${error.message}`);
    }

    return data.id;
  }

  /**
   * Get job by ID
   */
  async getJob(jobId: string): Promise<AIJob | null> {
    if (this.isTestMode) {
      // Return mock job in test mode
      return {
        id: jobId,
        farm_id: 'farm-test',
        feature_code: 'test-feature',
        status: 'completed',
        input_payload: {},
        output_payload: { result: 'mock' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        requires_human_review: false,
      };
    }

    if (!this.supabaseClient) {
      return null;
    }

    const { data } = await this.supabaseClient
      .from('ai_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    return data || null;
  }

  /**
   * Process a pending job (placeholder for Phase 1)
   */
  async processJob(
    jobId: string,
    _provider: string,
    _model: string,
    _systemPrompt: string,
    _userPrompt: string
  ): Promise<void> {
    if (this.isTestMode) {
      return; // No-op in test mode
    }

    if (!this.supabaseClient) {
      throw new Error('Supabase client not configured');
    }

    // Update status to processing
    await this.supabaseClient
      .from('ai_jobs')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', jobId);

    // TODO: Call AI &provider, store result
  }

  /**
   * Poll for jobs (Phase 0 background processing)
   */
  async pollPendingJobs(limit: number = 10): Promise<AIJob[]> {
    if (this.isTestMode) {
      return []; // No jobs in test mode
    }

    if (!this.supabaseClient) {
      return [];
    }

    const { data } = await this.supabaseClient
      .from('ai_jobs')
      .select('*')
      .eq('status', 'pending')
      .limit(limit);

    return data || [];
  }

  /**
   * Start polling for jobs (Phase 0 background worker)
   */
  startPolling(intervalMs: number = 5000): NodeJS.Timer {
    if (this.isTestMode) {
      return setInterval(() => {}, intervalMs); // Dummy timer in test mode
    }

    return setInterval(() => {
      this.pollPendingJobs().catch(err => console.error('Poll error:', err));
    }, intervalMs);
  }
}
