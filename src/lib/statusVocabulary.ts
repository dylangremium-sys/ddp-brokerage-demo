/**
 * The status vocabulary — standing rule 3 of the design handoff.
 *
 * FOUR STATES, AND ONLY FOUR, shared by the marketing site and the console:
 *
 *   Cleared        .tag-accent-2   sage       cleared / healthy
 *   Needs a person .tag-accent     terracotta a named human must decide or chase
 *   Watching       .tag-neutral    ink        logged, no action yet
 *   Not applicable .tag-outline    outline    does not apply to this record
 *
 * WHY THIS FILE EXISTS. The homepage's batch dossier card, the console's KPI
 * tiles and (when it is built) the Governance page's vocabulary table must say
 * the same words in the same colours. Before this file they did not share
 * anything: the console typed "Needs a person" as a literal in two places, and
 * the marketing site had no vocabulary at all — the card that shipped used
 * green/amber/amber/red traffic lights, including a red on "Buyer visibility:
 * Restricted", which is correct behaviour rather than a failure.
 *
 * So: never type one of these strings. Import the state and read its label.
 *
 * NOT THE SAME THING AS `StatusBadge.tsx`. That component carries a fifteen-key
 * institutional vocabulary (Claimed / Documented / Reviewed / Verified /
 * Missing / Rejected / Expired / Hold / …) describing where a single document
 * sits in the review pipeline, rendered as `.status-pill`. This file is the
 * four-state *design* vocabulary that colours whole rows and tiles. They are
 * deliberately separate and must not be merged: collapsing fifteen pipeline
 * states into four colours would lose the distinction the console runs on.
 *
 * THAI IS NOT PROOFREAD. Every `th` string below was composed for tone and
 * length by a non-native speaker and is flagged for native review before
 * launch — handoff README, "Fidelity" and open question 1. Do not treat any of
 * it as final copy.
 */

export type StatusStateKey = 'cleared' | 'needsPerson' | 'watching' | 'notApplicable'

export interface StatusState {
  key: StatusStateKey
  /** Organic tag classes. Rule 3 fixes this pairing — do not re-pair per screen. */
  tagClass: string
  /**
   * Modifier class carrying the state's colour, for legend dots and swatches.
   *
   * A CLASS, NOT A TOKEN, ON PURPOSE. The production CSP is
   * `style-src 'self' https://fonts.googleapis.com` — no `'unsafe-inline'` — and
   * the public routes are prerendered to static HTML, so a `style` attribute in
   * that HTML is refused by the browser and the element renders unpainted. Six
   * styles shipped that way and were live-but-dead until PR #237. Any surface
   * using this file styles `.<its-own-class>.<modifier>` in its stylesheet.
   */
  modifier: string
  /** The state's name. */
  label: { en: string; th: string }
  /** What the colour means, for the legend and the Governance table. */
  meaning: { en: string; th: string }
}

/**
 * Declaration order is the vocabulary's order: cleared, then the two that carry
 * a colour, then the absence. Legends and tables render in this order.
 */
export const STATUS_VOCABULARY: Record<StatusStateKey, StatusState> = {
  cleared: {
    key: 'cleared',
    tagClass: 'tag tag-accent-2',
    modifier: 'is-cleared',
    label: { en: 'Cleared', th: 'ผ่านการตรวจแล้ว' },
    meaning: {
      en: 'Cleared — buyers can see it',
      th: 'ผ่านการตรวจแล้ว — ผู้ซื้อมองเห็นได้',
    },
  },
  needsPerson: {
    key: 'needsPerson',
    tagClass: 'tag tag-accent',
    modifier: 'is-needs-person',
    label: { en: 'Needs a person', th: 'ต้องมีผู้รับผิดชอบ' },
    meaning: {
      en: 'A named person must act',
      th: 'ต้องมีผู้รับผิดชอบดำเนินการ',
    },
  },
  watching: {
    key: 'watching',
    tagClass: 'tag tag-neutral',
    modifier: 'is-watching',
    label: { en: 'Watching', th: 'กำลังติดตาม' },
    meaning: {
      en: 'Logged, no action yet',
      th: 'บันทึกไว้แล้ว ยังไม่มีการดำเนินการ',
    },
  },
  notApplicable: {
    key: 'notApplicable',
    tagClass: 'tag tag-outline',
    modifier: 'is-not-applicable',
    label: { en: 'Not applicable', th: 'ไม่เกี่ยวข้อง' },
    meaning: {
      en: 'Does not apply to this batch',
      th: 'ไม่เกี่ยวข้องกับรุ่นการผลิตนี้',
    },
  },
}

/** The four states in vocabulary order. */
export const STATUS_STATES: StatusState[] = [
  STATUS_VOCABULARY.cleared,
  STATUS_VOCABULARY.needsPerson,
  STATUS_VOCABULARY.watching,
  STATUS_VOCABULARY.notApplicable,
]

/**
 * The states actually used by a set of rows, in vocabulary order.
 *
 * A legend that explains a colour the reader cannot see teaches nothing, and one
 * that omits a colour they can see misleads. The handoff's §9 legend is a fixed
 * list of three, written when the card's rows were a fixed list of five; deriving
 * it keeps the two in step when either changes.
 */
export function statesPresentIn(keys: StatusStateKey[]): StatusState[] {
  return STATUS_STATES.filter(s => keys.includes(s.key))
}
