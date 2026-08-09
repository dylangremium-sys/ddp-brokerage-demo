// ─── Strict frontmatter parser ──────────────────────────────────────────────
//
// WHY NOT YAML
//   A YAML parser is a dependency in the publishing path that accepts far more
//   than this format needs: nested structures, type coercion, anchors, multiple
//   documents. Every one of those is a way for a field to mean something other
//   than what the person writing it intended — `no` becoming false, a version
//   number becoming a float, an indented block becoming a nested object nobody
//   validated.
//
//   The frontmatter here is `key: value` lines and nothing else. A parser for
//   that is forty lines and rejects everything it does not understand, which is
//   the property that matters: unknown keys are an ERROR, not something quietly
//   carried into the output.
//
// WHAT THIS HAS TO DO WITH THE COMPLIANCE BOUNDARY
//   The publishing path must have no route to internal compliance data. The
//   structural half of that is that this reads a file and nothing else — no
//   client, no credentials, no network. The other half is that there is no
//   FIELD here capable of carrying an internal record. A schema that ignores
//   unknown keys would let `supplier_licence: 12345` sit in a file, pass
//   review as noise, and reach a public page the day someone renders unknown
//   fields. Rejecting them closes that off before it can start.

/** A parsed document: its frontmatter fields and the body beneath them. */
export interface ParsedDocument {
  fields: Record<string, string>
  body: string
}

export class FrontmatterError extends Error {}

const DELIMITER = '---'

/**
 * Splits `source` into frontmatter fields and body.
 *
 * Throws rather than returning a partial result. A publishing pipeline that
 * silently accepts a malformed entry publishes a malformed entry.
 */
export function parseFrontmatter(source: string, allowedKeys: readonly string[]): ParsedDocument {
  const normalised = source.replace(/\r\n/g, '\n')
  const lines = normalised.split('\n')

  if (lines[0]?.trim() !== DELIMITER) {
    throw new FrontmatterError('document does not open with a --- frontmatter block')
  }

  const closing = lines.indexOf(DELIMITER, 1)
  if (closing === -1) throw new FrontmatterError('frontmatter block is never closed with ---')

  const fields: Record<string, string> = {}

  for (let i = 1; i < closing; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue

    // Leading whitespace would be the start of a nested structure in YAML. This
    // format has no nesting, so it is a mistake rather than a shape to support.
    if (/^\s/.test(line)) {
      throw new FrontmatterError(
        `line ${i + 1} is indented. Frontmatter is flat "key: value" lines; nesting is not supported.`,
      )
    }

    const separator = line.indexOf(':')
    if (separator === -1) throw new FrontmatterError(`line ${i + 1} is not "key: value"`)

    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()

    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) {
      throw new FrontmatterError(`"${key}" is not a valid field name`)
    }
    if (key in fields) throw new FrontmatterError(`"${key}" appears twice`)
    if (value === '') throw new FrontmatterError(`"${key}" has no value`)

    // THE ASSERTION THAT KEEPS INTERNAL DATA OUT. An unrecognised field is a
    // failure, never something carried along unread — see the module header.
    if (!allowedKeys.includes(key)) {
      throw new FrontmatterError(
        `"${key}" is not an allowed field. Allowed: ${allowedKeys.join(', ')}. ` +
          'Fields are restricted so that no internal record has anywhere to be written.',
      )
    }

    fields[key] = value
  }

  const body = lines.slice(closing + 1).join('\n').trim()
  if (body === '') throw new FrontmatterError('document has no body beneath the frontmatter')

  return { fields, body }
}
