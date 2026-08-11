import type { Lang } from '../../types'

/**
 * The farmer's phone screen, rebuilt on the Organic design system.
 *
 * PILOT — NOT WIRED INTO THE APP. Nothing routes here. It exists so the owner
 * can judge the design handoff's look inside the real product before deciding
 * whether to adopt it, and it is deliberately a sibling of FarmerDashboard
 * rather than a rewrite of it: binning this costs one file and one stylesheet.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A RESKIN. The current dashboard opens with a
 * welcome, a completion percentage and six equal quick-action cards. Six equal
 * things are six decisions. The handoff's screen 1 answers one question — what
 * does DDP need from me right now — and orders the page accordingly:
 *
 *   account row → the ONE blocking task → stock at a glance → a named human
 *
 * The six cards do not disappear; they stop being the first thing a farmer
 * meets. (Where they live at desk width is screen 2 of the handoff and is not
 * part of this pilot.)
 *
 * WHAT IS REAL AND WHAT IS NOT. Every value here is passed in. The pilot is
 * rendered from a harness with sample values, because the current dashboard
 * does not load stock — FarmerMyStock does — so wiring real stock in is part of
 * the cost of shipping this, not part of showing it.
 *
 * The Thai strings are placeholders. The handoff says its own Thai was
 * "composed for tone and length only"; these were written the same way and are
 * not fit to ship without a native speaker reading them.
 */

export type BlockingTaskKind = 'evidence' | 'requests' | 'documents' | 'profile'

export interface OrganicStockRow {
  strain: string
  batchCode: string
  quantity: string
  /** listed = visible to buyers; held = something is missing. */
  state: 'listed' | 'held'
}

export interface FarmerDashboardOrganicProps {
  lang: Lang
  onLang: (lang: Lang) => void
  farmName: string
  task: {
    kind: BlockingTaskKind
    /** Days the task has been open; null when it has not been dated. */
    ageDays: number | null
  }
  stock: OrganicStockRow[]
  contact: { name: string; role: string; line: string; href: string }
  onPrimary: () => void
  onContact: () => void
}

/**
 * The copy for each blocking task, in both languages.
 *
 * Held as data rather than branches in the markup so that adding a task kind is
 * a row here, and so the English and Thai for one task sit next to each other
 * where a translator can see them together.
 */
const TASK_COPY: Record<BlockingTaskKind, Record<Lang, { tag: string; title: string; body: string; cta: string }>> = {
  evidence: {
    en: {
      tag: 'DDP is waiting on you',
      title: 'Send a photo of your lab report',
      body: 'DDP cannot clear your stock for buyers until the certificate of analysis is on file. A photo taken on this phone is enough — it does not need to be scanned.',
      cta: 'Take a photo of the COA',
    },
    th: {
      tag: 'DDP กำลังรอคุณอยู่',
      title: 'ส่งภาพถ่ายผลตรวจแล็บของคุณ',
      body: 'DDP ไม่สามารถอนุมัติสินค้าของคุณให้ผู้ซื้อได้ จนกว่าจะได้รับใบรับรองผลการวิเคราะห์ ถ่ายภาพด้วยโทรศัพท์เครื่องนี้ก็เพียงพอแล้ว ไม่จำเป็นต้องสแกน',
      cta: 'ถ่ายภาพ COA',
    },
  },
  requests: {
    en: {
      tag: 'DDP is waiting on you',
      title: 'Answer DDP’s question about your batch',
      body: 'Someone at DDP has asked you something specific about a batch you sent. Your stock stays held until it is answered.',
      cta: 'Read the question',
    },
    th: {
      tag: 'DDP กำลังรอคุณอยู่',
      title: 'ตอบคำถามของ DDP เกี่ยวกับล็อตของคุณ',
      body: 'ทีมงาน DDP มีคำถามเฉพาะเจาะจงเกี่ยวกับล็อตที่คุณส่งมา สินค้าของคุณจะยังไม่ถูกปล่อยจนกว่าจะได้รับคำตอบ',
      cta: 'อ่านคำถาม',
    },
  },
  documents: {
    en: {
      tag: 'DDP is waiting on you',
      title: 'Add your cultivation licence',
      body: 'DDP verifies your licence against Thai FDA records before anything you have is shown to a buyer. A photo of the certificate is enough to start.',
      cta: 'Take a photo of the licence',
    },
    th: {
      tag: 'DDP กำลังรอคุณอยู่',
      title: 'เพิ่มใบอนุญาตเพาะปลูกของคุณ',
      body: 'DDP จะตรวจสอบใบอนุญาตของคุณกับฐานข้อมูล อย. ก่อนที่สินค้าของคุณจะแสดงต่อผู้ซื้อ ถ่ายภาพใบรับรองก็เริ่มได้แล้ว',
      cta: 'ถ่ายภาพใบอนุญาต',
    },
  },
  profile: {
    en: {
      tag: 'One thing left',
      title: 'Finish your farm profile',
      body: 'Your file is open with DDP. Completing it is what lets a buyer see what you have.',
      cta: 'Continue your profile',
    },
    th: {
      tag: 'เหลืออีกอย่างเดียว',
      title: 'กรอกข้อมูลฟาร์มของคุณให้ครบ',
      body: 'DDP ได้เปิดแฟ้มข้อมูลของคุณแล้ว การกรอกให้ครบคือสิ่งที่ทำให้ผู้ซื้อเห็นสินค้าของคุณ',
      cta: 'กรอกข้อมูลต่อ',
    },
  },
}

