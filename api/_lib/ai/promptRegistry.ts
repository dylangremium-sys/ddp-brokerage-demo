/**
 * promptRegistry.ts
 * 
 * Prompt template registry and versioning.
 * Manages prompt versions, A/B testing, and guardrail enforcement.
 * 
 * Phase 0: Foundations
 */

import { createClient } from '@supabase/supabase-js';

export interface PromptTemplate {
  id: string;
  promptKey: string;
  featureCode: string;
  actionType: string;
  currentVersion: number;
  systemPrompt: string;
  userPromptTemplate: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  temperature: number;
  guardrails: string[];
  allowedModels: string[];
  isActive: boolean;
}

export interface PromptVersion {
  version: number;
  systemPrompt: string;
  userPromptTemplate: string;
  temperature: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  guardrails: string[];
  changeReason?: string;
  changedBy?: string;
  createdAt: string;
}

/**
 * Prompt registry and versioning
 */
export class PromptRegistry {
  private supabaseClient: ReturnType<typeof createClient>;
  private cache: Map<string, PromptTemplate> = new Map();

  constructor(supabaseUrl?: string, supabaseKey?: string) {
    this.supabaseClient = createClient(
      supabaseUrl || process.env.SUPABASE_URL || '',
      supabaseKey || process.env.SUPABASE_ANON_KEY || ''
    );
  }

