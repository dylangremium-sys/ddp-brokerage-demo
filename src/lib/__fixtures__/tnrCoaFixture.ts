// Synthetic TNR three-page COA fixture.
//
// Reproduces the layout of the demonstrated TNR Bioscience report so the
// adapter and findings engine can be tested without the supplied COAs, which
// are private project evidence and are never committed. Every value is a
// parameter — tests vary them to prove nothing is hard-coded.

export interface FixtureOptions {
  reportNumber?: string
  receivedDate?: string
  reportedOn?: string
  sampleName?: string
  manufacturingDate?: string
  expiryDate?: string
  batchNumber?: string
  sampleNumber?: string
  testingStart?: string
  testingEnd?: string
  totalThc?: string
  totalCbd?: string
  issuer?: string
  documentCode?: string
  omitPanels?: string[]
  extraRows?: string[]
}

/** Build a faithful three-page TNR report from parameterised values. */
export function makeTnrPages(options: FixtureOptions = {}): string[] {
  const {
    reportNumber = 'RP-E2602-0196',
    receivedDate = '11/02/2026',
    reportedOn = '27/02/2026',
    sampleName = 'Mango',
    manufacturingDate = '20/12/2025',
    expiryDate = '20/12/2026',
    batchNumber = 'F4-122025',
    sampleNumber = 'EX26-0190',
    testingStart = '17/02/2026',
    testingEnd = '27/02/2026',
    totalThc = '26.86',
    totalCbd = '0.10',
    issuer = 'TNR BIOSCIENCE COMPANY LIMITED',
    documentCode = 'TNRB-QC-FM-59',
    omitPanels = [],
    extraRows = [],
  } = options

  const panel = (heading: string, rows: string[]): string =>
    omitPanels.includes(heading) ? '' : [heading, ...rows].join('\n')

  const page1 = [
    'Report No. :',
    'Sample received date :',
    'Reported on :',
    `Sample Name ${sampleName}`,
    `Manufacturing Date ${manufacturingDate}`,
    `Expiry Date ${expiryDate}`,
    'Cannabis flowers packed in a ziplock bag',
    `Batch No. ${batchNumber}`,
    'Material Batch No. N/A',
    `Sample No. ${sampleNumber}`,
    `Testing Start Date ${testingStart}`,
    `Testing End Date ${testingEnd}`,
    'Specification Result Unit LOD',
    panel('Physical Properties', [
      'Appearance N/A Dried cannabis flowers N/A N/A',
      'Foreign matter N/A ND %w/w N/A',
      'Moisture Content at 105 ºC N/A 10.27 %w/w N/A',
    ]),
    panel('Identification', [
      'Macroscopic examination Presence of beaked bracts',
      'with stigmas',
      'Conforms N/A N/A',
    ]),
    panel('Cannabinoid groups', [
      'Cannabidiol (CBD) N/A ND %w/w 0.00014',
      'd9-Tetrahydrocannabinol (d9-THC) N/A 2.29 %w/w 0.00004',
      `Total Cannabidiol (CBD) N/A ${totalCbd} %w/w N/A`,
      `Total Tetrahydrocannabinol (THC) N/A ${totalThc} %w/w N/A`,
    ]),
    panel('Terpenes', [
      'alpha-Pinene N/A 0.02 %w/w N/A',
      'Total Terpenes N/A 1.09 %w/w N/A',
    ]),
    ...extraRows,
    'Customer Name',
    'and Address',
    'Calli Krush Co.,LTD 112 Village No.9',
    'Nang Rong District, Buriram Province 31110',
    'Detail of Sample',
    reportNumber,
    receivedDate,
    reportedOn,
    'LABORATORY TEST REPORT',
    issuer,
    `Document Code: ${documentCode} Issue No. 03 Effective Date: 27/08/2025 1 of 3`,
  ].filter((l) => l !== '').join('\n')

  const page2 = [
    'Report No. :',
    'Sample received date :',
    'Reported on :',
    reportNumber,
    receivedDate,
    reportedOn,
    'LABORATORY TEST REPORT',
    issuer,
    'Specification Result Unit LOD',
    panel('Heavy Metal', [
      'Arsenic (As) N/A 0.01 ppm N/A',
      'Lead (Pb) N/A 0.06 ppm N/A',
    ]),
    panel('Mycotoxins', [
      'Aflatoxin B1 N/A ND µg/kg N/A',
      'Ochratoxin A N/A ND µg/kg N/A',
    ]),
    panel('Pesticides', [
      'Acephate N/A ND mg/kg N/A',
      'Alachlor N/A ND mg/kg N/A',
    ]),
    `Document Code: ${documentCode} Issue No. 03 Effective Date: 27/08/2025 2 of 3`,
  ].filter((l) => l !== '').join('\n')

  const page3 = [
    'Report No. :',
    reportNumber,
    receivedDate,
    reportedOn,
    'LABORATORY TEST REPORT',
    issuer,
    panel('Microbial Enumeration', [
      'Total Aerobic Microbial Count (TAMC) N/A < 10 CFU/g N/A',
      'Total Combined Yeasts & Molds Count (TYMC) N/A < 10 CFU/g N/A',
    ]),
    panel('Specified Microorganisms', [
      'Staphylococcus aureus N/A Absent per 1 g N/A',
      'Salmonella spp. N/A Absent per 25 g N/A',
    ]),
    '- End of Report -',
    `Document Code: ${documentCode} Issue No. 03 Effective Date: 27/08/2025 3 of 3`,
  ].filter((l) => l !== '').join('\n')

  return [page1, page2, page3]
}
