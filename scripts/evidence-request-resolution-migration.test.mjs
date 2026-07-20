// Static regression guard for migration 24 — the Evidence Request & Resolution
// workflow. Reads the SQL as text and locks in the properties that make the
// schema, RPCs and RLS correct and safe, so a future edit cannot silently
// weaken them. The live behavioural proof lives in
// 24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql; the tests below additionally
// assert that VERIFY is NON-VACUOUS — that it actually builds fixtures and
// asserts denial, rather than passing because nothing was exercised.
//
// Contract of record:
//   DDP EVIDENCE REQUEST & RESOLUTION WORKFLOW — BINDING CONTRACT v1.0

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (f) => readFileSync(new URL(f, root), 'utf8')
const strip = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

const FWD_RAW  = read('24_EVIDENCE_REQUEST_RESOLUTION_HARDENING.sql')
const VER_RAW  = read('24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql')
const RBK_RAW  = read('24_EVIDENCE_REQUEST_RESOLUTION_ROLLBACK.sql')
const STO_RAW  = read('24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql')

const FWD = strip(FWD_RAW)
const VER = strip(VER_RAW)
const RBK = strip(RBK_RAW)
const STO = strip(STO_RAW)

const WORKFLOW_TABLES = [
  'evidence_requests',
  'evidence_request_responses',
  'evidence_request_attachments',
  'evidence_request_history',
]

// The 12 canonical RPC names (contract §6.7).
const CANONICAL_RPCS = [
  'create_evidence_request',
  'get_or_create_evidence_response_draft',
  'save_evidence_response_draft',
  'reserve_evidence_attachment',
  'finalize_evidence_attachment',
  'remove_draft_evidence_attachment',
  'link_existing_evidence_document',
  'submit_evidence_response',
  'request_evidence_clarification',
  'resolve_evidence_request',
  'reject_evidence_response',
  'cancel_evidence_request',
]

const CANONICAL_STATUSES = [
  'open', 'farmer_submitted', 'clarification_requested',
  'resolved', 'rejected', 'cancelled',
]

const CANONICAL_CATEGORIES = [
  'farm_identity', 'farm_license', 'gacp_evidence', 'gmp_evidence',
  'export_supporting_document', 'responsible_contact', 'coa', 'batch_identity',
  'inventory_quantity_evidence', 'inventory_photo', 'inventory_video',
  'storage_evidence', 'chain_of_custody', 'other',
]

const CANONICAL_EVENT_TYPES = [
  'request_created', 'response_submitted', 'clarification_requested',
  'request_resolved', 'response_rejected', 'request_cancelled',
  'attachment_uploaded', 'existing_document_linked',
]

// Every function body created by the forward migration, keyed on its name.
function functionBodies(sql) {
  const out = new Map()
  const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-z_]+)\s*\(([\s\S]*?)\)\s*RETURNS([\s\S]*?)(\$[A-Za-z_]*\$)[\s\S]*?\4/gi
  for (const m of sql.matchAll(re)) {
    const [whole, name] = m
    out.set(name, (out.get(name) ?? '') + whole)
  }
  return out
}
const BODIES = functionBodies(FWD)

// Anonymous DO blocks, matched on their own dollar-quote tag.
function doBlocks(sql) {
  return sql.match(/\bDO\s+(\$[A-Za-z_]*\$)[\s\S]*?\1/gi) || []
}
const VERIFY_SECTIONS = Object.fromEntries(
  doBlocks(VER).map((b) => {
    const m = b.match(/VERIFY ([A-Z]) (?:PASSED|FAILED)/)
    return [m ? m[1] : 'unknown', b]
  }),
)

// PL/pgSQL RAISE interpolates with a bare `%`; `%s` is printf syntax and is
// silently wrong here. Same guard the migration-22 suite applies.
function malformedRaisePlaceholders(sql) {
  const found = []
  for (const stmt of sql.match(/\bRAISE\s+(?:EXCEPTION|NOTICE|WARNING|INFO|LOG|DEBUG)\b[\s\S]*?;/gi) || []) {
    for (const [literal] of stmt.matchAll(/'(?:[^']|'')*'/g)) {
      if (/^'%[\s\S]*%'$/.test(literal)) continue
      if (/%s/.test(literal)) found.push(literal)
    }
  }
  return found
}

// ── Structure and transaction safety ────────────────────────────────────────

describe('migration 24 — file family and transaction shape', () => {
  it('forward, VERIFY, ROLLBACK and STORAGE companions all exist and are non-trivial', () => {
    for (const [label, sql] of [['forward', FWD_RAW], ['verify', VER_RAW],
                                ['rollback', RBK_RAW], ['storage', STO_RAW]]) {
      expect(sql.length, `${label} is suspiciously small`).toBeGreaterThan(500)
    }
  })

  it('forward migration is a single atomic transaction', () => {
    expect((FWD.match(/^\s*BEGIN;/gm) || []).length).toBe(1)
    expect((FWD.match(/^\s*COMMIT;/gm) || []).length).toBe(1)
  })

  it('VERIFY is rollback-safe — it ends in ROLLBACK and never commits', () => {
    expect(VER).toMatch(/ROLLBACK;\s*$/)
    expect(VER).not.toMatch(/^\s*COMMIT;/m)
  })

  it('ROLLBACK is transactional', () => {
    expect((RBK.match(/^\s*BEGIN;/gm) || []).length).toBe(1)
    expect((RBK.match(/^\s*COMMIT;/gm) || []).length).toBe(1)
  })

  it('no RAISE statement uses printf-style %s placeholders', () => {
    for (const [label, sql] of [['forward', FWD], ['verify', VER], ['rollback', RBK], ['storage', STO]]) {
      expect(malformedRaisePlaceholders(sql), `${label} has %s in a RAISE format string`).toEqual([])
    }
  })

  it('forward migration declares its migration-21/22 preconditions and fails loudly', () => {
    expect(FWD).toMatch(/precondition failed/i)
    expect(FWD).toMatch(/has_operational_farmer_access/)
    expect(FWD).toMatch(/is_ddp_admin/)
  })
})

