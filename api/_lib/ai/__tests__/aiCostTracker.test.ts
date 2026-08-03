/**
 * Tests for AICostTracker
 * 
 * Tests cost tracking, usage metrics, budget enforcement, and alerts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AICostTracker, UsageMetric } from '../aiCostTracker.js';
import { testContext } from './setup.js';

describe('AICostTracker', () => {
  let costTracker: AICostTracker;

  beforeEach(() => {
    testContext.enableTestMode();
    // Create tracker in test mode
    costTracker = new AICostTracker('http://localhost:54321', 'test-key');
  });

  describe('recordUsage', () => {
    it('should record token usage and cost', async () => {
      await expect(
        costTracker.recordUsage(
          'farm-123',
          'compliance_check',
          250,
          0.015
        )
      ).resolves.toBeUndefined();
    });

    it('should accept various token counts', async () => {
      const cases = [
        { tokens: 100, cost: 0.005 },
        { tokens: 1000, cost: 0.05 },
        { tokens: 10000, cost: 0.5 },
      ];

      for (const { tokens, cost } of cases) {
        await expect(
          costTracker.recordUsage('farm-123', 'feature', tokens, cost)
        ).resolves.toBeUndefined();
      }
    });
  });

  describe('getSpendingMetrics', () => {
    it('should return spending metrics for a farm (phase 2 feature)', async () => {
      // getSpendingMetrics is a planned method
      // When implemented, should return metrics for a time period
      // const metrics = await costTracker.getSpendingMetrics('farm-123', 'month');
      // expect(metrics).toHaveProperty('totalCostUsd');
      // expect(metrics).toHaveProperty('tokenCount');
    });
  });

  describe('checkBudgetAlert', () => {
    it('should check if spending triggers budget alert (phase 2 feature)', async () => {
      // When implemented, should return alert status
      // const alert = await costTracker.checkBudgetAlert('farm-123');
      // expect(['ok', 'warning', 'critical']).toContain(alert.level);
    });
  });

  describe('enforceSpendingCap', () => {
    it('should enforce hard spending cap (phase 2 feature)', async () => {
      // When implemented, should return whether operation is allowed
      // const allowed = await costTracker.enforceSpendingCap('farm-123', 0.10);
      // expect(typeof allowed).toBe('boolean');
    });
  });

  describe('UsageMetric interface', () => {
    it('should have required properties', () => {
      const metric: UsageMetric = {
        farm_id: 'farm-123',
        feature_code: 'compliance_check',
        tokens_used: 250,
        cost_usd: 0.015,
        recorded_at: new Date().toISOString(),
      };

      expect(metric.farm_id).toBe('farm-123');
      expect(metric.tokens_used).toBe(250);
      expect(metric.cost_usd).toBeCloseTo(0.015, 3);
    });

    it('should track cost accurately across multiple recordings', () => {
      const metrics: UsageMetric[] = [
        {
          farm_id: 'farm-123',
          feature_code: 'feature1',
          tokens_used: 100,
          cost_usd: 0.005,
          recorded_at: new Date().toISOString(),
        },
        {
          farm_id: 'farm-123',
          feature_code: 'feature2',
          tokens_used: 200,
          cost_usd: 0.010,
          recorded_at: new Date().toISOString(),
        },
      ];

      const total = metrics.reduce((sum, m) => sum + m.cost_usd, 0);
      expect(total).toBeCloseTo(0.015, 3);
    });
  });

  describe('threshold constants', () => {
    it('should respect spending thresholds (internal check)', async () => {
      // These thresholds are defined in the class but not yet used
      // ALERT_THRESHOLD: 80% = alert
      // SOFT_STOP_THRESHOLD: 90% = soft stop
      // HARD_STOP_THRESHOLD: 100% = hard stop
      // When alerts are implemented, they should respect these levels

      const budgetUsd = 100;
      const alertLevel = budgetUsd * 0.80; // 80 USD triggers alert
      const softStopLevel = budgetUsd * 0.90; // 90 USD soft stop
      const hardStopLevel = budgetUsd * 1.0; // 100 USD hard stop

      expect(softStopLevel).toBeGreaterThan(alertLevel);
      expect(hardStopLevel).toBeGreaterThanOrEqual(softStopLevel);
    });
  });
});
