import type { RegulatorySource } from '../types'
import type { CreateRegulatorySourceInput } from './complianceSourceRegistry'

// Starter monitoring targets. Where an OFFICIAL RSS/notices endpoint has been
// verified live, the url points at that endpoint (not the org homepage) and
// monitoringMethod matches it. Where no official feed/notices endpoint could be
// confidently verified, the authority homepage is kept with monitoringMethod
// 'html' and flagged below — deliberately not guessed (a wrong endpoint would
// silently monitor nothing). Sources still needing an exact endpoint:
//   Thai FDA, Ministry of Public Health TH, ONCB, Thai Customs, Dept. of
//   Agriculture TH, Royal Thai Government Gazette — no official RSS/notices URL
//   verified (only search pages / unofficial mirrors were found, both excluded).
export const WATCHTOWER_STARTER_SOURCES: readonly CreateRegulatorySourceInput[] = [
  {
    name: 'Thai FDA',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.fda.moph.go.th/',
    tier: 1,
    authorityType: 'primary_regulator',
    category: 'pharmaceutical',
    monitoringMethod: 'html',
    priority: 5,
  },
  {
    name: 'Ministry of Public Health Thailand',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.moph.go.th/',
    tier: 1,
    authorityType: 'ministry',
    category: 'pharmaceutical',
    monitoringMethod: 'html',
    priority: 10,
  },
  {
    name: 'Office of the Narcotics Control Board Thailand',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.oncb.go.th/',
    tier: 1,
    authorityType: 'primary_regulator',
    category: 'licensing',
    monitoringMethod: 'html',
    priority: 10,
  },
  {
    name: 'Thai Customs Department',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.customs.go.th/',
    tier: 1,
    authorityType: 'primary_regulator',
    category: 'export_import',
    monitoringMethod: 'html',
    priority: 15,
  },
  {
    name: 'Department of Agriculture Thailand',
    jurisdiction: 'Thailand',
    sourceType: 'government_regulator',
    url: 'https://www.doa.go.th/',
    tier: 1,
    authorityType: 'ministry',
    category: 'cultivation',
    monitoringMethod: 'html',
    priority: 20,
  },
  {
    name: 'Royal Thai Government Gazette',
    jurisdiction: 'Thailand',
    sourceType: 'legal_database',
    url: 'https://ratchakitcha.soc.go.th/',
    tier: 1,
    authorityType: 'official_gazette',
    category: 'general',
    monitoringMethod: 'html',
    priority: 5,
  },
  {
    name: 'SUKL Czech Republic',
    jurisdiction: 'Czech Republic',
    sourceType: 'government_regulator',
    // Official SÚKL RSS (news/announcements). The authority migrated to the
    // sukl.gov.cz domain; the canonical feed lives at /feed/ (the older /rss
    // path 301-redirects there), so the canonical URL is recorded directly to
    // avoid depending on that redirect. Verified live (channel title "SÚKL").
    url: 'https://sukl.gov.cz/feed/',
    tier: 1,
    authorityType: 'primary_regulator',
    category: 'pharmaceutical',
    monitoringMethod: 'rss',
    priority: 15,
  },
  {
    name: 'EUR-Lex',
    jurisdiction: 'European Union',
    sourceType: 'legal_database',
    // Official EUR-Lex predefined RSS — "Acts of the Official Journal L"
    // (individual EU legislative acts). Verified live as valid RSS 2.0.
    url: 'https://eur-lex.europa.eu/EN/display-feed.rss?rssId=222',
    tier: 1,
    authorityType: 'official_gazette',
    category: 'general',
    monitoringMethod: 'rss',
    priority: 20,
  },
] as const

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase()
}

export function listMissingStarterSources(existingSources: RegulatorySource[]): CreateRegulatorySourceInput[] {
  const existingUrls = new Set(existingSources.map(source => normalizeUrl(source.url)))
  return WATCHTOWER_STARTER_SOURCES.filter(source => !existingUrls.has(normalizeUrl(source.url)))
}
