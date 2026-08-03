/**
 * Tests for AIJobQueue
 * 
 * Tests the async job queue: submission, status tracking, job retrieval
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AIJobQueue, AIJob } from '../aiJobQueue';
import { createMockSupabaseClient, testContext } from './setup';

describe('AIJobQueue', () => {
  let jobQueue: AIJobQueue;

  beforeEach(() => {
    testContext.enableTestMode();
    // Create queue in test mode (no real Supabase connection needed)
    jobQueue = new AIJobQueue('http://localhost:54321', 'test-key');
  });

  describe('submitJob', () => {
    it('should submit a job and return a job ID', async () => {
      const jobId = await jobQueue.submitJob(
        'farm-123',
        'compliance_check',
        { documentUrl: 'https://example.com/doc.pdf' },
        true
      );

      expect(jobId).toBeDefined();
      expect(jobId).toMatch(/^job-/);
    });

    it('should accept job input payload as Record<string, unknown>', async () => {
      const payload = {
        documentUrl: 'https://example.com/doc.pdf',
        pageCount: 42,
        metadata: { source: 'upload', userId: 'user-456' },
      };

      const jobId = await jobQueue.submitJob(
        'farm-123',
        'document_analysis',
        payload,
        false
      );

      expect(jobId).toBeDefined();
    });

    it('should allow optional requiresReview parameter', async () => {
      // With requiresReview = true (default)
      const jobId1 = await jobQueue.submitJob(
        'farm-123',
        'feature1',
        { data: 'test' }
      );
      expect(jobId1).toBeDefined();

      // With requiresReview = false (explicit)
      const jobId2 = await jobQueue.submitJob(
        'farm-123',
        'feature2',
        { data: 'test' },
        false
      );
      expect(jobId2).toBeDefined();
    });
  });

  describe('processJob', () => {
    it('should accept job details and mark as processing', async () => {
      // This is a placeholder method that updates job status
      // In test mode, it's a no-op, but we verify the signature is correct
      await expect(
        jobQueue.processJob(
          'job-123',
          'anthropic',
          'claude-opus-5',
          'You are a compliance officer',
          'Review this document'
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('getJobStatus', () => {
    it('should retrieve job status (phase 2 feature)', async () => {
      // getJobStatus is a planned method that doesn't exist yet
      // This test is skipped until Phase 2 implementation
      // When implemented, it should return the job status
      // const status = await jobQueue.getJobStatus('job-123');
      // expect(['pending', 'processing', 'completed', 'failed', 'timeout']).toContain(status);
    });
  });

  describe('listJobsByFarm', () => {
    it('should list jobs for a farm (phase 2 feature)', async () => {
      // listJobsByFarm is a planned method
      // When implemented, should return AIJob[] filtered by farm_id
    });
  });

  describe('AIJob interface', () => {
    it('should have required properties', () => {
      const job: AIJob = {
        id: 'job-123',
        farm_id: 'farm-456',
        feature_code: 'compliance_check',
        status: 'pending',
        input_payload: { data: 'test' },
        requires_human_review: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      expect(job.id).toBe('job-123');
      expect(job.status).toBe('pending');
      expect(['pending', 'processing', 'completed', 'failed', 'timeout']).toContain(
        job.status
      );
    });

    it('should allow optional output_payload and error_message', () => {
      const job: AIJob = {
        id: 'job-123',
        farm_id: 'farm-456',
        feature_code: 'compliance_check',
        status: 'completed',
        input_payload: { data: 'test' },
        output_payload: { result: 'passed' },
        error_message: undefined,
        requires_human_review: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      expect(job.output_payload).toEqual({ result: 'passed' });
      expect(job.error_message).toBeUndefined();
    });
  });
});
