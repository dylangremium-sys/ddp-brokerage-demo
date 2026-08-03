/**
 * aiCostTracker.ts
 * 
 * Cost tracking and budget enforcement.
 * Records token usage, tracks spending, enforces budget caps.
 * Phase 0: Foundation (mock provider, zero cost)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface UsageMetric {
  farmId: string;
  featureCode: string;
  date: string;
  jobs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Cost tracking and budget enforcement
 */
export class AICostTracker {
  private supabaseClient: SupabaseClient | null = null;
  private readonly ALERT_THRESHOLD = 0.80; // 80% = alert
  private readonly SOFT_STOP_THRESHOLD = 0.90; // 90% = soft stop
  private readonly HARD_STOP_THRESHOLD = 1.0; // 100% = hard stop
  private isTestMode = false;

  constructor(supabaseUrl?: string, serviceRoleKey?: string) {
    // Check if in test/mock mode
    if (process.env.AI_PROVIDER_MODE === 'mock' || 
        process.env.VITEST_MODE === 'true' ||
        !supabaseUrl && !process.env.SUPABASE_URL) {
      this.isTestMode = true;
      return;
    }

    // Lazy load Supabase client only if needed
    const url = supabaseUrl || process.env.SUPABASE_URL;
    const key = serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (url && key) {
      this.supabaseClient = createClient(url, key);
    }
  }

  /**
   * Record token usage and update metrics
   */
  async recordUsage(
    farmId: string,
    featureCode: string,
    totalTokens: number,
    costUsd: number
  ): Promise<void> {
    if (this.isTestMode || !this.supabaseClient) {
      return; // No-op in test mode
    }

    const today = new Date().toISOString().split('T')[0];

    // Upsert daily metrics
    const { error } = await this.supabaseClient
      .from('ai_usage_metrics')
      .upsert([
        {
          farm_id: farmId,
          feature_code: featureCode,
          date_bucket: today,
          jobs_completed: 1,
          total_input_tokens: 0, // TODO: separate input/output
          total_output_tokens: 0,
          total_cost_usd: costUsd,
        },
      ]);

    if (error) {
      console.error('Failed to record usage:', error);
    }
  }

  /**
   * Get cost summary for a farm
   */
  async getCostSummary(
    farmId: string,
    periodDays: number = 30
  ): Promise<{ spent: number; budget: number; remaining: number; percentUsed: number }> {
    if (this.isTestMode || !this.supabaseClient) {
      return { spent: 0, budget: 5000, remaining: 5000, percentUsed: 0 };
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // Fetch usage metrics
    const { data: metrics } = await this.supabaseClient
      .from('ai_usage_metrics')
      .select('total_cost_usd')
      .eq('farm_id', farmId)
      .gte('date_bucket', startDate.toISOString().split('T')[0]);

    const spent = (metrics || []).reduce((sum, m) => sum + (m.total_cost_usd || 0), 0);

    // Fetch budget cap
    const { data: budgetData } = await this.supabaseClient
      .from('ai_budget_caps')
      .select('monthly_budget_usd')
      .eq('farm_id', farmId)
      .single();

    const budget = budgetData?.monthly_budget_usd || 5000;
    const remaining = Math.max(0, budget - spent);
    const percentUsed = budget > 0 ? (spent / budget) * 100 : 0;

    return { spent, budget, remaining, percentUsed };
  }

  /**
   * Check if farm can submit new job
   */
  async canSubmitJob(farmId: string): Promise<boolean> {
    if (this.isTestMode) {
      return true; // Always allow in test mode
    }

    const summary = await this.getCostSummary(farmId);
    return summary.percentUsed < this.SOFT_STOP_THRESHOLD * 100;
  }

  /**
   * Estimate cost for a job
   */
  async estimateJobCost(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<number> {
    if (this.isTestMode || !this.supabaseClient) {
      return 0; // No cost in test mode
    }

    // Fetch pricing from database
    const { data } = await this.supabaseClient
      .from('ai_provider_pricing')
      .select('input_cost_per_million, output_cost_per_million')
      .eq('provider', provider)
      .eq('model', model)
      .single();

    if (!data) {
      // Fallback pricing
      return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
    }

    return (
      (inputTokens * data.input_cost_per_million +
        outputTokens * data.output_cost_per_million) /
      1_000_000
    );
  }
}
