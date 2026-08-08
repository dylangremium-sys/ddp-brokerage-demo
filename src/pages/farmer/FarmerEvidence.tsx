import { useEffect, useState } from 'react'
import { runGuardedLoad } from '../../lib/asyncLoadGuard'
import { loadFarmerDocuments } from '../../lib/db'
import { formatDate } from '../../lib/formatDate'
import type { Lang, FarmerDocument, DocumentReviewStatus } from '../../types'

/**
 * My evidence — what a farm uploaded, and what DDP decided about it.
 *
 * WHY THIS EXISTS. Migration 65 gave an administrator a way to record a reasoned
 * non-decision: `awaiting_clarification` plus a mandatory note. That closed a
 * real gap — the most common honest outcome for the certificates DDP actually
 * holds is "this cannot be matched to a batch, please clarify" — but it closed
 * it only on the administrator's side. The question was written down and the
 * person who had to answer it could not see it: before this page, NO farmer
 * surface read `farmer_documents` at all. A question nobody is shown is not a
 * question, and the note requirement would have been ceremony.
 *
 * SCOPING IS THE DATABASE'S JOB HERE, and deliberately so. This page calls the
 * same `loadFarmerDocuments()` the administrator's queue calls, unfiltered, and
 * the `farmer_documents: farmer select own` policy returns only rows for farms
 * the caller belongs to. It does NOT read App.tsx's shared arrays, so there is
 * no window — first load, refetch, or scope change — in which another farm's
 * evidence could sit in a variable this component can reach. Measured while
 * hardening the RED/BLUE probe: a farmer who is not a member of the farm reads
 * ZERO rows, and one who is reads only their own.
 *
 * WHAT IS DELIBERATELY NOT SHOWN:
 *
 *   · The reviewer. `reviewed_by` is a UUID of a DDP administrator. To a farmer
 *     it is an unreadable internal identifier, and naming individual staff to a
 *     counterparty is not this screen's job. The decision is DDP's, and it is
 *     attributed in the database and on the administrator's screen, which is
 *     where attribution is actually load-bearing.
 *
 *   · The review history. `farmer_document_reviews` is admin-only by policy — a
 *     farmer reads 0 rows from it — so this page shows the CURRENT state and
 *     the CURRENT reason, which is what `review_note` holds. It does not offer
 *     a history control that would only ever fail.
 *
 *   · A contact address. The published addresses on the live site are on a
 *     domain with no MX record, so every message to them is lost. Telling a
 *     farmer to write to a bouncing address would be worse than saying nothing,
 *     so this page tells them what to DO instead — re-upload against the batch.
 *
 * THE DIGEST CLAIM BOUNDARY, stated on the screen rather than left implied: the
 * fingerprint shows the stored bytes are the bytes DDP received. It says nothing
 * about whether the certificate is genuine or whether the named laboratory
 * issued it. This is the easiest false claim in the product to make by accident.
 */

interface Props {
  lang: Lang
  onGoMyStock: () => void
}

/**
 * Order of attention, not order of arrival.
 *
 * A document waiting on the farmer comes first, because it is the only state on
 * this screen that asks them for something. Accepted evidence sorts last: it is
 * reassuring to see and requires nothing.
 */
const STATUS_ORDER: Record<DocumentReviewStatus, number> = {
  awaiting_clarification: 0,
  rejected: 1,
  pending: 2,
  accepted: 3,
}

const STATUS_LABEL: Record<DocumentReviewStatus, { en: string; th: string }> = {
  pending: { en: 'With DDP for review', th: 'อยู่ระหว่างการตรวจสอบของ DDP' },
  awaiting_clarification: { en: 'DDP needs clarification', th: 'DDP ต้องการข้อมูลเพิ่มเติม' },
  accepted: { en: 'Accepted', th: 'ยอมรับแล้ว' },
  rejected: { en: 'Not accepted', th: 'ไม่ยอมรับ' },
}

/**
 * What each state means in the farmer's terms — what has happened, and whether
 * anything is being asked of them.
 *
 * `pending` says nothing has happened yet on purpose. Uploading is not
 * reviewing, and a farmer should never read a stored document as an approved
 * one.
 */