// ── Canonical vocabulary (contract §4) ──────────────────────────────────────

describe('migration 24 — canonical vocabulary is not invented or renamed', () => {
  it('defines exactly the six contract statuses', () => {
    const fn = BODIES.get('evidence_request_statuses') ?? ''
    for (const s of CANONICAL_STATUSES) expect(fn).toContain(`'${s}'`)
    // under_review is explicitly NOT a stored status (contract §3.1).
    expect(FWD).not.toMatch(/'under_review'/)
  })

  it('defines the three terminal statuses', () => {
    const fn = BODIES.get('evidence_request_terminal_statuses') ?? ''
    for (const s of ['resolved', 'rejected', 'cancelled']) expect(fn).toContain(`'${s}'`)
    expect(fn).not.toContain("'open'")
    expect(fn).not.toContain("'farmer_submitted'")
  })

  it('defines all fourteen contract categories', () => {
    const fn = BODIES.get('evidence_request_categories') ?? ''
    for (const c of CANONICAL_CATEGORIES) expect(fn).toContain(`'${c}'`)
  })

  it('defines the four contract priorities', () => {
    const fn = BODIES.get('evidence_request_priorities') ?? ''
    for (const p of ['low', 'normal', 'high', 'urgent']) expect(fn).toContain(`'${p}'`)
  })

  it('history constrains event_type to the eight canonical events', () => {
    for (const e of CANONICAL_EVENT_TYPES) expect(FWD).toContain(`'${e}'`)
  })

  it('category/target matrix keeps farm-only and batch-only categories separate', () => {
    const fn = BODIES.get('evidence_category_allows_target') ?? ''
    // Farm-only categories must be gated on farm_profile.
    for (const c of ['farm_identity', 'farm_license', 'gacp_evidence', 'gmp_evidence', 'responsible_contact']) {
      expect(fn).toContain(`'${c}'`)
    }
    // Batch-only categories must be gated on inventory_batch.
    for (const c of ['coa', 'batch_identity', 'inventory_quantity_evidence', 'inventory_photo', 'inventory_video']) {
      expect(fn).toContain(`'${c}'`)
    }
    expect(fn).toMatch(/p_target_type\s*=\s*'farm_profile'/)
    expect(fn).toMatch(/p_target_type\s*=\s*'inventory_batch'/)
    // Anything unrecognised must fall through to false, not to true.
    expect(fn).toMatch(/ELSE\s+false/i)
  })
})

// ── Schema integrity (contract §6) ──────────────────────────────────────────

