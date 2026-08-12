// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import FarmerPortal from './FarmerPortal'
import { T } from '../../translations'
import type { FarmProfile } from '../../types'

/**
 * The portal shows exactly ONE thing DDP needs next. Choosing the wrong one
 * sends a farm off to do work that is already done, so what this file protects
 * is the choice itself — not the wording, which portalTaskCopy.test.ts covers.
 *
 * Two defects observed live on 2026-08-12 sit behind these cases:
 *
 *   · "Has a COA" was read from the farm profile field alone, which knows
 *     nothing about the document register. A farm whose certificate had been
 *     uploaded, received and read by DDP still measured as having sent nothing.
 *
 *   · The licence and the COA shared one card that only ever said "licence", so
 *     a farm missing only its lab report was told to add a licence it had
 *     already sent.
 *
 * And one rule that is the whole lesson of that day: **an unknown answer must
 * never be rendered as "no"**. The register not having replied yet is not the
 * same statement as the farm not having sent anything, and only one of the two
 * justifies telling somebody to go and photograph a document.
 */

const FARM: FarmProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  tradingName: 'Test Farm',
  province: 'Chiang Mai',
  status: 'Approved',
  completionPct: 20,
  submittedAt: '2026-08-01T00:00:00.000Z',
  cultivationLicence: 'LIC-1',
  coaFiles: '',
} as unknown as FarmProfile

function renderPortal(overrides: {
  coaDocumentOnFile: boolean | null
  evidenceWaitingCount?: number | null
  farm?: Partial<FarmProfile>
}) {
  render(
    <FarmerPortal
      lang="en"
      onLang={() => undefined}
      farms={[{ ...FARM, ...overrides.farm } as FarmProfile]}
      inventory={[]}
      reviewRequests={[]}
      currentProfile={null}
      evidenceWaitingCount={overrides.evidenceWaitingCount ?? 0}
      coaDocumentOnFile={overrides.coaDocumentOnFile}
      openRequestsCount={0}
      onPrimary={() => undefined}
      onContact={() => undefined}
      onAddBatch={() => undefined}
      onSignOut={() => undefined}
      onGoTo={() => undefined}
    />,
  )
}

const COA_TITLE = T.en.portalTask.coa.title
const LICENCE_TITLE = T.en.portalTask.licence.title
const PROFILE_TITLE = T.en.portalTask.profile.title
const EVIDENCE_TITLE = T.en.portalTask.evidence.title

describe('which task the portal says DDP is waiting for', () => {
  afterEach(cleanup)

  it('does not ask for a COA when the register already holds one', () => {
    renderPortal({ coaDocumentOnFile: true })
    expect(screen.queryByText(COA_TITLE)).toBeNull()
    expect(screen.getByText(PROFILE_TITLE)).toBeTruthy()
  })

  it('asks for a COA only when the register has answered that there is none', () => {
    renderPortal({ coaDocumentOnFile: false })
    expect(screen.getByText(COA_TITLE)).toBeTruthy()
  })

  it('stays silent about the COA while the register has not answered', () => {
    // The failure this exists to stop: null read as "none", which is how a farm
    // gets told to send a document DDP is already holding.
    renderPortal({ coaDocumentOnFile: null })
    expect(screen.queryByText(COA_TITLE)).toBeNull()
    // Falls through to the next real task rather than inventing one, so an
    // unanswered register cannot manufacture an instruction.
    expect(screen.getByText(PROFILE_TITLE)).toBeTruthy()
  })

  it('asks for the licence, not the COA, when only the licence is missing', () => {
    renderPortal({ coaDocumentOnFile: true, farm: { cultivationLicence: '' } })
    expect(screen.getByText(LICENCE_TITLE)).toBeTruthy()
    expect(screen.queryByText(COA_TITLE)).toBeNull()
  })

  it('a document DDP has queried outranks both, whatever the paperwork says', () => {
    renderPortal({ coaDocumentOnFile: false, evidenceWaitingCount: 1, farm: { cultivationLicence: '' } })
    expect(screen.getByText(EVIDENCE_TITLE)).toBeTruthy()
    expect(screen.queryByText(LICENCE_TITLE)).toBeNull()
    expect(screen.queryByText(COA_TITLE)).toBeNull()
  })
})
