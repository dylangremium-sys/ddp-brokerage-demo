/**
 * Test setup utilities for Phase 0 AI tests
 * Provides mock environment and Supabase client
 */

export function setupTestEnvironment() {
  // Set test environment variables
  process.env.AI_PROVIDER_MODE = 'mock';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-xxxxxxxxxxxxxxxxxxxxxxxx';
  process.env.ANTHROPIC_API_KEY = 'test-api-key-sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
}

export function cleanupTestEnvironment() {
  // Clean up test environment variables
  delete process.env.AI_PROVIDER_MODE;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_ANON_KEY;
}