  /**
   * Get active prompt for a feature
   */
  async getPrompt(featureCode: string): Promise<PromptTemplate | null> {
    // Check cache first
    const cacheKey = `prompt:${featureCode}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) || null;
    }

    const { data, error } = await this.supabaseClient
      .from('ai_prompts')
      .select('*')
      .eq('feature_code', featureCode)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return null;
    }

    const prompt = this.mapDbToPrompt(data);
    this.cache.set(cacheKey, prompt);
    return prompt;
  }

  /**
   * Get all versions of a prompt
   */
  async getPromptVersions(promptId: string): Promise<PromptVersion[]> {
    const { data, error } = await this.supabaseClient
      .from('ai_prompt_versions')
      .select('*')
      .eq('prompt_id', promptId)
      .order('version_number', { ascending: true });

    if (error || !data) {
      return [];
    }

    return data.map((row: any) => ({
      version: row.version_number,
      systemPrompt: row.system_prompt,
      userPromptTemplate: row.user_prompt_template,
      temperature: row.temperature,
      maxInputTokens: row.max_input_tokens,
      maxOutputTokens: row.max_output_tokens,
      guardrails: row.guardrails || [],
      changeReason: row.change_reason,
      changedBy: row.changed_by,
      createdAt: row.created_at,
    }));
  }

  /**
   * Create a new prompt version
   */
  async createPromptVersion(
    promptId: string,
    systemPrompt: string,
    userPromptTemplate: string,
    options?: {
      temperature?: number;
      maxInputTokens?: number;
      maxOutputTokens?: number;
      guardrails?: string[];
      changeReason?: string;
      changedBy?: string;
    }
  ): Promise<PromptVersion> {
    // Get current prompt to find next version number
    const { data: current } = await this.supabaseClient
      .from('ai_prompts')
      .select('current_version')
      .eq('id', promptId)
      .single();

    const nextVersion = (current?.current_version || 0) + 1;

    // Insert new version
    const { error: versionError } = await this.supabaseClient
      .from('ai_prompt_versions')
      .insert([
        {
          prompt_id: promptId,
          version_number: nextVersion,
          system_prompt: systemPrompt,
          user_prompt_template: userPromptTemplate,
          temperature: options?.temperature ?? 0.2,
          max_input_tokens: options?.maxInputTokens,
          max_output_tokens: options?.maxOutputTokens,
          guardrails: options?.guardrails || [],
          change_reason: options?.changeReason,
          changed_by: options?.changedBy,
        },
      ]);

    if (versionError) {
      throw new Error(`Failed to create prompt version: ${versionError.message}`);
    }

    // Update current version in prompt
    const { error: updateError } = await this.supabaseClient
      .from('ai_prompts')
      .update({ current_version: nextVersion })
      .eq('id', promptId);

    if (updateError) {
      throw new Error(`Failed to update prompt version: ${updateError.message}`);
    }

    // Clear cache
    this.cache.clear();

    return {
      version: nextVersion,
      systemPrompt,
      userPromptTemplate,
      temperature: options?.temperature ?? 0.2,
      maxInputTokens: options?.maxInputTokens,
      maxOutputTokens: options?.maxOutputTokens,
      guardrails: options?.guardrails || [],
      changeReason: options?.changeReason,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Validate prompt against guardrails
   */
  validateGuardrails(prompt: PromptTemplate): { valid: boolean; violations: string[] } {
    const violations: string[] = [];

    // Check for dangerous terms
    const dangerousTerms = [
      'is compliant',
      'is verified',
      'is approved',
      'is certified',
      'is safe',
      'guaranteed',
      'conclusive',
    ];

    const lowerPrompt = (prompt.systemPrompt + ' ' + prompt.userPromptTemplate).toLowerCase();

    for (const term of dangerousTerms) {
      if (lowerPrompt.includes(term)) {
        violations.push(`Found dangerous term: "${term}"`);
      }
    }

    // Check required guardrails
    const requiredGuardrails = ['no_compliance_claims', 'cite_sources'];
    for (const guardrail of requiredGuardrails) {
      if (!prompt.guardrails.includes(guardrail)) {
        violations.push(`Missing required guardrail: ${guardrail}`);
      }
    }

    return {
      valid: violations.length === 0,
      violations,
    };
  }

  /**
   * Apply guardrails to an AI response
   */
  async applyGuardrails(
    response: string,
    guardrails: string[],
    featureCode: string
  ): Promise<{ cleaned: string; flagged: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    let cleaned = response;
    let flagged = false;

    // Check for compliance claims
    if (guardrails.includes('no_compliance_claims')) {
      const complianceTerms = [
        /is\s+compliant/gi,
        /is\s+verified/gi,
        /is\s+approved/gi,
        /is\s+certified/gi,
        /is\s+safe/gi,
        /guaranteed/gi,
      ];

      for (const term of complianceTerms) {
        if (term.test(response)) {
          flagged = true;
          reasons.push(`Blocked compliance claim: ${term.source}`);
          cleaned = cleaned.replace(term, '[COMPLIANCE_CLAIM_BLOCKED]');
        }
      }
    }

    // Check for source citations
    if (guardrails.includes('cite_sources')) {
      if (featureCode === 'watchtower_ai' && !response.includes('source') && !response.includes('Source')) {
        flagged = true;
        reasons.push('Missing source citation for watchtower summary');
      }
    }

    // Check for hallucination markers
    if (guardrails.includes('no_hallucination')) {
      if (response.includes('I assume') || response.includes('probably') || response.includes('likely')) {
        flagged = true;
        reasons.push('Response contains speculative language (hallucination risk)');
      }
    }

    return {
      cleaned,
      flagged,
      reasons,
    };
  }

  /**
   * Run A/B test for prompt variants
   */
  async setupABTest(
    controlPromptId: string,
    variantPromptId: string,
    experimentName: string,
    splitPercent: number = 50,
    endDate?: Date
  ): Promise<string> {
    const { data, error } = await this.supabaseClient
      .from('ai_prompt_experiments')
      .insert([
        {
          prompt_id: controlPromptId,
          variant_prompt_id: variantPromptId,
          experiment_name: experimentName,
          experiment_start_date: new Date().toISOString().split('T')[0],
          experiment_end_date: endDate ? endDate.toISOString().split('T')[0] : null,
          control_model: 'claude-opus-5',
          variant_model: 'claude-sonnet-5',
          split_percent: splitPercent,
        },
      ])
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to create A/B test: ${error.message}`);
    }

    return data?.id || '';
  }

  /**
   * Get A/B test results
   */
  async getABTestResults(experimentId: string): Promise<any> {
    const { data, error } = await this.supabaseClient
      .from('ai_prompt_experiments')
      .select('*')
      .eq('id', experimentId)
      .single();

    if (error || !data) {
      return null;
    }

    return {
      experimentName: data.experiment_name,
      controlSampleSize: data.control_sample_size,
      variantSampleSize: data.variant_sample_size,
      controlApprovalRate: data.control_human_approval_rate,
      variantApprovalRate: data.variant_human_approval_rate,
      controlAvgCost: data.control_avg_cost_usd,
      variantAvgCost: data.variant_avg_cost_usd,
      winner: data.winner,
      winnerReason: data.winner_reason,
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ========================================================================
  // Private Helpers
  // ========================================================================

  private mapDbToPrompt(data: any): PromptTemplate {
    return {
      id: data.id,
      promptKey: data.prompt_key,
      featureCode: data.feature_code,
      actionType: data.action_type,
      currentVersion: data.current_version,
      systemPrompt: data.system_prompt,
      userPromptTemplate: data.user_prompt_template,
      description: data.description,
      inputSchema: data.input_schema,
      outputSchema: data.output_schema,
      maxInputTokens: data.max_input_tokens,
      maxOutputTokens: data.max_output_tokens,
      temperature: data.temperature,
      guardrails: data.guardrails || [],
      allowedModels: data.allowed_models || [],
      isActive: data.is_active,
    };
  }
}

// Export singleton
export const promptRegistry = new PromptRegistry();