describe('migration 24 — schema constraints', () => {
  it('creates all four workflow tables', () => {
    for (const t of WORKFLOW_TABLES) {
      expect(FWD).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}\\b`))
    }
  })

  it('enforces exactly one target per request', () => {
    expect(FWD).toContain('evidence_requests_exactly_one_target_check')
    const m = FWD.match(/evidence_requests_exactly_one_target_check CHECK \(([\s\S]*?)\n  \)/)
    const body = m ? m[1] : ''
    expect(body).toMatch(/farm_profile_id IS NOT NULL/)
    expect(body).toMatch(/inventory_batch_id IS NULL/)
    expect(body).toMatch(/inventory_batch_id IS NOT NULL/)
    expect(body).toMatch(/farm_profile_id IS NULL/)
  })

  it('binds category validity to the target type in a CHECK', () => {
    expect(FWD).toMatch(/evidence_requests_category_target_check\s+CHECK \(public\.evidence_category_allows_target\(category, target_type\)\)/)
  })

  it('every foreign key into a target or actor uses ON DELETE RESTRICT', () => {
    // No workflow FK may cascade away audit-relevant rows.
    const tableBlocks = FWD.match(/CREATE TABLE IF NOT EXISTS public\.evidence_[\s\S]*?\n\);/g) || []
    expect(tableBlocks.length).toBe(4)
    for (const block of tableBlocks) {
      for (const [ref] of block.matchAll(/REFERENCES[^,\n]*/g)) {
        expect(ref, `non-RESTRICT FK: ${ref}`).toMatch(/ON DELETE RESTRICT/)
      }
    }
  })

  it('enforces contract text lengths for title, explanation and response text', () => {
    expect(FWD).toMatch(/char_length\(btrim\(title\)\) BETWEEN 3 AND 140/)
    expect(FWD).toMatch(/char_length\(btrim\(explanation\)\) BETWEEN 20 AND 4000/)
    expect(FWD).toMatch(/char_length\(response_text\) <= 4000/)
  })

  it('couples terminal status to closed_at and closed_by', () => {
    expect(FWD).toContain('evidence_requests_terminal_closure_check')
    expect(FWD).toMatch(/closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL/)
  })

  it('permits only one draft response per request', () => {
    expect(FWD).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS evidence_responses_one_draft_per_request_idx[\s\S]*?WHERE state = 'draft'/)
  })

  it('ties submitted_at to response state in both directions', () => {
    expect(FWD).toMatch(/state = 'draft'\s*AND submitted_at IS NULL/)
    expect(FWD).toMatch(/state = 'submitted' AND submitted_at IS NOT NULL/)
  })

  it('creates every index the contract requires', () => {
    const required = [
      'evidence_requests_farm_status_created_idx',
      'evidence_requests_status_priority_due_created_idx',
      'evidence_requests_active_idx',
      'evidence_requests_farm_profile_idx',
      'evidence_requests_inventory_batch_idx',
      'evidence_requests_creator_created_idx',
      'evidence_history_request_created_id_idx',
    ]
    for (const idx of required) expect(FWD).toContain(idx)
  })

  it('constrains the attachment origin discriminator so shapes cannot mix', () => {
    expect(FWD).toContain('evidence_attachments_origin_shape_check')
    const m = FWD.match(/evidence_attachments_origin_shape_check CHECK \(([\s\S]*?)\n  \)/)
    const body = m ? m[1] : ''
    for (const o of ['request_upload', 'existing_farm_document', 'existing_inventory_document']) {
      expect(body).toContain(`'${o}'`)
    }
    // A request_upload must never also carry a linked-document id.
    expect(body).toMatch(/farmer_document_id IS NULL AND inventory_document_id IS NULL/)
  })

  it('requires a digest and finalization timestamp for a ready upload', () => {
    expect(FWD).toContain('evidence_attachments_ready_requires_digest_check')
    expect(FWD).toMatch(/sha256_hex IS NOT NULL AND finalized_at IS NOT NULL/)
    expect(FWD).toMatch(/sha256_hex ~ '\^\[0-9a-f\]\{64\}\$'/)
  })

  it('an uploaded attachment must carry a measured positive size', () => {
    expect(FWD).toContain('evidence_attachments_upload_size_required_check')
    expect(FWD).toMatch(/size_bytes IS NULL OR size_bytes > 0/)
  })

  it('history may omit previous_status ONLY for the creation event', () => {
    expect(FWD).toContain('evidence_history_previous_status_only_null_on_create_check')
    expect(FWD).toMatch(/event_type = 'request_created' AND previous_status IS NULL/)
    expect(FWD).toMatch(/event_type <> 'request_created' AND previous_status IS NOT NULL/)
  })

  it('history requires a 10-2000 character note on every closing event', () => {
    expect(FWD).toContain('evidence_history_note_required_check')
    expect(FWD).toMatch(/char_length\(btrim\(note\)\) BETWEEN 10 AND 2000/)
  })
})

// ── Integrity triggers ──────────────────────────────────────────────────────

describe('migration 24 — integrity triggers', () => {
  it('derives and validates request scope from the target, not the caller', () => {
    const fn = BODIES.get('fn_evidence_request_validate_scope') ?? ''
    expect(fn).toMatch(/FROM public\.farm_profiles/)
    expect(fn).toMatch(/FROM public\.inventory_batches/)
    expect(fn).toMatch(/NEW\.farm_id IS DISTINCT FROM resolved_farm_id/)
    expect(FWD).toMatch(/CREATE TRIGGER trg_evidence_request_validate_scope[\s\S]*?BEFORE INSERT ON public\.evidence_requests/)
  })

  it('rejects an inventory batch that no longer resolves to a farm', () => {
    // inventory_batches.farm_id is ON DELETE SET NULL, so orphans are possible.
    const fn = BODIES.get('fn_evidence_request_validate_scope') ?? ''
    expect(fn).toMatch(/does not resolve to a farm/)
  })

  it('protects every immutable request field', () => {
    const fn = BODIES.get('fn_evidence_request_protect_immutable') ?? ''
    for (const col of ['farm_id', 'target_type', 'farm_profile_id', 'inventory_batch_id',
                       'category', 'title', 'explanation', 'priority', 'due_date',
                       'created_by_user_id']) {
      expect(fn, `immutability not enforced for ${col}`)
        .toMatch(new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}`))
    }
  })

  it('makes history append-only for every role, unconditionally', () => {
    const fn = BODIES.get('fn_evidence_history_append_only') ?? ''
    expect(fn).toMatch(/RAISE EXCEPTION/)
    // The guard must not be conditional — no role or flag may bypass it.
    expect(fn).not.toMatch(/\bIF\b/i)
    expect(FWD).toMatch(/CREATE TRIGGER trg_evidence_history_append_only[\s\S]*?BEFORE UPDATE OR DELETE ON public\.evidence_request_history/)
  })

  it('blocks deletion of requests outright', () => {
    const fn = BODIES.get('fn_evidence_request_no_delete') ?? ''
    expect(fn).toMatch(/RAISE EXCEPTION/)
    expect(fn).not.toMatch(/\bIF\b/i)
  })

  it('makes submitted responses immutable and undeletable', () => {
    const fn = BODIES.get('fn_evidence_response_protect_submitted') ?? ''
    expect(fn).toMatch(/OLD\.state = 'submitted'/)
    expect(fn).toMatch(/cannot be deleted/)
    expect(fn).toMatch(/is immutable/)
    // A submitted response can never revert to draft.
    expect(fn).toMatch(/invalid state change/)
  })

  it('rejects cross-farm attachments and enforces COA batch coupling', () => {
    const fn = BODIES.get('fn_evidence_attachment_validate') ?? ''
    expect(fn).toMatch(/does not belong to farm/)
    expect(fn).toMatch(/req\.category = 'coa'/)
    expect(fn).toMatch(/does not belong to the targeted batch/)
    // Attachment request must equal the response's request.
    expect(fn).toMatch(/NEW\.request_id IS DISTINCT FROM resp\.request_id/)
  })

  it('enforces the 10-attachment and 150 MB per-response limits', () => {
    const fn = BODIES.get('fn_evidence_attachment_validate') ?? ''
    expect(fn).toMatch(/ready_count > 10/)
    expect(fn).toContain('157286400')
  })
})

