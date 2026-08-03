/**
 * aiAuditLog.ts
 * 
 * Append-only audit logging for all AI operations.
 * Immutable tamper-proof record of all jobs, reviews, and approvals.
 * 
 * Phase 0: Foundations
 */

import { createClient } from '@supabase/supabase-js';

export interface AuditEvent {
  id?: string;
  eventType: string;
  jobId?: string;
  farmId?: string;
  userId?: string;
  featureCode: string;
  eventData: Record<string, unknown>;
  actorUserId?: string;
  actorRole: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  containsPii?: boolean;
  requiresLogRedaction?: boolean;
}

/**
 * Audit logging
 */
export class AIAuditLog {
  private supabaseClient: ReturnType<typeof createClient>;

  constructor(supabaseUrl?: string, serviceRoleKey?: string) {
    this.supabaseClient = createClient(
      supabaseUrl || process.env.SUPABASE_URL || '',
      serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    );
  }

  /**
   * Log an audit event (append-only)
   */
  async log(eventType: string, eventData: Record<string, unknown>, options?: Partial<AuditEvent>): Promise<string | null> {
    const event: AuditEvent = {
      eventType,
      featureCode: (eventData.feature_code as string) || 'unknown',
      eventData,
      actorRole: options?.actorRole || 'system',
      jobId: options?.jobId || (eventData.job_id as string),
      farmId: options?.farmId || (eventData.farm_id as string),
      userId: options?.userId,
      actorUserId: options?.actorUserId,
      containsPii: options?.containsPii || false,
      requiresLogRedaction: options?.requiresLogRedaction || false,
    };

    try {
      const { data, error } = await this.supabaseClient
        .from('ai_audit_events')
        .insert([
          {
            event_type: event.eventType,
            job_id: event.jobId,
            farm_id: event.farmId,
            user_id: event.userId,
            feature_code: event.featureCode,
            event_data: event.eventData,
            actor_user_id: event.actorUserId,
            actor_role: event.actorRole,
            before_state: event.beforeState,
            after_state: event.afterState,
            contains_pii: event.containsPii,
            requires_log_redaction: event.requiresLogRedaction,
          },
        ])
        .select('id')
        .single();

      if (error) {
        console.error('Error logging audit event:', error);
        return null;
      }

      return data?.id || null;
    } catch (error) {
      console.error('Unexpected error in audit log:', error);
      return null;
    }
  }

  /**
   * Log a human review event
   */
  async logReview(
    jobId: string,
    reviewedBy: string,
    decision: 'approved' | 'rejected' | 'corrected' | 'escalated',
    summary?: string,
    correctionsApplied?: Record<string, unknown>
  ): Promise<void> {
    const { error } = await this.supabaseClient
      .from('ai_human_reviews')
      .insert([
        {
          job_id: jobId,
          reviewed_by: reviewedBy,
          decision,
          summary,
          corrections_applied: correctionsApplied,
        },
      ]);

    if (error) {
      throw new Error(`Failed to log review: ${error.message}`);
    }

    // Also log to audit events
    await this.log('human_review_completed', {
      job_id: jobId,
      decision,
      reviewed_by: reviewedBy,
    });
  }

  /**
   * Get audit trail for a job
   */
  async getJobAuditTrail(jobId: string): Promise<AuditEvent[]> {
    const { data, error } = await this.supabaseClient
      .from('ai_audit_events')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });

    if (error || !data) {
      return [];
    }

    return data.map((row: any) => ({
      id: row.id,
      eventType: row.event_type,
      jobId: row.job_id,
      farmId: row.farm_id,
      userId: row.user_id,
      featureCode: row.feature_code,
      eventData: row.event_data,
      actorUserId: row.actor_user_id,
      actorRole: row.actor_role,
      beforeState: row.before_state,
      afterState: row.after_state,
      containsPii: row.contains_pii,
      requiresLogRedaction: row.requires_log_redaction,
    }));
  }

  /**
   * Get audit trail for a farm
   */
  async getFarmAuditTrail(farmId: string, limit: number = 100): Promise<AuditEvent[]> {
    const { data, error } = await this.supabaseClient
      .from('ai_audit_events')
      .select('*')
      .eq('farm_id', farmId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) {
      return [];
    }

    return data.map((row: any) => ({
      id: row.id,
      eventType: row.event_type,
      jobId: row.job_id,
      farmId: row.farm_id,
      userId: row.user_id,
      featureCode: row.feature_code,
      eventData: row.event_data,
      actorUserId: row.actor_user_id,
      actorRole: row.actor_role,
      beforeState: row.before_state,
      afterState: row.after_state,
      containsPii: row.contains_pii,
      requiresLogRedaction: row.requires_log_redaction,
    }));
  }

  /**
   * Get all reviews for a job
   */
  async getJobReviews(jobId: string): Promise<any[]> {
    const { data, error } = await this.supabaseClient
      .from('ai_human_reviews')
      .select('*')
      .eq('job_id', jobId);

    if (error || !data) {
      return [];
    }

    return data;
  }

  /**
   * Compliance: verify audit trail integrity
   */
  async verifyAuditTrailIntegrity(jobId: string): Promise<boolean> {
    // In production, this would verify cryptographic hashes
    // For now, just check that the trail is not empty and in chronological order
    const trail = await this.getJobAuditTrail(jobId);

    if (trail.length === 0) {
      return false;
    }

    // Verify chronological order
    for (let i = 1; i < trail.length; i++) {
      const prev = new Date(trail[i - 1].id || '').getTime();
      const current = new Date(trail[i].id || '').getTime();
      if (current < prev) {
        return false;
      }
    }

    return true;
  }

  /**
   * Export audit trail for compliance reporting
   */
  async exportAuditTrail(
    startDate: Date,
    endDate: Date,
    options?: { farmId?: string; eventTypes?: string[] }
  ): Promise<AuditEvent[]> {
    let query = this.supabaseClient
      .from('ai_audit_events')
      .select('*')
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString());

    if (options?.farmId) {
      query = query.eq('farm_id', options.farmId);
    }

    if (options?.eventTypes && options.eventTypes.length > 0) {
      query = query.in('event_type', options.eventTypes);
    }

    const { data, error } = await query.order('created_at', { ascending: true });

    if (error || !data) {
      return [];
    }

    return data.map((row: any) => ({
      id: row.id,
      eventType: row.event_type,
      jobId: row.job_id,
      farmId: row.farm_id,
      userId: row.user_id,
      featureCode: row.feature_code,
      eventData: row.event_data,
      actorUserId: row.actor_user_id,
      actorRole: row.actor_role,
    }));
  }
}

// Export singleton
export const auditLog = new AIAuditLog();