const STATUS_MEANING: Record<DocumentReviewStatus, { en: string; th: string }> = {
  pending: {
    en: 'DDP has your document. Nobody has reviewed it yet — there is nothing for you to do.',
    th: 'DDP ได้รับเอกสารของคุณแล้ว ยังไม่มีการตรวจสอบ คุณยังไม่ต้องดำเนินการใด ๆ',
  },
  awaiting_clarification: {
    en: 'DDP examined your document and one thing is unresolved. This is not a rejection — the reason is below.',
    th: 'DDP ตรวจสอบเอกสารของคุณแล้ว และมีบางประเด็นที่ยังไม่ชัดเจน นี่ไม่ใช่การปฏิเสธ เหตุผลอยู่ด้านล่าง',
  },
  accepted: {
    en: 'A DDP reviewer examined this document and was satisfied by it.',
    th: 'ผู้ตรวจสอบของ DDP ได้ตรวจเอกสารนี้และยอมรับแล้ว',
  },
  rejected: {
    en: 'A DDP reviewer examined this document and will not rely on it. The reason is below.',
    th: 'ผู้ตรวจสอบของ DDP ได้ตรวจเอกสารนี้และจะไม่ใช้อ้างอิง เหตุผลอยู่ด้านล่าง',
  },
}

const TYPE_LABEL: Record<string, { en: string; th: string }> = {
  coa: { en: 'Certificate of analysis', th: 'ใบรับรองผลวิเคราะห์ (COA)' },
  licence: { en: 'Licence', th: 'ใบอนุญาต' },
  photo: { en: 'Photograph', th: 'รูปภาพ' },
  other: { en: 'Document', th: 'เอกสาร' },
}

/** A state that puts the ball in the farmer's court. */
function needsFarmer(status: DocumentReviewStatus): boolean {
  return status === 'awaiting_clarification' || status === 'rejected'
}