// ── Authorization (contract §8) ─────────────────────────────────────────────

describe('migration 24 — authorization helper', () => {
  it('can_operationally_access_farm requires role, operational access AND membership', () => {
    const fn = BODIES.get('can_operationally_access_farm') ?? ''
    expect(fn).toMatch(/role = 'farmer'/)
    expect(fn).toMatch(/public\.has_operational_farmer_access\(\)/)
    expect(fn).toMatch(/FROM public\.farm_memberships/)
    expect(fn).toMatch(/user_id = auth\.uid\(\)/)
    // All three must be ANDed — an OR here would be a privilege escalation.
    expect(fn).not.toMatch(/has_operational_farmer_access\(\)\s*OR/)
  })

  it('the helper fails closed on a null session or null farm', () => {
    const fn = BODIES.get('can_operationally_access_farm') ?? ''
    expect(fn).toMatch(/target_farm_id IS NOT NULL/)
    expect(fn).toMatch(/auth\.uid\(\) IS NOT NULL/)
  })

  it('the helper is SECURITY DEFINER with a pinned search_path and no anon grant', () => {
    const fn = BODIES.get('can_operationally_access_farm') ?? ''
    expect(fn).toMatch(/SECURITY DEFINER/)
    expect(fn).toMatch(/SET search_path = public, auth, pg_temp/)
    expect(FWD).toMatch(/REVOKE EXECUTE ON FUNCTION public\.can_operationally_access_farm\(uuid\) FROM anon/)
  })

  it('reads the role from profiles, never from JWT metadata', () => {
    const fn = BODIES.get('can_operationally_access_farm') ?? ''
    expect(fn).toMatch(/FROM public\.profiles/)
    expect(fn).not.toMatch(/jwt|raw_user_meta_data|app_metadata/i)
  })
})

describe('migration 24 — RLS and direct-DML denial', () => {
  it('enables RLS on all four workflow tables', () => {
    for (const t of WORKFLOW_TABLES) {
      expect(FWD).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`))
    }
  })

  it('revokes all direct privilege from PUBLIC, anon and authenticated', () => {
    for (const t of WORKFLOW_TABLES) {
      expect(FWD).toMatch(new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM PUBLIC, anon, authenticated`))
    }
  })

  it('grants ONLY SELECT back, and only to authenticated', () => {
    for (const t of WORKFLOW_TABLES) {
      expect(FWD).toMatch(new RegExp(`GRANT SELECT ON public\\.${t}\\s+TO authenticated`))
    }
    // No INSERT/UPDATE/DELETE grant to a client role anywhere in the migration.
    expect(FWD).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)[^;]*TO\s+(anon|authenticated)/i)
  })

  it('defines no INSERT, UPDATE or DELETE policy on any workflow table', () => {
    const policies = FWD.match(/CREATE POLICY[\s\S]*?;/g) || []
    const workflowPolicies = policies.filter((p) => WORKFLOW_TABLES.some((t) => p.includes(`public.${t}`)))
    expect(workflowPolicies.length).toBeGreaterThan(0)
    for (const p of workflowPolicies) {
      expect(p, `non-SELECT policy found: ${p.slice(0, 80)}`).toMatch(/FOR SELECT/)
    }
  })

  it('every farmer-facing policy routes through can_operationally_access_farm', () => {
    const farmerPolicies = (FWD.match(/CREATE POLICY "[^"]*operational farmer[^"]*"[\s\S]*?;/g) || [])
      .filter((p) => WORKFLOW_TABLES.some((t) => p.includes(`public.${t}`)))
    expect(farmerPolicies.length).toBe(4)
    for (const p of farmerPolicies) {
      expect(p).toMatch(/public\.can_operationally_access_farm\(/)
    }
  })

  it('no policy grants access merely for being authenticated', () => {
    const policies = FWD.match(/CREATE POLICY[\s\S]*?;/g) || []
    for (const p of policies) {
      expect(p, `policy grants blanket authenticated access: ${p.slice(0, 80)}`)
        .not.toMatch(/USING\s*\(\s*true\s*\)/i)
      expect(p).not.toMatch(/auth\.role\(\)\s*=\s*'authenticated'/)
    }
  })

  it('child tables resolve authorization through the owning request, not their own columns', () => {
    for (const t of ['evidence_request_responses', 'evidence_request_attachments', 'evidence_request_history']) {
      const m = FWD.match(new RegExp(`CREATE POLICY "[^"]*operational farmer[^"]*"\\s+ON public\\.${t}[\\s\\S]*?;`))
      expect(m, `no farmer policy for ${t}`).toBeTruthy()
      expect(m[0]).toMatch(/FROM public\.evidence_requests er/)
      expect(m[0]).toMatch(/public\.can_operationally_access_farm\(er\.farm_id\)/)
    }
  })
})

// ── RPCs (contract §6.7) ────────────────────────────────────────────────────

