/**
 * aiProviderRouter.ts
 * 
 * AI Provider abstraction layer.
 * Handles provider selection, fallback routing, and model instantiation.
 * Supports: Anthropic, Azure OpenAI, local Ollama, mock for testing.
 * 
 * Phase 0: Foundations
 */

import { createClient } from '@supabase/supabase-js';
// Anthropic SDK is dynamically imported when needed (Phase 1+)

export type ProviderType = 'anthropic' | 'azure' | 'ollama' | 'mock';
export type ModelName = string;

export interface ProviderConfig {
  primaryProvider: ProviderType;
  primaryModel: ModelName;
  fallbackProvider?: ProviderType;
  fallbackModel?: ModelName;
  maxRetries: number;
  timeoutSeconds: number;
}

export interface AIRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
}

export interface AIResponse {
  content: string;
  provider: ProviderType;
  model: ModelName;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  stopReason: string;
  confidence?: number;
}

export interface AICallOptions {
  config: ProviderConfig;
  request: AIRequest;
  jobId: string;
  attemptNumber: number;
}

// ============================================================================
// Anthropic Provider (requires @anthropic-ai/sdk in Phase 1+)
// ============================================================================

interface AnthropicClient {
  messages: {
    create: (params: unknown) => Promise<unknown>;
  };
}

class AnthropicProvider {
  private client: AnthropicClient | null = null;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private async loadAnthropicClient(): Promise<AnthropicClient> {
    if (this.client) return this.client;
    
    try {
      // Dynamic import - fails gracefully if SDK not installed (Phase 0)
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        timeout: (this.config.timeoutSeconds || 30) * 1000,
      });
      return this.client;
    } catch (err) {
      throw new Error(
        `Anthropic SDK not installed. Install with: npm install @anthropic-ai/sdk (Phase 1 requirement). Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async call(options: AICallOptions): Promise<AIResponse> {
    const client = await this.loadAnthropicClient();
    
    try {
      const response = await (client.messages.create as (params: any) => Promise<any>)({
        model: this.config.primaryModel,
        max_tokens: options.request.maxTokens || 2000,
        system: options.request.systemPrompt,
        messages: [
          {
            role: 'user',
            content: options.request.userPrompt,
          },
        ],
        temperature: options.request.temperature || 0.7,
      });

      const firstContent = response.content[0];
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;

      return {
        content: firstContent.type === 'text' ? firstContent.text : '',
        provider: 'anthropic',
        model: this.config.primaryModel,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        stopReason: response.stop_reason || 'end_turn',
      };
    } catch (err) {
      throw new Error(
        `Anthropic call failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// ============================================================================
// Azure Provider (deferred to Phase 1+)
// ============================================================================

class AzureProvider {
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async call(_options: AICallOptions): Promise<AIResponse> {
    throw new Error('Azure provider not yet implemented (Phase 1+)');
  }
}

// ============================================================================
// Local Ollama Provider (deferred to Phase 1+)
// ============================================================================

class OllamaProvider {
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async call(_options: AICallOptions): Promise<AIResponse> {
    throw new Error('Ollama provider not yet implemented (Phase 1+)');
  }
}

// ============================================================================
// Mock Provider (for testing, zero cost)
// ============================================================================

class MockProvider {
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async call(options: AICallOptions): Promise<AIResponse> {
    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, 50));

    // Mock response with realistic token counts
    // Input: ~4 characters per token, Output: constant 200 tokens for mocking
    const inputTokens = Math.ceil(
      (options.request.systemPrompt.length + options.request.userPrompt.length) / 4
    );
    const outputTokens = 200; // Mock constant

    return {
      content: `[MOCK RESPONSE] Job ${options.jobId} processed. Input: ${options.request.userPrompt.substring(0, 50)}...`,
      provider: 'mock',
      model: 'mock-model',
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      stopReason: 'end_turn',
      confidence: 0.95,
    };
  }
}

// ============================================================================
// AI Provider Router
// ============================================================================

export class AIProviderRouter {
  private config: ProviderConfig;
  private primaryProvider: AnthropicProvider | AzureProvider | OllamaProvider | MockProvider;
  private fallbackProvider: MockProvider;

  constructor(config: ProviderConfig) {
    this.config = config;

    // Select primary provider
    switch (config.primaryProvider) {
      case 'anthropic':
        this.primaryProvider = new AnthropicProvider(config);
        break;
      case 'azure':
        this.primaryProvider = new AzureProvider(config);
        break;
      case 'ollama':
        this.primaryProvider = new OllamaProvider(config);
        break;
      case 'mock':
        this.primaryProvider = new MockProvider(config);
        break;
      default:
        throw new Error(`Unknown provider: ${config.primaryProvider}`);
    }

    // Fallback is always mock
    this.fallbackProvider = new MockProvider(config);
  }

  async call(options: AICallOptions): Promise<AIResponse> {
    try {
      return await Promise.race([
        this.primaryProvider.call(options),
        new Promise<AIResponse>((_, reject) =>
          setTimeout(
            () => reject(new Error('Provider call timeout')),
            (this.config.timeoutSeconds || 30) * 1000
          )
        ),
      ]);
    } catch (err) {
      // Fallback to mock provider
      console.warn(
        `Primary provider failed (${this.config.primaryProvider}), falling back to mock:`,
        err instanceof Error ? err.message : String(err)
      );
      return this.fallbackProvider.call(options);
    }
  }

  static async estimateCost(
    provider: ProviderType,
    model: ModelName,
    inputTokens: number,
    outputTokens: number,
    supabaseClient: ReturnType<typeof createClient>
  ): Promise<number> {
    // Fetch pricing from database (seeded in migration 48)
    // Fallback to defaults if not found
    try {
      const { data, error } = await supabaseClient
        .from('ai_provider_pricing')
        .select('input_cost_per_million, output_cost_per_million')
        .eq('provider', provider)
        .eq('model', model)
        .eq('active', true)
        .single();

      if (error || !data) {
        console.warn(`Pricing not found for ${provider}/${model}; using fallback`);
        return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
      }

      return (
        (inputTokens * data.input_cost_per_million +
          outputTokens * data.output_cost_per_million) /
        1_000_000
      );
    } catch (err) {
      console.error('Cost estimation failed:', err);
      return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
    }
  }
}
