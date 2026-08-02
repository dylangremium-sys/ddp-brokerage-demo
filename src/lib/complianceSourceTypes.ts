// ─── Regulatory source type vocabulary ───────────────────────────────────────
//
// Extracted from complianceSourceRegistry.ts, and the extraction is the point
// rather than tidiness. `complianceSourceConnectors.ts` needs only this
// constant and this type, but importing them from the registry pulled the
// registry's `complianceRepository` value-import along with it, and from there
// `supabase.ts` — whose module body reads `import.meta.env.VITE_*`. That is
// undefined under Node ESM, so a Vercel Function importing the connectors died
// at load. One constant, four modules of transitive weight.
//
// This module must stay dependency-free. Anything imported here is imported by
// every serverless function that touches a connector.

export type RegulatorySourceType =
  | 'government_regulator'
  | 'legal_database'
  | 'industry_association'
  | 'news_press_release'
  | 'other'

export const SUPPORTED_SOURCE_TYPES: RegulatorySourceType[] = [
  'government_regulator',
  'legal_database',
  'industry_association',
  'news_press_release',
  'other',
]
