// ─── A deliberately small markdown renderer ─────────────────────────────────
//
// WHY NOT A LIBRARY
//   A markdown library is a dependency in the publishing path, and the good
//   ones support raw HTML passthrough by default. That is exactly the feature
//   this must not have: an entry is authored text that becomes a public page,
//   and if it can carry raw HTML it can carry a script tag, an iframe, or a
//   tracking pixel — on a site whose CSP is otherwise closed.
//
//   So the input is ESCAPED FIRST and the subset is built from the escaped
//   text. There is no path by which markup in a source file becomes markup in
//   the output. That is a stronger property than sanitising afterwards, which
//   depends on the sanitiser knowing every trick.
//
// THE SUBSET
//   Headings (## and ###), paragraphs, unordered and ordered lists, bold,
//   inline code, and links. That is what a regulatory update needs. Anything
//   else an author writes appears as the literal characters they typed, which
//   is visible in review rather than silently dropped.
//
//   Headings start at <h2> on purpose: the page supplies the single <h1> from
//   the entry title, and a body that could emit its own <h1> would produce two.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/**
 * Links are the one construct that emits an attribute, so the URL is checked
 * rather than trusted. Only http(s) and site-relative paths — no `javascript:`,
 * no `data:`, no protocol-relative `//host` that would silently leave the site.
 */
function safeHref(href: string): string | null {
  const trimmed = href.trim()
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) return trimmed
  if (/^\/[^/\s][^\s]*$/.test(trimmed)) return trimmed
  return null
}

/** Inline formatting, applied to already-escaped text. */
function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label: string, href: string) => {
      const safe = safeHref(href)
      // An unsafe URL renders as the literal text the author typed. Visible in
      // review, and never a link.
      return safe ? `<a href="${safe}">${label}</a>` : whole
    })
}

/**
 * Renders `source` to HTML.
 *
 * Escapes first, formats second — see the module header for why that order is
 * the whole security property.
 */
export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source.replace(/\r\n/g, '\n')).split('\n')
  const out: string[] = []

  let paragraph: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    out.push(`<${list.tag}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '') {
      flushAll()
      continue
    }

    const heading = /^(#{2,3})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushAll()
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet) {
      flushParagraph()
      if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] } }
      list.items.push(bullet[1])
      continue
    }

    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed)
    if (numbered) {
      flushParagraph()
      if (list?.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] } }
      list.items.push(numbered[1])
      continue
    }

    flushList()
    paragraph.push(trimmed)
  }

  flushAll()
  return out.join('\n')
}
