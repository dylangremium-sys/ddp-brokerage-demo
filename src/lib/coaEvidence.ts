import type { InventoryItem } from '../types'

/**
 * COA evidence position for a batch.
 *
 * A farmer can answer "yes, we have a COA" without a file ever arriving:
 * `coaAvailable` is true while `coaStoragePath` stays empty. Presenting that as
 * "Documented" overstates the evidence — it reports a claim as a received
 * record, which is exactly the inversion this product exists to prevent.
 *
 * This mirrors the rule the codebase already uses, rather than inventing one:
 *
 *   procurementControl.deriveDocumentRequirement:
 *     hasCoaFile ? 'documented' : hasCoaClaim ? 'claimed' : 'missing'
 *   DDPBuyerPreview gates:
 *     'COA claimed by farm' → certFileName || coaAvailable
 *     'COA file received'   → coaStoragePath
 *
 * The received file is the only thing that makes evidence documented.
 * `coaStoragePath` is the source of truth for receipt; `coaAvailable` and
 * `certFileName` are the farmer's claim and can never promote a batch on their
 * own.
 */
export type CoaEvidencePosition = 'documented' | 'claimed' | 'missing'

/** The fields the classification reads. Nothing else may influence it. */
export type CoaEvidenceInput = Pick<
  InventoryItem,
  'coaStoragePath' | 'coaAvailable' | 'certFileName'
>

export function deriveCoaEvidence(item: CoaEvidenceInput): CoaEvidencePosition {
  // Received file: the only state that counts as documented.
  if (item.coaStoragePath) return 'documented'
  // Farmer asserts a COA exists, but nothing has arrived. A filename alone is
  // still only a claim — no file is stored against it.
  if (item.coaAvailable || item.certFileName) return 'claimed'
  return 'missing'
}

/** True when no COA file has been received, whether or not one was claimed. */
export function isCoaFileReceived(item: CoaEvidenceInput): boolean {
  return deriveCoaEvidence(item) === 'documented'
}

/** Approved wording. No "verified", "compliant", "certified" or "approved". */
export const COA_EVIDENCE_LABEL: Record<CoaEvidencePosition, string> = {
  documented: 'Documented',
  claimed: 'Claimed',
  missing: 'Missing Evidence',
}

/** Secondary reason, stating what is and is not on file. */
export const COA_EVIDENCE_REASON: Record<CoaEvidencePosition, string> = {
  documented: 'COA file received',
  claimed: 'COA claimed; file not received',
  missing: 'No COA evidence received',
}