describe('migration 24 — atomic transition RPCs', () => {
  it('defines all twelve canonical RPCs under their contract names', () => {
    for (const rpc of CANONICAL_RPCS) {
      expect(BODIES.has(rpc), `missing RPC: ${rpc}`).toBe(true)
    }
  })

  it('every RPC is SECURITY DEFINER with an explicit search_path', () => {
    for (const rpc of CANONICAL_RPCS) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn, `${rpc} is not SECURITY DEFINER`).toMatch(/SECURITY DEFINER/)
      expect(fn, `${rpc} has no pinned search_path`).toMatch(/SET search_path = /)
    }
  })

  it('every RPC has a literal REVOKE from PUBLIC+anon and a GRANT to authenticated', () => {
    // Literal statements, not a format() loop: the repository corpus ACL audit
    // (src/lib/publicFunctionExecuteAcl.test.ts) verifies these statically, and
    // a dynamically built GRANT is invisible to it.
    for (const rpc of CANONICAL_RPCS) {
      expect(FWD, `${rpc} lacks a literal REVOKE`)
        .toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM PUBLIC, anon;`))
      expect(FWD, `${rpc} lacks a literal GRANT`)
        .toMatch(new RegExp(`GRANT\\s+EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) TO authenticated, service_role;`))
    }
    expect(FWD).not.toMatch(/EXECUTE format\('GRANT/)
  })

  it('non-RPC functions carry an explicit no-grant decision', () => {
    const noGrant = [
      'evidence_apply_transition', 'evidence_lock_visible_request',
      'evidence_request_as_json', 'evidence_actor_role',
      'evidence_request_statuses', 'evidence_request_terminal_statuses',
      'evidence_request_priorities', 'evidence_request_categories',
      'evidence_category_allows_target', 'evidence_mime_allowed',
      'evidence_max_size_bytes', 'evidence_document_mime',
      'fn_evidence_request_validate_scope', 'fn_evidence_request_protect_immutable',
      'fn_evidence_request_no_delete', 'fn_evidence_response_protect_submitted',
      'fn_evidence_attachment_validate', 'fn_evidence_history_append_only',
    ]
    for (const fn of noGrant) {
      expect(FWD_RAW, `${fn} has no acl-no-grant token`).toContain(`acl-no-grant: ${fn}`)
      expect(FWD, `${fn} is not revoked from PUBLIC/anon`)
        .toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`))
    }
  })

  it('internal helpers are not client-callable', () => {
    expect(FWD).toMatch(/REVOKE EXECUTE ON FUNCTION public\.evidence_apply_transition\([^)]*\) FROM PUBLIC, anon, authenticated/)
    expect(FWD).toMatch(/REVOKE EXECUTE ON FUNCTION public\.evidence_lock_visible_request\([^)]*\) FROM PUBLIC, anon, authenticated/)
  })

  it('request creation is administrator-only and derives farm_id server-side', () => {
    const fn = BODIES.get('create_evidence_request') ?? ''
    expect(fn).toMatch(/NOT public\.is_ddp_admin\(\)/)
    expect(fn).toMatch(/FORBIDDEN/)
    // farm_id is never a parameter of this RPC.
    expect(fn).not.toMatch(/p_farm_id/)
    expect(fn).toMatch(/SELECT farm_id INTO resolved_farm_id/)
    expect(fn).toMatch(/TARGET_UNAVAILABLE/)
  })

  it('request creation writes its history event in the same transaction', () => {
    const fn = BODIES.get('create_evidence_request') ?? ''
    expect(fn).toMatch(/INSERT INTO public\.evidence_request_history/)
    expect(fn).toMatch(/'request_created'/)
  })

  it('the shared transition helper locks, checks revision, then writes history', () => {
    const fn = BODIES.get('evidence_apply_transition') ?? ''
    expect(fn).toMatch(/FOR UPDATE/)
    expect(fn).toMatch(/req\.revision IS DISTINCT FROM p_expected_rev/)
    expect(fn).toMatch(/CONFLICT/)
    expect(fn).toMatch(/revision\s*=\s*revision \+ 1/)
    expect(fn).toMatch(/INSERT INTO public\.evidence_request_history/)
    // Status update and history insert must be in the same function body.
    expect(fn.indexOf('UPDATE public.evidence_requests'))
      .toBeLessThan(fn.indexOf('INSERT INTO public.evidence_request_history'))
  })

  it('every administrator decision RPC enforces its source status', () => {
    for (const [rpc, from] of [
      ['request_evidence_clarification', 'farmer_submitted'],
      ['resolve_evidence_request', 'farmer_submitted'],
      ['reject_evidence_response', 'farmer_submitted'],
    ]) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn, `${rpc} does not gate on ${from}`).toMatch(new RegExp(`req\\.status <> '${from}'`))
      expect(fn).toMatch(/INVALID_TRANSITION/)
    }
  })

  it('administrator decision RPCs require admin authority', () => {
    for (const rpc of ['request_evidence_clarification', 'resolve_evidence_request',
                       'reject_evidence_response', 'cancel_evidence_request']) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn, `${rpc} does not require admin`).toMatch(/evidence_lock_visible_request\(p_request_id, true\)/)
    }
  })

  it('cancellation is administrator-only and refused once terminal', () => {
    const fn = BODIES.get('cancel_evidence_request') ?? ''
    expect(fn).toMatch(/evidence_lock_visible_request\(p_request_id, true\)/)
    expect(fn).toMatch(/evidence_request_terminal_statuses\(\)/)
    expect(fn).toMatch(/INVALID_TRANSITION/)
  })

  it('a decision may only reference the CURRENT submitted response', () => {
    for (const rpc of ['request_evidence_clarification', 'resolve_evidence_request', 'reject_evidence_response']) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn).toMatch(/ORDER BY response_number DESC LIMIT 1/)
      expect(fn).toMatch(/p_reviewed_response_id IS DISTINCT FROM latest_sub_id/)
    }
  })

  it('every administrator decision requires a 10-2000 character reason', () => {
    for (const rpc of ['request_evidence_clarification', 'resolve_evidence_request',
                       'reject_evidence_response', 'cancel_evidence_request']) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn, `${rpc} does not bound its reason`).toMatch(/NOT BETWEEN 10 AND 2000/)
    }
  })

  it('farmer RPCs require the farmer role AND farm authorization', () => {
    for (const rpc of ['get_or_create_evidence_response_draft', 'save_evidence_response_draft',
                       'submit_evidence_response', 'reserve_evidence_attachment',
                       'link_existing_evidence_document']) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn, `${rpc} does not check the farmer role`).toMatch(/evidence_actor_role\(\) IS DISTINCT FROM 'farmer'/)
      expect(fn, `${rpc} does not check farm access`).toMatch(/can_operationally_access_farm\(req\.farm_id\)/)
    }
  })

  it('farmers may only act while the request awaits a response', () => {
    for (const rpc of ['get_or_create_evidence_response_draft', 'save_evidence_response_draft',
                       'submit_evidence_response', 'reserve_evidence_attachment',
                       'link_existing_evidence_document']) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn, `${rpc} does not gate on open/clarification_requested`)
        .toMatch(/req\.status NOT IN \('open','clarification_requested'\)/)
    }
  })

  it('response authorship cannot be forged', () => {
    for (const rpc of ['save_evidence_response_draft', 'submit_evidence_response']) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn, `${rpc} does not verify the draft author`)
        .toMatch(/resp\.created_by_user_id IS DISTINCT FROM auth\.uid\(\)/)
    }
    for (const rpc of ['finalize_evidence_attachment', 'remove_draft_evidence_attachment']) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn, `${rpc} does not verify the attachment owner`)
        .toMatch(/att\.created_by_user_id IS DISTINCT FROM auth\.uid\(\)/)
    }
  })

  it('submission refuses pending uploads and empty responses', () => {
    const fn = BODIES.get('submit_evidence_response') ?? ''
    expect(fn).toMatch(/UPLOAD_NOT_READY/)
    expect(fn).toMatch(/pending_count > 0/)
    expect(fn).toMatch(/btrim\(resp\.response_text\), ''\) = '' AND ready_count = 0/)
  })

  it('a resubmission must supersede the latest submitted response', () => {
    const fn = BODIES.get('submit_evidence_response') ?? ''
    expect(fn).toMatch(/resp\.supersedes_response_id IS DISTINCT FROM latest_sub_id/)
  })

  it('an unauthorized request id is reported as NOT_FOUND, never as FORBIDDEN', () => {
    // Contract §8.4 non-disclosure: existence must not leak across farms.
    const fn = BODIES.get('evidence_lock_visible_request') ?? ''
    const farmerBranch = fn.slice(fn.indexOf('ELSE'))
    expect(farmerBranch).toMatch(/NOT_FOUND/)
    expect(farmerBranch).not.toMatch(/FORBIDDEN/)
  })

  it('uploads validate MIME and size server-side at reservation and finalization', () => {
    for (const rpc of ['reserve_evidence_attachment', 'finalize_evidence_attachment']) {
      const fn = BODIES.get(rpc) ?? ''
      expect(fn, `${rpc} does not validate MIME`).toMatch(/evidence_mime_allowed\(/)
      expect(fn, `${rpc} does not validate size`).toMatch(/evidence_max_size_bytes\(/)
      expect(fn).toMatch(/FILE_TYPE_NOT_ALLOWED/)
      expect(fn).toMatch(/FILE_TOO_LARGE/)
    }
  })

  it('the storage path is server-computed and the filename sanitized', () => {
    const fn = BODIES.get('reserve_evidence_attachment') ?? ''
    // The client never supplies the path.
    expect(fn).not.toMatch(/p_storage_object_path|p_object_path/)
    expect(fn).toMatch(/regexp_replace\(/)
    expect(fn).toMatch(/req\.farm_id \|\| '\/' \|\| p_request_id \|\| '\/' \|\| p_response_id/)
    expect(fn).toMatch(/'evidence-request-files'/)
  })

  it('MIME allow-lists match the contract table', () => {
    const fn = BODIES.get('evidence_mime_allowed') ?? ''
    expect(fn).toMatch(/p_category = 'coa'\s*THEN p_mime = 'application\/pdf'/)
    expect(fn).toMatch(/'inventory_video' THEN p_mime = 'video\/mp4'/)
    // SVG, HTML, archives and executables must never appear as allowed types.
    for (const bad of ['image/svg+xml', 'text/html', 'application/zip', 'application/x-msdownload']) {
      expect(fn).not.toContain(bad)
    }
  })

  it('size ceilings match the contract (20 MB default, 100 MB video)', () => {
    const fn = BODIES.get('evidence_max_size_bytes') ?? ''
    expect(fn).toContain('104857600')
    expect(fn).toContain('20971520')
  })

  it('linking an existing document never fabricates a byte count', () => {
    const fn = BODIES.get('link_existing_evidence_document') ?? ''
    // Neither source table has a size column; NULL is the honest value.
    expect(fn).toMatch(/size_bytes/)
    expect(fn).toMatch(/NULL, auth\.uid\(\)/)
    expect(fn).not.toMatch(/GREATEST\(COALESCE/)
  })

  it('attachment events are recorded in history', () => {
    expect(BODIES.get('finalize_evidence_attachment') ?? '').toMatch(/'attachment_uploaded'/)
    expect(BODIES.get('link_existing_evidence_document') ?? '').toMatch(/'existing_document_linked'/)
  })
})

// ── Storage companion (contract §7) ─────────────────────────────────────────

describe('migration 24 — storage companion', () => {
  it('creates a PRIVATE bucket and never a public one', () => {
    expect(STO).toMatch(/'evidence-request-files'/)
    expect(STO).toMatch(/public\)\s*VALUES \('evidence-request-files', 'evidence-request-files', false\)/)
    expect(STO).toMatch(/DO UPDATE SET public = false/)
    expect(STO).not.toMatch(/public\s*=\s*true/)
  })

  it('guards on storage ownership so it cannot half-apply', () => {
    expect(STO).toMatch(/supabase_storage_admin/)
    expect(STO).toMatch(/precondition failed/i)
  })

  it('is kept out of the forward migration so a storage failure cannot roll it back', () => {
    expect(FWD).not.toMatch(/storage\.objects/)
    expect(FWD).not.toMatch(/storage\.buckets/)
  })

  it('farmer read access is farm-scoped, not user-prefixed', () => {
    expect(STO).toMatch(/can_operationally_access_farm\(\s*NULLIF\(\(string_to_array\(name, '\/'\)\)\[1\], ''\)::uuid\)/)
  })

  it('uploads are only permitted into a reserved pending path on a draft response', () => {
    const m = STO.match(/CREATE POLICY "evidence-request-files: farmer insert reserved path"[\s\S]*?;/)
    expect(m).toBeTruthy()
    expect(m[0]).toMatch(/upload_state = 'pending_upload'/)
    expect(m[0]).toMatch(/a\.created_by_user_id = auth\.uid\(\)/)
    expect(m[0]).toMatch(/r\.state = 'draft'/)
    expect(m[0]).toMatch(/er\.status IN \('open','clarification_requested'\)/)
  })

  it('defines no UPDATE policy — evidence objects are never overwritten', () => {
    expect(STO).not.toMatch(/CREATE POLICY[^;]*FOR UPDATE[^;]*storage\.objects/i)
  })

  it('carries a restrictive backstop so a future permissive policy cannot widen access', () => {
    const m = STO.match(/CREATE POLICY "evidence-request-files: operational farmer or admin"[\s\S]*?;/)
    expect(m).toBeTruthy()
    expect(m[0]).toMatch(/AS RESTRICTIVE/)
    expect(m[0]).toMatch(/is_ddp_admin\(\)/)
    expect(m[0]).toMatch(/can_operationally_access_farm\(/)
  })
})

// ── Rollback safety ─────────────────────────────────────────────────────────

describe('migration 24 — rollback', () => {
  it('drops every object migration 24 creates', () => {
    for (const t of WORKFLOW_TABLES) {
      expect(RBK).toMatch(new RegExp(`DROP TABLE IF EXISTS public\\.${t}`))
    }
    for (const rpc of CANONICAL_RPCS) {
      expect(RBK, `rollback does not drop ${rpc}`).toContain(`DROP FUNCTION IF EXISTS public.${rpc}(`)
    }
    expect(RBK).toContain('DROP FUNCTION IF EXISTS public.can_operationally_access_farm(uuid)')
  })

  it('drops child tables before their parents', () => {
    expect(RBK.indexOf('DROP TABLE IF EXISTS public.evidence_request_history'))
      .toBeLessThan(RBK.indexOf('DROP TABLE IF EXISTS public.evidence_requests'))
    expect(RBK.indexOf('DROP TABLE IF EXISTS public.evidence_request_attachments'))
      .toBeLessThan(RBK.indexOf('DROP TABLE IF EXISTS public.evidence_request_responses'))
  })

  it('never drops an object belonging to migration 21, 22 or 23', () => {
    const foreign = [
      'has_operational_farmer_access', 'handle_new_user', 'is_ddp_admin',
      'has_farm_membership', 'issue_buyer_pack_snapshot',
      'prevent_buyer_pack_mutation', 'prevent_compliance_audit_log_mutation',
      'fn_protect_farm_admin_fields',
    ]
    for (const fn of foreign) {
      expect(RBK, `rollback drops foreign object ${fn}`).not.toMatch(new RegExp(`DROP FUNCTION[^;]*\\b${fn}\\b`))
    }
    // It must not touch pre-existing tables either.
    for (const t of ['profiles', 'farms', 'farm_profiles', 'farm_memberships',
                     'inventory_batches', 'farmer_documents', 'documents']) {
      expect(RBK, `rollback drops pre-existing table ${t}`)
        .not.toMatch(new RegExp(`DROP TABLE[^;]*\\bpublic\\.${t}\\b`))
    }
  })

  it('refuses to destroy live evidence data without explicit opt-in', () => {
    expect(RBK).toMatch(/rollback 24 refused/)
    expect(RBK).toMatch(/evidence\.rollback_destructive/)
    expect(RBK).toMatch(/request_count > 0 OR history_count > 0/)
  })

  it('drops policies before the functions those policies call', () => {
    expect(RBK.indexOf('DROP POLICY IF EXISTS "evidence_requests: operational farmer select own farm"'))
      .toBeLessThan(RBK.indexOf('DROP FUNCTION IF EXISTS public.can_operationally_access_farm(uuid)'))
  })

  it('documents that the storage companion must be rolled back first', () => {
    // These live in the header comment block, so assert against the RAW file.
    expect(RBK_RAW).toMatch(/ORDERING REQUIREMENT/)
    expect(RBK_RAW).toMatch(/STORAGE\.sql/)
  })
})

// ── VERIFY non-vacuity ──────────────────────────────────────────────────────

describe('migration 24 — VERIFY cannot pass vacuously', () => {
  it('has all six verification sections', () => {
    for (const s of ['A', 'B', 'C', 'D', 'E', 'F']) {
      expect(VERIFY_SECTIONS[s], `VERIFY section ${s} is missing`).toBeTruthy()
    }
  })

  it('every section raises on failure rather than only noticing on success', () => {
    for (const [name, block] of Object.entries(VERIFY_SECTIONS)) {
      expect(block, `VERIFY ${name} never raises`).toMatch(/RAISE EXCEPTION 'VERIFY/)
      expect(block, `VERIFY ${name} never reports success`).toMatch(/RAISE NOTICE 'VERIFY/)
    }
  })

  it('section C builds a real fixture and proves the control insert worked first', () => {
    const c = VERIFY_SECTIONS['C'] ?? ''
    expect(c).toMatch(/INSERT INTO public\.farms/)
    expect(c).toMatch(/INSERT INTO public\.farm_profiles/)
    expect(c).toMatch(/INSERT INTO public\.inventory_batches/)
    // Without this, every later "denied" assertion could pass for the wrong reason.
    expect(c).toMatch(/control insert produced no row/)
  })

  it('section C proves each target-integrity rule by attempting the violation', () => {
    const c = VERIFY_SECTIONS['C'] ?? ''
    for (const claim of ['mismatched farm_id was accepted',
                         'a request with two targets was accepted',
                         'a request with no target was accepted',
                         'coa accepted on a farm_profile target',
                         'short title/explanation accepted',
                         'request title was mutable after creation',
                         'a request was deletable']) {
      expect(c, `VERIFY C does not prove: ${claim}`).toContain(claim)
    }
  })

  it('section D proves append-only history and submitted-response immutability', () => {
    const d = VERIFY_SECTIONS['D'] ?? ''
    expect(d).toMatch(/control history insert produced no row/)
    for (const claim of ['history was updatable',
                         'history was deletable',
                         'a submitted response was editable',
                         'a submitted response was deletable',
                         'a second draft was accepted for one request']) {
      expect(d, `VERIFY D does not prove: ${claim}`).toContain(claim)
    }
  })

  it('section B proves no direct DML grant or non-SELECT policy leaked', () => {
    const b = VERIFY_SECTIONS['B'] ?? ''
    expect(b).toMatch(/role_table_grants/)
    expect(b).toMatch(/INSERT','UPDATE','DELETE','TRUNCATE'|'INSERT','UPDATE','DELETE'/)
    expect(b).toMatch(/anon holds a privilege/)
    expect(b).toMatch(/non-SELECT policy exists/)
  })

  it('section E proves the helper fails closed for anonymous callers', () => {
    const e = VERIFY_SECTIONS['E'] ?? ''
    expect(e).toMatch(/can_operationally_access_farm/)
    expect(e).toMatch(/no authenticated session/)
    expect(e).toMatch(/NULL farm id/)
  })

  it('section F proves migrations 21 and 23 survive migration 24', () => {
    const f = VERIFY_SECTIONS['F'] ?? ''
    expect(f).toMatch(/profiles_role_check/)
    expect(f).toMatch(/pending/)
    expect(f).toMatch(/issue_buyer_pack_snapshot/)
    expect(f).toMatch(/has_operational_farmer_access/)
  })

  it('every VERIFY denial assertion is guarded by an explicit ok flag', () => {
    // A bare BEGIN/EXCEPTION with no follow-up IF NOT ok check would swallow the
    // failure and pass silently.
    const denialBlocks = (VER.match(/ok := false;[\s\S]*?END;/g) || [])
    expect(denialBlocks.length).toBeGreaterThanOrEqual(12)
    const ifNotOk = (VER.match(/IF NOT ok THEN RAISE EXCEPTION/g) || [])
    expect(ifNotOk.length).toBe(denialBlocks.length)
  })
})

// ── Feature isolation ───────────────────────────────────────────────────────

describe('migration 24 — isolation from unrelated subsystems', () => {
  it('touches no Buyer Pack object', () => {
    for (const sql of [FWD, RBK, STO]) {
      expect(sql).not.toMatch(/buyer_pack|issue_buyer_pack_snapshot|procurement_decision/i)
    }
  })

  it('touches no Compliance Watchtower object', () => {
    for (const sql of [FWD, RBK, STO]) {
      expect(sql).not.toMatch(/compliance_alerts|compliance_rules|compliance_audit_log|legal_updates|regulatory_sources/i)
    }
  })

  it('does not alter any pre-existing table or policy', () => {
    // Migration 24 may ENABLE RLS only on its own tables.
    for (const [, table] of FWD.matchAll(/ALTER TABLE public\.([a-z_]+)\s+ENABLE ROW LEVEL SECURITY/g)) {
      expect(WORKFLOW_TABLES, `migration 24 alters foreign table ${table}`).toContain(table)
    }
    // It must not drop or replace a policy it does not own.
    for (const [, name] of FWD.matchAll(/DROP POLICY IF EXISTS "([^"]+)"/g)) {
      expect(name, `migration 24 drops foreign policy "${name}"`).toMatch(/^evidence_/)
    }
  })

  it('does not modify migration 22 objects', () => {
    expect(FWD).not.toMatch(/CREATE OR REPLACE FUNCTION public\.has_operational_farmer_access/)
    expect(FWD).not.toMatch(/DROP FUNCTION[^;]*has_operational_farmer_access/)
    expect(RBK).not.toMatch(/has_operational_farmer_access/)
  })

  it('introduces no prohibited compliance or approval language', () => {
    const banned = [
      'fully compliant', 'legally compliant', 'approved for export', 'export-ready',
      'verified supplier', 'verified batch', 'pharmaceutical approved',
      'certified pharmaceutical', 'ready to buy',
    ]
    for (const sql of [FWD_RAW, VER_RAW, RBK_RAW, STO_RAW]) {
      for (const phrase of banned) {
        expect(sql.toLowerCase(), `prohibited phrase "${phrase}"`).not.toContain(phrase)
      }
    }
  })
})
