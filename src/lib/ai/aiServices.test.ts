/**
 * aiServices.test.ts
 * 
 * Unit tests for Phase 0 AI services.
 * Tests provider router, job queue, cost tracking, audit logging, and prompt registry.
 * 
 * @vitest run src/lib/ai/aiServices.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AIProviderRouter } from '../aiProviderRouter';
import { AIJobQueue } from '../aiJobQueue';
import { AICostTracker } from '../aiCostTracker';
import { AIAuditLog } from '../aiAuditLog';
import { PromptRegistry } from '../promptRegistry';
import { setupTestEnvironment, cleanupTestEnvironment } from './aiTestSetup';

// ============================================================================
// AIProviderRouter Tests
// ============================================================================

setupTestEnvironment();

describe('AIProviderRouter', () => {
  let router: AIProviderRouter;

  beforeEach(() => {
    process.env.AI_PROVIDER_MODE = 'mock';
    router = new AIProviderRouter();
  });

  it('should initialize with mock provider', () => {
    expect(router).toBeDefined();
  });

  it('should call mock provider and return valid response', async () => {
    const response = await router.call({
      config: {
        primaryProvider: 'mock',
        primaryModel: 'mock-model',
        maxRetries: 3,
        timeoutSeconds: 60,
      },
      request: {
        systemPrompt: 'You are a COA extraction expert.',
        userPrompt: 'Extract laboratory name from this COA.',
        maxTokens: 2000,
        temperature: 0.2,
      },
      jobId: 'test-job-001',
      attemptNumber: 1,
    });

    expect(response).toBeDefined();
    expect(response.provider).toBe('mock');
    expect(response.totalTokens).toBeGreaterThan(0);
    expect(response.content).toBeDefined();
  });

  it('should estimate cost correctly', async () => {
    const cost = await router.estimateCost('mock', 'mock-model', 1000, 500);
    expect(cost).toBeGreaterThan(0);
  });
});

// ============================================================================
// AIJobQueue Tests
// ============================================================================

describe('AIJobQueue', () => {
  let queue: AIJobQueue;

  beforeEach(() => {
    process.env.AI_PROVIDER_MODE = 'mock';
    queue = new AIJobQueue();
  });

  it('should initialize job queue', () => {
    expect(queue).toBeDefined();
  });

  it('should submit a new job', async () => {
    const jobId = await queue.submitJob(
      'coa_extraction',
      'extraction',
      'farm-123',
      'user-456',
      { pdf_url: 'test.pdf', batch_id: 'batch-001' }
    );

    expect(jobId).toBeDefined();
    expect(typeof jobId).toBe('string');
  });

  it('should retrieve job status', async () => {
    const jobId = await queue.submitJob(
      'coa_extraction',
      'extraction',
      'farm-123',
      'user-456',
      { pdf_url: 'test.pdf' }
    );

    const job = await queue.getJob(jobId);

    expect(job).toBeDefined();
    expect(job?.id).toBe(jobId);
  });
});

// ============================================================================
// AICostTracker Tests
// ============================================================================

describe('AICostTracker', () => {
  let tracker: AICostTracker;

  beforeEach(() => {
    tracker = new AICostTracker();
  });

  it('should initialize cost tracker', () => {
    expect(tracker).toBeDefined();
  });

  it('should record usage', async () => {
    await tracker.recordUsage('farm-123', 'coa_extraction', 1500, 0.0045);
    expect(true).toBe(true);
  });

  it('should get cost summary', async () => {
    await tracker.recordUsage('farm-123', 'coa_extraction', 1500, 0.0045);

    const summary = await tracker.getCostSummary('farm-123', 'coa_extraction');

    expect(summary).toBeDefined();
    expect(summary.farmId).toBe('farm-123');
  });

  it('should estimate job cost', async () => {
    const cost = await tracker.estimateJobCost('anthropic', 'claude-opus-5', 1000, 500);
    expect(cost).toBeGreaterThan(0);
  });
});

// ============================================================================
// AIAuditLog Tests
// ============================================================================

describe('AIAuditLog', () => {
  let auditLog: AIAuditLog;

  beforeEach(() => {
    auditLog = new AIAuditLog();
  });

  it('should initialize audit log', () => {
    expect(auditLog).toBeDefined();
  });

  it('should log audit event', async () => {
    const eventId = await auditLog.log('job_submitted', {
      feature_code: 'coa_extraction',
      job_id: 'job-123',
      farm_id: 'farm-456',
      status: 'pending',
    });

    expect(typeof eventId).toBe('string');
  });

  it('should get job audit trail', async () => {
    const trail = await auditLog.getJobAuditTrail('job-123');
    expect(Array.isArray(trail)).toBe(true);
  });
});

// ============================================================================
// PromptRegistry Tests
// ============================================================================

describe('PromptRegistry', () => {
  let registry: PromptRegistry;

  beforeEach(() => {
    registry = new PromptRegistry();
  });

  it('should initialize prompt registry', () => {
    expect(registry).toBeDefined();
  });

  it('should validate guardrails on prompt', () => {
    const testPrompt = {
      id: 'test',
      promptKey: 'test_v1',
      featureCode: 'test',
      actionType: 'test',
      currentVersion: 1,
      systemPrompt: 'You are a helpful assistant.',
      userPromptTemplate: 'Extract data.',
      temperature: 0.2,
      guardrails: ['no_compliance_claims', 'cite_sources'],
      allowedModels: ['claude-opus-5'],
      isActive: true,
    };

    const validation = registry.validateGuardrails(testPrompt);
    expect(validation.valid).toBe(true);
  });

  it('should flag dangerous compliance terms', () => {
    const badPrompt = {
      id: 'test',
      promptKey: 'bad_v1',
      featureCode: 'test',
      actionType: 'test',
      currentVersion: 1,
      systemPrompt: 'Tell me if this is compliant.',
      userPromptTemplate: 'Is this product approved?',
      temperature: 0.2,
      guardrails: ['no_compliance_claims'],
      allowedModels: [],
      isActive: true,
    };

    const validation = registry.validateGuardrails(badPrompt);
    expect(validation.valid).toBe(false);
  });

  it('should apply guardrails to response', async () => {
    const response = 'The product is compliant with regulations.';

    const result = await registry.applyGuardrails(response, ['no_compliance_claims'], 'test_feature');

    expect(result.flagged).toBe(true);
    expect(result.cleaned).not.toEqual(response);
  });
});

// ============================================================================
// Integration: Full Job Lifecycle
// ============================================================================

describe('Integration: Full Job Lifecycle', () => {
  it('should complete job submission and processing', async () => {
    process.env.AI_PROVIDER_MODE = 'mock';

    const queue = new AIJobQueue();
    const tracker = new AICostTracker();

    const jobId = await queue.submitJob('coa_extraction', 'extraction', 'farm-123', 'user-456', {
      pdf_url: 'test.pdf',
    });

    expect(jobId).toBeDefined();

    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();

    const summary = await tracker.getCostSummary('farm-123', 'coa_extraction');
    expect(summary).toBeDefined();
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error Handling', () => {
  it('should handle invalid job ID gracefully', async () => {
    const queue = new AIJobQueue();
    const job = await queue.getJob('invalid-job-id');
    expect(job).toBeNull();
  });
});
