import { describe, expect, it } from 'vitest'
import { T } from '../../translations'

/**
 * The portal shows exactly one blocking task, and its copy is the only thing
 * that tells the farm what to do next. A card whose wording describes a
 * DIFFERENT state than the one that selected it is not a cosmetic defect: the
 * farm follows it and does the wrong thing.
 *
 * This is the test that was missing on 2026-08-12, when the `evidence` card —
 * chosen only when a document the farm ALREADY SENT came back rejected or
 * awaiting clarification — read "Send a photo of your lab report", with a
 * button labelled "Take a photo of the COA". The farm had sent that report four
 * days earlier and DDP had asked which batch it covered. Following the card
 * produced a duplicate upload and left the question unanswered.
 *
 * Every assertion below is keyed to the MEANING of the state, not to a
 * particular phrasing, so the copy can be rewritten freely and this still holds.
 */
describe('portal blocking-task copy matches the state that selects it', () => {
  const LANGS = ['en', 'th'] as const

  /** Words that promise a fresh upload. Wrong for a document already received. */
  const ASKS_FOR_AN_UPLOAD = {
    en: /\b(photo|photograph|upload|scan|send us|attach)\b/i,
    // ถ่ายภาพ = take a photo, อัปโหลด = upload, สแกน = scan
    th: /(ถ่ายภาพ|อัปโหลด|สแกน)/,
  }

  /** Words that point the farm at something DDP has said. */
  const POINTS_AT_A_REPLY = {
    en: /\b(question|reason|read|said|asked)\b/i,
    // คำถาม = question, เหตุผล = reason, อ่าน = read, แจ้ง = informed
    th: /(คำถาม|เหตุผล|อ่าน|แจ้ง)/,
  }

  for (const lang of LANGS) {
    const task = T[lang].portalTask

    describe(lang, () => {
      const evidenceCopy = [task.evidence.title, task.evidence.body, task.evidence.cta].join(' ')

      it('the evidence card never asks for a document that has already arrived', () => {
        // `evidence` is selected ONLY by a rejected / awaiting-clarification
        // document. Asking for a photo here is asking for what DDP already has.
        expect(evidenceCopy).not.toMatch(ASKS_FOR_AN_UPLOAD[lang])
      })

      it('the evidence card points the farm at what DDP actually said', () => {
        expect(evidenceCopy).toMatch(POINTS_AT_A_REPLY[lang])
      })

      it.each(['licence', 'coa'] as const)(
        'the %s card — which IS about a genuinely missing document — asks for one',
        kind => {
          // Guards the opposite mistake: fixing the wording above by swapping
          // the cards would leave the farm with no way to send what is absent.
          const copy = [task[kind].title, task[kind].body, task[kind].cta].join(' ')
          expect(copy).toMatch(ASKS_FOR_AN_UPLOAD[lang])
        },
      )

      it('the licence card asks for the licence and the coa card asks for the report', () => {
        // These were ONE card until 2026-08-12, selected when either document
        // was missing and worded only for the licence — so a farm that had sent
        // its licence and not its lab report was told to send the licence again.
        // Each card must name its own document.
        const licence = [task.licence.title, task.licence.cta].join(' ')
        const coa = [task.coa.title, task.coa.cta].join(' ')
        const NAMES_LICENCE = { en: /licen[cs]e/i, th: /ใบอนุญาต/ }
        const NAMES_REPORT = { en: /\b(lab|laboratory|report|analysis|COA)\b/i, th: /(แล็บ|ผลตรวจ|COA|วิเคราะห์)/ }

        expect(licence).toMatch(NAMES_LICENCE[lang])
        expect(licence).not.toMatch(NAMES_REPORT[lang])
        expect(coa).toMatch(NAMES_REPORT[lang])
        expect(coa).not.toMatch(NAMES_LICENCE[lang])
      })

      it('every blocking task states a tag, a title, a body and an action', () => {
        for (const [kind, copy] of Object.entries(task)) {
          for (const [field, value] of Object.entries(copy)) {
            expect(`${kind}.${field}: ${String(value).trim()}`).not.toMatch(/: $/)
          }
        }
      })
    })
  }
})