export default function FarmerEvidence({ lang, onGoMyStock }: Props) {
  const isTh = lang === 'th'

  // null means "no successful load yet", kept distinct from [] so an empty list
  // is never rendered before a load has actually succeeded. "You have uploaded
  // nothing" and "we could not find out what you uploaded" are different
  // statements, and on the screen a farmer checks to see whether DDP is waiting
  // on them, showing the first when the second is true is the harmful direction.
  const [docs, setDocs] = useState<FarmerDocument[] | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    // NOT the `void` idiom: runGuardedLoad catches internally and cannot reject,
    // so an explicit no-op catch states that rather than suppressing an unknown.
    // Same choice, and same reason, as DDPAccessRequests.tsx.
    runGuardedLoad(
      loadFarmerDocuments(),
      () => active,
      {
        onSuccess: rows => {
          setDocs(rows)
          setLoadState('ready')
          setLoadError(null)
        },
        onError: err => {
          setLoadState('failed')
          setLoadError(err instanceof Error ? err.message : 'Your documents could not be loaded.')
        },
      },
    ).catch(() => undefined)
    return () => { active = false }
  }, [])

  const sorted = (docs ?? []).slice().sort((a, b) => {
    const byStatus = STATUS_ORDER[a.reviewStatus] - STATUS_ORDER[b.reviewStatus]
    if (byStatus !== 0) return byStatus
    return (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? '')
  })

  const waiting = sorted.filter(d => needsFarmer(d.reviewStatus))

  return (
    <div className="page-wrap" style={{ maxWidth: 680 }}>
      <div className="page-header farmer-header" style={{ marginBottom: 20 }}>
        <div className="page-eyebrow">{isTh ? 'พอร์ทัลเกษตรกร' : 'SUPPLIER & FARMER PORTAL'}</div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h1 className="page-title">{isTh ? 'เอกสารของฉัน' : 'My evidence'}</h1>
            <p className="page-desc">
              {isTh
                ? 'เอกสารที่คุณอัปโหลด และผลการตรวจสอบของ DDP'
                : 'The documents you uploaded, and what DDP decided about each one'}
            </p>
          </div>
          <button
            className="btn btn-ghost"
            style={{ color: 'rgba(255,255,255,0.8)', padding: '6px 12px', fontSize: 13, flexShrink: 0 }}
            onClick={onGoMyStock}
          >← {isTh ? 'สต็อกของฉัน' : 'My Stock'}</button>
        </div>
      </div>

      {loadState === 'loading' && (
        <div className="scope-loading">
          {isTh ? 'กำลังโหลดเอกสารของคุณ…' : 'Loading your documents…'}
        </div>
      )}

      {/* A failed read is stated as a failure. It must never degrade into an
          empty list, which would tell a farmer that DDP is waiting on nothing. */}
      {loadState === 'failed' && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
          <strong>{isTh ? 'ไม่สามารถโหลดเอกสารได้' : 'Your documents could not be loaded.'}</strong>
          <div style={{ fontSize: 13, marginTop: 6, opacity: 0.85 }}>
            {isTh
              ? 'นี่ไม่ได้หมายความว่าคุณไม่มีเอกสาร — เราไม่สามารถอ่านข้อมูลได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'
              : 'This does not mean you have no documents — we could not read them. Please try again.'}
          </div>
          {loadError && (
            <div style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>{loadError}</div>
          )}
        </div>
      )}

      {loadState === 'ready' && sorted.length === 0 && (
        <div className="empty-state-hero">
          <p className="empty-state-message">
            {isTh
              ? 'คุณยังไม่ได้อัปโหลดเอกสาร เพิ่มใบ COA ได้จากหน้าสต็อกของฉัน'
              : 'You have not uploaded any documents yet. You can add a COA from My Stock.'}
          </p>
          <button className="btn btn-primary" onClick={onGoMyStock} style={{ marginTop: 12 }}>
            {isTh ? 'ไปที่สต็อกของฉัน' : 'Go to My Stock'}
          </button>
        </div>
      )}

      {loadState === 'ready' && waiting.length > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          <strong>
            {isTh
              ? `DDP กำลังรอข้อมูลจากคุณ ${waiting.length} รายการ`
              : `DDP is waiting on you for ${waiting.length} document${waiting.length === 1 ? '' : 's'}.`}
          </strong>
          <div style={{ fontSize: 13, marginTop: 6, opacity: 0.85 }}>
            {isTh
              ? 'อ่านเหตุผลด้านล่าง แล้วอัปโหลดเอกสารที่แก้ไขแล้วกับแบทช์ที่เกี่ยวข้องในหน้าสต็อกของฉัน'
              : 'Read the reason below, then upload a corrected document against the relevant batch from My Stock.'}
          </div>
        </div>
      )}

      {loadState === 'ready' && sorted.map(doc => {
        const label = STATUS_LABEL[doc.reviewStatus]
        const meaning = STATUS_MEANING[doc.reviewStatus]
        const type = TYPE_LABEL[doc.documentType] ?? TYPE_LABEL.other
        const action = needsFarmer(doc.reviewStatus)

        return (
          <div
            key={doc.id}
            className="card"
            style={{
              marginBottom: 12,
              padding: 16,
              borderLeft: action ? '3px solid #d98324' : undefined,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{isTh ? type.th : type.en}</div>
                {doc.fileName && (
                  <div style={{ fontSize: 13, opacity: 0.75, wordBreak: 'break-all' }}>{doc.fileName}</div>
                )}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontWeight: 600 }}>{isTh ? label.th : label.en}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {isTh ? 'อัปโหลด' : 'Uploaded'} {formatDate(doc.uploadedAt, lang)}
                </div>
              </div>
            </div>

            <p style={{ fontSize: 13, marginTop: 10, marginBottom: 0, opacity: 0.9 }}>
              {isTh ? meaning.th : meaning.en}
            </p>

            {/* The note is the whole point of migration 65, so it is quoted
                verbatim and never summarised. The database refuses a decision
                without one, so a decided document that shows no reason here is a
                read problem worth seeing rather than a blank to hide. */}
            {doc.reviewStatus !== 'pending' && (
              <div
                style={{
                  marginTop: 10,
                  padding: '10px 12px',
                  background: 'rgba(0,0,0,0.04)',
                  borderRadius: 6,
                  fontSize: 13,
                }}
              >
                <div style={{ fontSize: 11, textTransform: 'uppercase', opacity: 0.6, marginBottom: 4 }}>
                  {isTh ? 'เหตุผลจาก DDP' : 'DDP’s reason'}
                </div>
                {doc.reviewNote
                  ? <div style={{ whiteSpace: 'pre-wrap' }}>{doc.reviewNote}</div>
                  : <div style={{ opacity: 0.7, fontStyle: 'italic' }}>
                      {isTh
                        ? 'ไม่สามารถแสดงเหตุผลได้ กรุณาติดต่อ DDP'
                        : 'The reason could not be displayed. Please ask DDP.'}
                    </div>}
                {doc.reviewedAt && (
                  <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
                    {isTh ? 'ตรวจสอบเมื่อ' : 'Reviewed'} {formatDate(doc.reviewedAt, lang)}
                  </div>
                )}
              </div>
            )}

            {action && (
              <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onGoMyStock}>
                {isTh ? 'อัปโหลดเอกสารที่แก้ไขแล้ว' : 'Upload a corrected document'}
              </button>
            )}

            {/* Integrity, not authenticity — and the sentence says which. */}
            {doc.sha256Hex && (
              <div style={{ fontSize: 11, opacity: 0.55, marginTop: 10 }}>
                {isTh ? 'ลายนิ้วมือไฟล์' : 'File fingerprint'}{' '}
                <code style={{ wordBreak: 'break-all' }}>{doc.sha256Hex.slice(0, 16)}…</code>
                <div style={{ marginTop: 2 }}>
                  {isTh
                    ? 'ยืนยันว่าไฟล์ที่ DDP เก็บไว้ตรงกับไฟล์ที่คุณส่ง ไม่ใช่การยืนยันว่าห้องปฏิบัติการออกเอกสารนี้'
                    : 'Confirms the file DDP holds is the file you sent. It does not confirm the laboratory issued it.'}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