const UI = {
  en: {
    stock: 'Your stock',
    listed: 'Listed',
    held: 'Held',
    empty: 'Nothing sent to DDP yet.',
    days: (n: number) => `${n} day${n === 1 ? '' : 's'} open`,
    contactCta: 'Message DDP',
  },
  th: {
    stock: 'สินค้าของคุณ',
    listed: 'แสดงต่อผู้ซื้อ',
    held: 'ระงับไว้',
    empty: 'ยังไม่ได้ส่งข้อมูลให้ DDP',
    days: (n: number) => `เปิดค้างไว้ ${n} วัน`,
    contactCta: 'ส่งข้อความถึง DDP',
  },
} as const

export default function FarmerDashboardOrganic({
  lang, onLang, farmName, task, stock, contact, onPrimary, onContact,
}: FarmerDashboardOrganicProps) {
  const t = UI[lang]
  const copy = TASK_COPY[task.kind][lang]

  return (
    // The one class that turns the design system on. Remove it and every rule
    // in organicScoped.css stops matching.
    <div
      className="organic-scope"
      style={{ minHeight: '100vh', padding: 16, display: 'grid', gap: 16, alignContent: 'start' }}
    >
      {/* ── Account row ────────────────────────────────────────────────────
          The farm's name, and the language switch. Thai sits first because
          this screen's reader is a Thai farmer; which language is DEFAULT is a
          behaviour decision and is deliberately left alone by this pilot. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{farmName}</span>
        <div
          style={{
            display: 'flex', gap: 3, padding: 3, borderRadius: 999,
            background: 'var(--color-neutral-200)',
          }}
        >
          {(['th', 'en'] as const).map(code => {
            const active = lang === code
            return (
              <button
                key={code}
                type="button"
                onClick={() => onLang(code)}
                style={{
                  border: 'none', cursor: 'pointer', borderRadius: 999, padding: '5px 12px',
                  fontFamily: 'var(--font-body)', fontSize: 11.5,
                  fontWeight: active ? 600 : 500,
                  background: active ? 'var(--color-neutral-100)' : 'transparent',
                  color: active ? 'var(--color-text)' : 'var(--color-neutral-700)',
                }}
              >
                {code === 'th' ? 'ไทย' : 'EN'}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── The one blocking task ──────────────────────────────────────────
          Terracotta, and the only terracotta on the screen: in this system the
          colour means a named human must act. The primary button is the only
          filled button here for the same reason. */}
      <div style={{ background: 'var(--color-accent-100)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12 }}>
          <span className="tag tag-accent" style={{ fontSize: 10.5 }}>{copy.tag}</span>
          {task.ageDays !== null && (
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace", fontSize: 11,
                color: 'var(--color-accent-800)', whiteSpace: 'nowrap',
              }}
            >
              {t.days(task.ageDays)}
            </span>
          )}
        </div>

        <h2 style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 19, lineHeight: 1.3, margin: '12px 0 0' }}>
          {copy.title}
        </h2>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-accent-900)', margin: '8px 0 16px' }}>
          {copy.body}
        </p>

        {/* 15px text + 15px padding ≈ a 48px target, which is the floor for a
            thumb on a phone. */}
        <button
          type="button"
          className="btn btn-primary btn-block"
          style={{ fontSize: 15, padding: 15 }}
          onClick={onPrimary}
        >
          {copy.cta}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          style={{ fontSize: 14, marginTop: 8 }}
          onClick={onContact}
        >
          {t.contactCta}
        </button>
      </div>

      {/* ── Stock at a glance ──────────────────────────────────────────────
          A list, not a table: at 390px a table either scrolls sideways or
          shrinks past reading size. Sage means cleared, terracotta means held —
          the same two meanings as everywhere else in the system. */}
      <div style={{ background: 'var(--color-neutral-100)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        <div
          style={{
            padding: '14px 16px', fontSize: 12, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-neutral-700)',
          }}
        >
          {t.stock}
        </div>

        {stock.length === 0 ? (
          <div style={{ padding: '0 16px 16px', fontSize: 14, color: 'var(--color-neutral-700)' }}>
            {t.empty}
          </div>
        ) : (
          stock.map(row => (
            <div
              key={row.batchCode}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                padding: '14px 16px', borderTop: '1px solid var(--color-neutral-200)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>{row.strain}</div>
                <div
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5,
                    color: 'var(--color-neutral-600)', marginTop: 2,
                  }}
                >
                  {row.batchCode} · {row.quantity}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: '0 0 auto' }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 9, height: 9, borderRadius: 999,
                    background: row.state === 'listed'
                      ? 'var(--color-accent-2-600)'
                      : 'var(--color-accent-500)',
                  }}
                />
                <span style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>
                  {row.state === 'listed' ? t.listed : t.held}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── A named human ──────────────────────────────────────────────────
          The handoff is explicit that naming a real person is the point, and
          that this must not become a generic support widget. The initials tile
          stands in for a headshot: photography is a shoot brief, not an asset
          that exists. WHO this is remains an open question for DDP. */}
      <div
        style={{
          background: 'var(--color-accent-2-200)', borderRadius: 'var(--radius-lg)', padding: 18,
          display: 'flex', gap: 14, alignItems: 'center',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 48, height: 48, borderRadius: 999, flex: '0 0 auto',
            background: 'var(--color-accent-2-600)', color: 'var(--color-neutral-100)',
            display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 16,
          }}
        >
          {contact.name.split(' ').map(part => part[0]).slice(0, 2).join('')}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-accent-2-900)' }}>
            {contact.name}
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--color-accent-2-900)' }}>{contact.role}</div>
          <a
            href={contact.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 13.5, color: 'var(--color-accent-2-900)', textDecoration: 'underline' }}
          >
            {contact.line}
          </a>
        </div>
      </div>
    </div>
  )
}
