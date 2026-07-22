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

  it('every foreign key uses ON DELETE RESTRICT, except the one approved SET NULL', () => {
    // No workflow FK may cascade away audit-relevant rows. The single documented
    // exception is history.attachment_id, which is SET NULL so a draft
    // attachment stays removable while its history event survives (contract
    // §6.4 vs §12.4, approved interpretation).
    const tableBlocks = FWD.match(/CREATE TABLE IF NOT EXISTS public\.evidence_[\s\S]*?\n\);/g) || []
    expect(tableBlocks.length).toBe(4)
    const setNulls = []
    for (const block of tableBlocks) {
      for (const [ref] of block.matchAll(/REFERENCES[^,\n]*/g)) {
        if (/ON DELETE SET NULL/.test(ref)) { setNulls.push(ref); continue }
        expect(ref, `non-RESTRICT FK: ${ref}`).toMatch(/ON DELETE RESTRICT/)
      }
    }
    // Exactly one SET NULL exists, and it is the approved one.
    expect(setNulls.length).toBe(1)
    expect(setNulls[0]).toMatch(/REFERENCES public\.evidence_request_attachments\(id\) ON DELETE SET NULL/)
    // No CASCADE anywhere — that would destroy audit rows.
    for (const block of tableBlocks) expect(block).not.toMatch(/ON DELETE CASCADE/)
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

  it('makes history append-only for every role, with one narrow FK exemption', () => {
    const fn = BODIES.get('fn_evidence_history_append_only') ?? ''
    expect(fn).toMatch(/RAISE EXCEPTION/)
    // The only conditional path is the ON DELETE SET NULL referential action.
    // No role, flag or session setting may bypass the guard — assert that the
    // sole RETURN NEW is gated on the attachment_id nulling shape.
    expect((fn.match(/RETURN NEW/g) || []).length).toBe(1)
    expect(fn).toMatch(/OLD\.attachment_id IS NOT NULL[\s\S]*NEW\.attachment_id IS NULL[\s\S]*RETURN NEW/)
    expect(fn).not.toMatch(/current_setting|session_user|current_user|is_ddp_admin|auth\./i)
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
    // Contract §8.4 non-disclosure: existence must not leak across farms, across
    // the admin path, or via row-lock contention. The helper now has a single
    // refusal code, and visibility is enforced inside the locking SELECT.
    const fn = BODIES.get('evidence_lock_visible_request') ?? ''
    expect(fn).toMatch(/NOT_FOUND/)
    expect(fn).not.toMatch(/FORBIDDEN/)
    expect(fn).toMatch(/AND \(is_admin OR public\.can_operationally_access_farm\(farm_id\)\)/)
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

// ── Codex review remediation (PR #37, head 1b4808a5) ────────────────────────
// Each block below pins a defect Codex found so it cannot silently regress.

describe('migration 24 — Codex P1: COA batch coupling covers BOTH linked origins', () => {
  const fn = () => BODIES.get('fn_evidence_attachment_validate') ?? ''

  it('resolves farm AND batch for a linked farmer document, not farm alone', () => {
    // The original defect: the farmer-document branch selected only fd.farm_id,
    // so the COA batch rule never applied to it.
    expect(fn()).toMatch(/SELECT fd\.farm_id, fd\.inventory_batch_id INTO doc_farm_id, doc_batch_id/)
    expect(fn()).toMatch(/SELECT d\.farm_id, d\.inventory_batch_id INTO doc_farm_id, doc_batch_id/)
  })

  it('applies the farm and COA-batch checks once, to both linked origins', () => {
    const body = fn()
    expect(body).toMatch(/NEW\.origin IN \('existing_farm_document','existing_inventory_document'\)/)
    // Exactly one COA batch check exists, inside the shared branch.
    expect((body.match(/req\.category = 'coa'/g) || []).length).toBe(1)
    expect(body).toMatch(/doc_batch_id IS DISTINCT FROM req\.inventory_batch_id/)
  })

  it('the COA check is not nested inside an inventory-document-only branch', () => {
    const body = fn()
    const shared = body.indexOf("NEW.origin IN ('existing_farm_document'")
    const coa = body.indexOf("req.category = 'coa'")
    expect(shared).toBeGreaterThan(-1)
    expect(coa).toBeGreaterThan(shared)
    // No ELSIF split that could reintroduce per-origin divergence.
    expect(body).not.toMatch(/ELSIF NEW\.origin = 'existing_inventory_document'/)
  })

  it('a null document batch cannot satisfy a batch-targeted COA request', () => {
    // IS DISTINCT FROM is null-safe: NULL vs a real batch id is a mismatch.
    // A plain <> would evaluate to NULL and let the row through.
    expect(fn()).not.toMatch(/doc_batch_id\s*<>\s*req\.inventory_batch_id/)
    expect(fn()).toMatch(/doc_batch_id IS DISTINCT FROM req\.inventory_batch_id/)
  })
})

describe('migration 24 — Codex P1: finalization proves the object exists', () => {
  const fn = () => BODIES.get('finalize_evidence_attachment') ?? ''

  it('reads the real storage.objects row at the reserved bucket and path', () => {
    const body = fn()
    expect(body).toMatch(/FROM storage\.objects o/)
    expect(body).toMatch(/o\.bucket_id = att\.storage_bucket/)
    expect(body).toMatch(/o\.name\s*= att\.storage_object_path/)
  })

  it('fails closed when no object was uploaded', () => {
    const body = fn()
    expect(body).toMatch(/no uploaded object at the reserved path/)
    expect(body).toMatch(/STORAGE_ERROR/)
    // The existence check must precede the row being marked ready.
    expect(body.indexOf('no uploaded object at the reserved path'))
      .toBeLessThan(body.indexOf("SET upload_state = 'ready'"))
  })

  it('fails closed when storage.objects is unavailable rather than assuming success', () => {
    expect(fn()).toMatch(/to_regclass\('storage\.objects'\) IS NULL/)
  })

  it('treats stored metadata as authoritative and rejects a mismatched claim', () => {
    const body = fn()
    expect(body).toMatch(/p_actual_size_bytes IS DISTINCT FROM stored_size/)
    expect(body).toMatch(/p_actual_mime_type IS DISTINCT FROM stored_mime/)
    expect(body).toMatch(/does not match the stored object size/)
    expect(body).toMatch(/does not match the stored object type/)
  })

  it('persists the storage-derived size and MIME, never the caller-supplied claim', () => {
    const body = fn()
    expect(body).toMatch(/effective_size := COALESCE\(stored_size, p_actual_size_bytes\)/)
    expect(body).toMatch(/effective_mime := COALESCE\(stored_mime, p_actual_mime_type\)/)
    expect(body).toMatch(/size_bytes\s*= effective_size/)
    expect(body).toMatch(/mime_type\s*= effective_mime/)
    // The pre-fix behaviour wrote the caller's values straight through.
    expect(body).not.toMatch(/size_bytes\s*= p_actual_size_bytes/)
    expect(body).not.toMatch(/mime_type\s*= p_actual_mime_type/)
  })

  it('validates the allow-list and ceiling against the effective, not claimed, values', () => {
    const body = fn()
    expect(body).toMatch(/evidence_mime_allowed\(req\.category, effective_mime\)/)
    expect(body).toMatch(/evidence_max_size_bytes\(req\.category, effective_mime\)/)
  })

  it('a submitted response therefore cannot contain a never-uploaded attachment', () => {
    // submit refuses pending_upload; finalize is now the only path to 'ready',
    // and it cannot succeed without a real object.
    expect(BODIES.get('submit_evidence_response') ?? '').toMatch(/pending_count > 0/)
    expect(fn()).toMatch(/STORAGE_ERROR/)
  })
})

describe('migration 24 — Codex P2: no request-existence oracle', () => {
  const fn = () => BODIES.get('evidence_lock_visible_request') ?? ''

  it('refuses a non-admin on the admin path with NOT_FOUND, never FORBIDDEN', () => {
    const body = fn()
    expect(body).toMatch(/IF p_require_admin AND NOT is_admin THEN\s*RAISE EXCEPTION 'NOT_FOUND'/)
    expect(body).not.toMatch(/FORBIDDEN/)
  })

  it('refuses before the row is read, so lock contention cannot leak existence either', () => {
    const body = fn()
    expect(body.indexOf('IF p_require_admin AND NOT is_admin'))
      .toBeLessThan(body.indexOf('FROM public.evidence_requests'))
  })

  it('real and fabricated ids are indistinguishable to an unauthorized caller', () => {
    // Every refusal path in this helper yields the same code.
    const raises = fn().match(/RAISE EXCEPTION '([A-Z_]+)'/g) || []
    const codes = new Set(raises.map((r) => r.match(/'([A-Z_]+)'/)[1]))
    expect(codes.has('FORBIDDEN')).toBe(false)
    expect(codes).toContain('NOT_FOUND')
  })

  it('legitimate administrator authorization still passes through', () => {
    expect(fn()).toMatch(/is_admin boolean := public\.is_ddp_admin\(\)/)
    // All four admin RPCs still route through the admin path.
    for (const rpc of ['request_evidence_clarification', 'resolve_evidence_request',
                       'reject_evidence_response', 'cancel_evidence_request']) {
      expect(BODIES.get(rpc) ?? '').toMatch(/evidence_lock_visible_request\(p_request_id, true\)/)
    }
  })

  it('the farmer path still refuses an unauthorized farm with NOT_FOUND', () => {
    // Post-F3 this is enforced by the locking SELECT itself: an unauthorized row
    // never matches, so control falls through to the single NOT_FOUND branch.
    expect(fn()).toMatch(/AND \(is_admin OR public\.can_operationally_access_farm\(farm_id\)\)[\s\S]*?IF NOT FOUND THEN[\s\S]*?NOT_FOUND/)
  })
})

describe('migration 24 — Codex P2: finalization requires an actionable request', () => {
  it('guards on open/clarification_requested like every other farmer RPC', () => {
    expect(BODIES.get('finalize_evidence_attachment') ?? '')
      .toMatch(/req\.status NOT IN \('open','clarification_requested'\)/)
  })

  it('checks the status before touching the response, attachment or history', () => {
    const body = BODIES.get('finalize_evidence_attachment') ?? ''
    const guard = body.indexOf("req.status NOT IN ('open','clarification_requested')")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('FROM public.evidence_request_responses'))
    expect(guard).toBeLessThan(body.indexOf('INSERT INTO public.evidence_request_history'))
  })

  it('cannot append attachment_uploaded history to a cancelled or terminal request', () => {
    const body = BODIES.get('finalize_evidence_attachment') ?? ''
    expect(body.indexOf("req.status NOT IN ('open','clarification_requested')"))
      .toBeLessThan(body.indexOf("'attachment_uploaded'"))
  })

  it('every farmer-facing RPC now carries the actionable-status guard', () => {
    for (const rpc of ['get_or_create_evidence_response_draft', 'save_evidence_response_draft',
                       'submit_evidence_response', 'reserve_evidence_attachment',
                       'link_existing_evidence_document', 'finalize_evidence_attachment']) {
      expect(BODIES.get(rpc) ?? '', `${rpc} lacks the actionable-status guard`)
        .toMatch(/req\.status NOT IN \('open','clarification_requested'\)/)
    }
  })
})

// ── Codex re-review remediation (PR #37, head 57b4e449) ─────────────────────

describe('migration 24 — Codex re-review F1 was a FALSE POSITIVE (guard already present)', () => {
  // Codex re-emitted its earlier "recheck request status" finding against
  // 57b4e449, but the guard was already added in that very commit. No code
  // change was made in response. These assertions pin the ordering so the
  // false positive is documented and the guard cannot regress.
  const fn = () => BODIES.get('finalize_evidence_attachment') ?? ''

  it('the actionable-status guard exists in finalize_evidence_attachment', () => {
    expect(fn()).toMatch(/req\.status NOT IN \('open','clarification_requested'\)/)
  })

  it('the guard precedes the response lookup, attachment lookup AND history insert', () => {
    const b = fn()
    const guard = b.indexOf("req.status NOT IN ('open','clarification_requested')")
    const resp = b.indexOf('FROM public.evidence_request_responses')
    const att = b.indexOf('FROM public.evidence_request_attachments')
    const hist = b.indexOf('INSERT INTO public.evidence_request_history')
    for (const [label, at] of [['response lookup', resp], ['attachment lookup', att], ['history insert', hist]]) {
      expect(at, `${label} not found`).toBeGreaterThan(-1)
      expect(guard, `guard does not precede ${label}`).toBeLessThan(at)
    }
  })

  it('the guard is the first check after authorization, not buried mid-function', () => {
    const b = fn()
    expect(b.indexOf("req.status NOT IN ('open','clarification_requested')"))
      .toBeLessThan(b.indexOf('SELECT * INTO resp'))
  })
})

describe('migration 24 — Codex F2: finalized objects cannot be deleted via storage', () => {
  const policy = () => (STO.match(/CREATE POLICY "evidence-request-files: farmer delete own draft"[\s\S]*?;/) || [''])[0]

  it('the DELETE policy requires explicit removal authorization', () => {
    // Superseded by the two-stage protocol: gating moved from
    // upload_state = 'pending_upload' to removal_requested_at IS NOT NULL,
    // which is strictly stronger — it covers ready AND pending objects.
    expect(policy()).toMatch(/a\.removal_requested_at IS NOT NULL/)
  })

  it('an unauthorized pending upload is no longer casually deletable either', () => {
    const p = policy()
    expect(p).toMatch(/r\.state = 'draft'/)
    expect(p).toMatch(/a\.created_by_user_id = auth\.uid\(\)/)
    // Being merely pending is not sufficient; removal must be authorized first.
    expect(p).not.toMatch(/a\.upload_state = 'pending_upload'/)
    expect(p).toMatch(/a\.removal_requested_at IS NOT NULL/)
  })

  it('a ready/finalized attachment is excluded from direct storage deletion', () => {
    // The policy admits only pending_upload, so 'ready' can never match.
    const p = policy()
    expect(p).not.toMatch(/upload_state\s*(=|IN)\s*'?\(?\s*'ready'/)
    expect(p).not.toMatch(/upload_state IS NOT NULL/)
  })

  it('submitted responses are excluded; a terminal request no longer is', () => {
    // REVISED: requiring an actionable request here made this policy and the
    // removal RPC mutually gating, stranding unsubmitted draft uploads once a
    // request was cancelled/resolved/rejected. Draft-only is what matters.
    const p = policy()
    expect(p).toMatch(/r\.state = 'draft'/)
    expect(p).not.toMatch(/er\.status IN \('open','clarification_requested'\)/)
  })

  it('the policy is scoped to uploads, not linked existing documents', () => {
    expect(policy()).toMatch(/a\.origin = 'request_upload'/)
  })

  it('removal of a ready attachment is therefore only possible via the RPC', () => {
    expect(BODIES.get('remove_draft_evidence_attachment') ?? '')
      .toMatch(/DELETE FROM public\.evidence_request_attachments/)
  })
})

describe('migration 24 — Codex F3: no row-lock existence oracle on the farmer path', () => {
  const fn = () => BODIES.get('evidence_lock_visible_request') ?? ''

  it('the visibility predicate is inside the locking SELECT, not applied after it', () => {
    const b = fn()
    expect(b).toMatch(/WHERE id = p_request_id\s*AND \(is_admin OR public\.can_operationally_access_farm\(farm_id\)\)\s*FOR UPDATE/)
  })

  it('no post-lock visibility re-check remains', () => {
    // The old shape locked the row first and only then evaluated access.
    const b = fn()
    expect(b).not.toMatch(/FOR UPDATE;[\s\S]*NOT public\.can_operationally_access_farm\(req\.farm_id\)/)
  })

  it('an unauthorized real id and a fabricated id take the identical path', () => {
    const b = fn()
    // Both simply fail to match the SELECT, so both hit the same NOT FOUND branch.
    const notFoundBranches = b.match(/IF NOT FOUND THEN\s*RAISE EXCEPTION 'NOT_FOUND'/g) || []
    expect(notFoundBranches.length).toBe(1)
    expect(b).not.toMatch(/FORBIDDEN/)
  })

  it('an authorized farmer still locks the row normally', () => {
    expect(fn()).toMatch(/FOR UPDATE/)
    expect(fn()).toMatch(/RETURN req/)
  })

  it('administrator behaviour is unchanged', () => {
    const b = fn()
    expect(b).toMatch(/is_admin boolean := public\.is_ddp_admin\(\)/)
    expect(b).toMatch(/IF p_require_admin AND NOT is_admin THEN\s*RAISE EXCEPTION 'NOT_FOUND'/)
    expect(b).toMatch(/is_admin OR public\.can_operationally_access_farm\(farm_id\)/)
  })
})

describe('migration 24 — Codex F4: draft attachments removable, history preserved', () => {
  it('history.attachment_id uses ON DELETE SET NULL', () => {
    expect(FWD).toMatch(/attachment_id\s+uuid REFERENCES public\.evidence_request_attachments\(id\) ON DELETE SET NULL/)
    expect(FWD).not.toMatch(/attachment_id\s+uuid REFERENCES public\.evidence_request_attachments\(id\) ON DELETE RESTRICT/)
  })

  it('every other history foreign key stays RESTRICT', () => {
    const block = (FWD.match(/CREATE TABLE IF NOT EXISTS public\.evidence_request_history[\s\S]*?\n\);/) || [''])[0]
    // Column definitions may wrap across lines, so match from the column name up
    // to the terminating comma rather than assuming a single line.
    for (const col of ['request_id', 'actor_user_id', 'response_id']) {
      const m = block.match(new RegExp(`\\n\\s+${col}\\s+uuid[^,]*,`))
      expect(m, `${col} definition not found`).toBeTruthy()
      expect(m[0], `${col} should remain RESTRICT`).toMatch(/ON DELETE RESTRICT/)
    }
    // attachment_id is the only one that is not.
    const att = block.match(/\n\s+attachment_id\s+uuid[^,]*,/)
    expect(att[0]).toMatch(/ON DELETE SET NULL/)
  })

  it('the append-only trigger recognises the referential action', () => {
    // ON DELETE SET NULL runs as an internal UPDATE and fires the trigger; without
    // an explicit exemption the removal would fail with the append-only error.
    const fn = BODIES.get('fn_evidence_history_append_only') ?? ''
    expect(fn).toMatch(/OLD\.attachment_id IS NOT NULL/)
    expect(fn).toMatch(/NEW\.attachment_id IS NULL/)
    expect(fn).toMatch(/RETURN NEW/)
  })

  it('the exemption requires every other column to be unchanged', () => {
    const fn = BODIES.get('fn_evidence_history_append_only') ?? ''
    for (const col of ['id', 'request_id', 'previous_status', 'next_status',
                       'actor_user_id', 'actor_role', 'event_type', 'response_id',
                       'note', 'event_data', 'created_at']) {
      expect(fn, `exemption does not pin ${col}`)
        .toMatch(new RegExp(`NEW\\.${col}\\s+IS NOT DISTINCT FROM OLD\\.${col}`))
    }
  })

  it('any other UPDATE and every DELETE still raise', () => {
    const fn = BODIES.get('fn_evidence_history_append_only') ?? ''
    expect(fn).toMatch(/RAISE EXCEPTION\s*\n?\s*'evidence_request_history is append-only/)
    // The exemption must not cover DELETE.
    expect(fn).not.toMatch(/TG_OP = 'DELETE'[\s\S]*RETURN OLD/)
    // Re-pointing attachment_id to another row is not an exemption.
    expect(fn).toMatch(/NEW\.attachment_id IS NULL/)
  })

  it('the trigger still fires for both UPDATE and DELETE', () => {
    expect(FWD).toMatch(/CREATE TRIGGER trg_evidence_history_append_only[\s\S]*?BEFORE UPDATE OR DELETE ON public\.evidence_request_history/)
  })

  it('the removal RPC is still draft-and-actionable scoped', () => {
    const fn = BODIES.get('remove_draft_evidence_attachment') ?? ''
    expect(fn).toMatch(/resp\.state <> 'draft'/)
    expect(fn).toMatch(/att\.created_by_user_id IS DISTINCT FROM auth\.uid\(\)/)
  })

  it('VERIFY proves removal of a READY draft attachment and history survival', () => {
    const g = VERIFY_SECTIONS['G'] ?? ''
    expect(g, 'VERIFY section G is missing').toBeTruthy()
    expect(g).toMatch(/'ready'/)
    expect(g).toMatch(/fixture history event has no attachment_id/)   // non-vacuity
    expect(g).toMatch(/ready draft attachment was not deleted/)
    expect(g).toMatch(/history event disappeared/)
    expect(g).toMatch(/attachment_id was not nulled/)
    expect(g).toMatch(/altered beyond nulling attachment_id/)
    expect(g).toMatch(/history note became updatable/)
    expect(g).toMatch(/history event_type became updatable/)
    expect(g).toMatch(/history became deletable/)
  })
})

// ── Codex exact-head review remediation (PR #37, head f7b0761) ──────────────

describe('migration 24 — controlled two-stage removal (no SQL object deletion)', () => {
  const fn = () => BODIES.get('remove_draft_evidence_attachment') ?? ''

  it('never deletes from storage.objects in SQL', () => {
    // Supabase requires the Storage API: a SQL DELETE removes only the metadata
    // row and orphans the file.
    for (const sql of [FWD, STO, RBK]) {
      expect(sql).not.toMatch(/DELETE\s+FROM\s+storage\.objects/i)
    }
  })

  it('adds removal_requested_at rather than a third upload_state', () => {
    expect(FWD).toMatch(/removal_requested_at\s+timestamptz/)
    const stateCheck = (FWD.match(/evidence_attachments_upload_state_check[\s\S]*?\)/) || [''])[0]
    expect(stateCheck).toMatch(/'pending_upload','ready'/)
    expect(stateCheck).not.toMatch(/removing|awaiting|deleting/i)
  })

  it('stage 0 — a linked existing document is removed immediately', () => {
    const b = fn()
    expect(b).toMatch(/IF att\.origin <> 'request_upload' THEN[\s\S]*?DELETE FROM public\.evidence_request_attachments[\s\S]*?'REMOVED'/)
  })

  it('stage 1 — an upload with no stored object is removed immediately', () => {
    const b = fn()
    expect(b).toMatch(/SELECT EXISTS \([\s\S]*?FROM storage\.objects o[\s\S]*?\) INTO object_exists/)
    expect(b).toMatch(/IF NOT object_exists THEN[\s\S]*?DELETE FROM public\.evidence_request_attachments[\s\S]*?'REMOVED'/)
  })

  it('phase 1 — the first call authorizes removal and deletes nothing', () => {
    // REVISED with the orphan-race fix. This previously sliced from the marker
    // to the end of the function and asserted no DELETE followed, which only
    // held while the marker was the LAST stage. The marker is now the FIRST
    // stage, so the assertion is scoped to the phase-1 block itself: it must
    // set the marker, return STORAGE_DELETE_REQUIRED, and delete nothing.
    const b = fn()
    const phase1 = b.match(/IF att\.removal_requested_at IS NULL THEN[\s\S]*?END IF;/)?.[0] ?? ''
    expect(phase1).not.toBe('')
    expect(phase1).toMatch(/SET removal_requested_at = now\(\)/)
    expect(phase1).toMatch(/'STORAGE_DELETE_REQUIRED'/)
    expect(phase1).not.toMatch(/DELETE FROM public\.evidence_request_attachments/)
  })

  it('returns a stable result carrying id, bucket and exact path', () => {
    const b = fn()
    for (const key of ['result', 'attachment_id', 'storage_bucket', 'storage_object_path']) {
      expect(b, `result is missing ${key}`).toContain(`'${key}'`)
    }
    expect(b).toMatch(/'STORAGE_DELETE_REQUIRED'/)
    expect(b).toMatch(/'REMOVED'/)
  })

  it('is idempotent — re-authorizing an already-marked attachment is a no-op', () => {
    expect(fn()).toMatch(/IF att\.removal_requested_at IS NULL THEN\s*UPDATE/)
  })

  it('completion after an interrupted Storage API delete lands on REMOVED', () => {
    // REVISED with the orphan-race fix. This asserted the OLD ordering — that
    // the existence check ran BEFORE the removal marker — which is precisely
    // the racy sequence Codex reported: an absence result was trusted while the
    // row was still insertable. The order is now inverted deliberately, so the
    // assertion is inverted with it. Completion (phase 2) is reachable only
    // once the marker is already committed.
    const b = fn()
    expect(b.indexOf('IF att.removal_requested_at IS NULL THEN'))
      .toBeLessThan(b.indexOf('IF NOT object_exists THEN'))
    expect(b).toMatch(/IF NOT object_exists THEN[\s\S]*?DELETE FROM public\.evidence_request_attachments[\s\S]*?'REMOVED'/)
  })

  it('removal is denied on a submitted response, but allowed on a terminal request', () => {
    // REVISED: cleanup eligibility now derives from the DRAFT RESPONSE. A draft
    // attachment is never submitted evidence, so removing it after cancellation
    // destroys nothing of record — and refusing it stranded the file.
    const b = fn()
    expect(b).not.toMatch(/req\.status NOT IN \('open','clarification_requested'\)/)
    expect(b).toMatch(/resp\.state <> 'draft'/)
  })

  it('removal is denied for the wrong user, path or farm', () => {
    const b = fn()
    expect(b).toMatch(/att\.created_by_user_id IS DISTINCT FROM auth\.uid\(\)/)
    expect(b).toMatch(/can_operationally_access_farm\(req\.farm_id\)/)
    // The attachment must belong to this request AND response.
    expect(b).toMatch(/WHERE id = p_attachment_id AND response_id = p_response_id AND request_id = p_request_id/)
  })

  it('submission fails closed while any attachment awaits removal', () => {
    const b = BODIES.get('submit_evidence_response') ?? ''
    expect(b).toMatch(/count\(\*\) FILTER \(WHERE removal_requested_at IS NOT NULL\)/)
    expect(b).toMatch(/removing_count > 0/)
    expect(b).toMatch(/awaiting controlled removal/)
  })

  it('finalization fails closed while the attachment awaits removal', () => {
    const b = BODIES.get('finalize_evidence_attachment') ?? ''
    expect(b).toMatch(/att\.removal_requested_at IS NOT NULL/)
    expect(b).toMatch(/awaiting controlled removal/)
  })

  it('the storage DELETE policy requires explicit removal authorization', () => {
    const p = (STO.match(/CREATE POLICY "evidence-request-files: farmer delete own draft"[\s\S]*?;/) || [''])[0]
    expect(p).toMatch(/a\.removal_requested_at IS NOT NULL/)
    // A ready object is no longer deletable merely because it is pending.
    expect(p).not.toMatch(/a\.upload_state = 'pending_upload'/)
    // Every other condition is retained.
    expect(p).toMatch(/a\.created_by_user_id = auth\.uid\(\)/)
    expect(p).toMatch(/a\.storage_object_path = storage\.objects\.name/)
    expect(p).toMatch(/r\.state = 'draft'/)
    // REVISED: deliberately NOT gated on request status — see the terminal
    // draft-cleanup fix. Farm access remains required.
    expect(p).not.toMatch(/er\.status IN \('open','clarification_requested'\)/)
    expect(p).toMatch(/can_operationally_access_farm\(er\.farm_id\)/)
  })

  it('rollback documents the new column and the Storage API requirement', () => {
    expect(RBK_RAW).toMatch(/removal_requested_at/)
    expect(RBK_RAW).toMatch(/Storage API/)
  })

  it('VERIFY proves the protocol and leaves no orphaned attachment row', () => {
    const i = VERIFY_SECTIONS['I'] ?? ''
    expect(i, 'VERIFY section I is missing').toBeTruthy()
    expect(i).toMatch(/removal_requested_at column is missing/)
    expect(i).toMatch(/did not persist/)                 // non-vacuity
    expect(i).toMatch(/could not be deleted/)
    expect(i).toMatch(/linked document carries a storage path/)
  })
})

describe('migration 24 — stale revision beats status validation (CONFLICT ordering)', () => {
  const ADMIN_RPCS = ['request_evidence_clarification', 'resolve_evidence_request',
                      'reject_evidence_response', 'cancel_evidence_request']

  it('every administrator RPC compares the revision immediately after the locking read', () => {
    for (const rpc of ADMIN_RPCS) {
      const b = BODIES.get(rpc) ?? ''
      expect(b, `${rpc} lacks an early CONFLICT check`)
        .toMatch(/evidence_lock_visible_request\(p_request_id, true\);[\s\S]{0,600}?req\.revision IS DISTINCT FROM p_expected_revision[\s\S]{0,120}?RAISE EXCEPTION 'CONFLICT'/)
    }
  })

  it('CONFLICT precedes status validation, so a stale terminal request is not INVALID_TRANSITION', () => {
    for (const rpc of ADMIN_RPCS) {
      const b = BODIES.get(rpc) ?? ''
      const conflict = b.indexOf("RAISE EXCEPTION 'CONFLICT'")
      const invalid = b.indexOf("RAISE EXCEPTION 'INVALID_TRANSITION'")
      expect(conflict, `${rpc} has no CONFLICT check`).toBeGreaterThan(-1)
      expect(invalid, `${rpc} has no INVALID_TRANSITION check`).toBeGreaterThan(-1)
      expect(conflict, `${rpc} validates status before revision`).toBeLessThan(invalid)
    }
  })

  it('CONFLICT precedes reason validation and every write', () => {
    for (const rpc of ADMIN_RPCS) {
      const b = BODIES.get(rpc) ?? ''
      const conflict = b.indexOf("RAISE EXCEPTION 'CONFLICT'")
      expect(conflict, `${rpc}: reason validated before revision`)
        .toBeLessThan(b.indexOf('NOT BETWEEN 10 AND 2000'))
      expect(conflict, `${rpc}: transition applied before revision check`)
        .toBeLessThan(b.indexOf('evidence_apply_transition'))
    }
  })

  it('the transition helper retains its own revision check as defence in depth', () => {
    const b = BODIES.get('evidence_apply_transition') ?? ''
    expect(b).toMatch(/req\.revision IS DISTINCT FROM p_expected_rev/)
    expect(b).toMatch(/RAISE EXCEPTION 'CONFLICT'/)
  })

  it('farmer transition RPCs keep their revision checks too', () => {
    for (const rpc of ['get_or_create_evidence_response_draft', 'submit_evidence_response']) {
      expect(BODIES.get(rpc) ?? '', `${rpc} lost its CONFLICT check`)
        .toMatch(/RAISE EXCEPTION 'CONFLICT'/)
    }
  })
})

describe('migration 24 — FK cleanup is distinguishable from manual audit mutation', () => {
  const fn = () => BODIES.get('fn_evidence_history_append_only') ?? ''

  it('the exemption requires the referenced attachment to be GONE', () => {
    expect(fn()).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.evidence_request_attachments\s*WHERE id = OLD\.attachment_id\s*\)/)
  })

  it('a manual null-out while the attachment exists cannot satisfy the exemption', () => {
    const b = fn()
    // The existence test is ANDed into the same condition as the shape tests.
    const cond = b.slice(b.indexOf("TG_OP = 'UPDATE'"), b.indexOf('RETURN NEW'))
    expect(cond).toMatch(/NOT EXISTS/)
    expect(cond).toMatch(/OLD\.attachment_id IS NOT NULL/)
    expect(cond).toMatch(/NEW\.attachment_id IS NULL/)
  })

  it('uses no caller-identity or session escape hatch', () => {
    const b = fn()
    for (const bad of ['current_user', 'session_user', 'current_setting', 'auth.role',
                       'auth.uid', 'is_ddp_admin', 'service_role', 'pg_has_role']) {
      expect(b.toLowerCase(), `trigger relies on ${bad}`).not.toContain(bad.toLowerCase())
    }
  })

  it('remains a data-property test, so a privileged role is bound by it too', () => {
    // Exactly one RETURN NEW, gated solely on row shape + attachment absence.
    expect((fn().match(/RETURN NEW/g) || []).length).toBe(1)
  })

  it('VERIFY proves manual nulling fails and FK cleanup still succeeds', () => {
    const h = VERIFY_SECTIONS['H'] ?? ''
    expect(h, 'VERIFY section H is missing').toBeTruthy()
    expect(h).toMatch(/fixture attachment missing/)              // non-vacuity
    expect(h).toMatch(/hand-nulled while the attachment still existed/)
    expect(h).toMatch(/attachment_id was re-pointed/)
    expect(h).toMatch(/FK cleanup did not null attachment_id/)
    expect(h).toMatch(/history row vanished during FK cleanup/)
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

  it('storage DDL is kept out of the forward migration so a storage failure cannot roll it back', () => {
    // The forward migration MAY read storage.objects (finalization proves the
    // uploaded object exists — a plain SELECT needs no table ownership). What it
    // must never do is create/alter policies or buckets, because THAT is what
    // requires supabase_storage_admin and would roll the whole migration back.
    expect(FWD).not.toMatch(/CREATE POLICY[^;]*storage\.objects/i)
    expect(FWD).not.toMatch(/DROP POLICY[^;]*storage\.objects/i)
    expect(FWD).not.toMatch(/ALTER TABLE\s+storage\./i)
    expect(FWD).not.toMatch(/storage\.buckets/)
    // The only permitted contact is a read inside finalization.
    const reads = FWD.match(/storage\.objects/g) || []
    expect(reads.length).toBeGreaterThan(0)
    expect(BODIES.get('finalize_evidence_attachment') ?? '').toMatch(/FROM storage\.objects/)
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
    // Whitespace-tolerant: the guard may be written on one line or wrapped.
    const ifNotOk = (VER.match(/IF NOT ok THEN\s*RAISE EXCEPTION/g) || [])
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

// ── Codex P2: pending removal cannot orphan an in-flight upload ────────────
//
// The reported defect: remove_draft_evidence_attachment deleted the attachment
// row as soon as a point-in-time storage check said "no object". An upload
// already authorized against that still-insertable row could pass the INSERT
// policy on its own snapshot and land AFTER the check — leaving an object with
// no attachment row, no DELETE-policy path, and (because the SELECT policy is
// path-prefix based, not attachment-joined) still readable by farm members.
describe('migration 24 — Codex P2: removal cannot orphan an in-flight upload', () => {
  const body = BODIES.get('remove_draft_evidence_attachment') ?? ''

  it('the removal function exists and is SECURITY DEFINER with a pinned search_path', () => {
    expect(body).not.toBe('')
    expect(FWD).toMatch(/CREATE OR REPLACE FUNCTION public\.remove_draft_evidence_attachment[\s\S]{0,400}?SECURITY DEFINER[\s\S]{0,120}?SET search_path/)
  })

  it('the storage INSERT policy treats an authorized removal as a spent reservation', () => {
    // Without this predicate the removal marker does not stop uploads at all.
    const insertPolicy = STO.match(/CREATE POLICY "evidence-request-files: farmer insert reserved path"[\s\S]*?\);/)?.[0] ?? ''
    expect(insertPolicy).not.toBe('')
    expect(insertPolicy).toMatch(/a\.upload_state\s*=\s*'pending_upload'/)
    expect(insertPolicy).toMatch(/a\.removal_requested_at\s+IS NULL/)
  })

  it('the FIRST call marks removal and returns without deleting the row', () => {
    // Phase 1 must set the marker and RETURN before any DELETE.
    const phase1 = body.match(/IF att\.removal_requested_at IS NULL THEN[\s\S]*?END IF;/)?.[0] ?? ''
    expect(phase1).not.toBe('')
    expect(phase1).toMatch(/UPDATE public\.evidence_request_attachments\s+SET removal_requested_at = now\(\)/)
    expect(phase1).toMatch(/'STORAGE_DELETE_REQUIRED'/)
    expect(phase1, 'phase 1 must not delete the attachment row').not.toMatch(/DELETE FROM public\.evidence_request_attachments/)
  })

  it('no DELETE of the attachment row precedes the removal marker being set', () => {
    // Ordering is the whole fix: for request_upload rows the marker must be
    // established before any deletion decision. The only earlier DELETE is the
    // linked-document path, which owns no storage object at all.
    const markerAt = body.indexOf('SET removal_requested_at = now()')
    const existsAt = body.indexOf('SELECT EXISTS')
    expect(markerAt).toBeGreaterThan(-1)
    expect(existsAt).toBeGreaterThan(-1)
    expect(markerAt, 'existence check must come AFTER the marker is set').toBeLessThan(existsAt)
  })

  it('the deleting DELETE is reachable only after an existence check', () => {
    const tail = body.slice(body.indexOf('SELECT EXISTS'))
    expect(tail).toMatch(/IF NOT object_exists THEN[\s\S]*?DELETE FROM public\.evidence_request_attachments/)
  })

  it('a still-present object keeps the row so the object always has an owner', () => {
    expect(body).toMatch(/'STORAGE_DELETE_REQUIRED'[\s\S]*?END\s*\$\$/)
    // The DELETE policy keys off the attachment row; retaining it is what makes
    // a late-landing object deletable rather than orphaned.
    const deletePolicy = STO.match(/CREATE POLICY "evidence-request-files: farmer delete own draft"[\s\S]*?\);/)?.[0] ?? ''
    expect(deletePolicy).toMatch(/a\.removal_requested_at\s+IS NOT NULL/)
  })

  it('removal stays denied on a non-draft response (terminal requests now clean up)', () => {
    // REVISED alongside the terminal draft-cleanup fix.
    expect(body).not.toMatch(/req\.status NOT IN \('open','clarification_requested'\)/)
    expect(body).toMatch(/resp\.state <> 'draft'/)
  })

  it('linked documents still remove in one step (they own no storage object)', () => {
    expect(body).toMatch(/IF att\.origin <> 'request_upload' THEN[\s\S]*?DELETE FROM public\.evidence_request_attachments/)
  })

  it('finalization stays closed once removal has been authorized', () => {
    const fin = BODIES.get('finalize_evidence_attachment') ?? ''
    expect(fin).toMatch(/att\.removal_requested_at IS NOT NULL[\s\S]{0,200}?RAISE EXCEPTION/)
  })
})

// ── Codex P2: VERIFY I must actually link a document ───────────────────────
describe('migration 24 — Codex P2: VERIFY I is non-vacuous', () => {
  const sectionI = VER.match(/DO \$verify_i\$[\s\S]*?\$verify_i\$;/)?.[0] ?? ''

  it('VERIFY I exists', () => {
    expect(sectionI).not.toBe('')
  })

  it('creates an explicit farmer_documents fixture on the test farm', () => {
    expect(sectionI).toMatch(/INSERT INTO public\.farmer_documents[\s\S]{0,160}?VALUES \(farm_id_v/)
    expect(sectionI).toMatch(/RETURNING id INTO src_doc_id/)
  })

  it('asserts the linked-document insert affected exactly one row', () => {
    expect(sectionI).toMatch(/GET DIAGNOSTICS linked_rows = ROW_COUNT/)
    expect(sectionI).toMatch(/linked_rows <> 1[\s\S]{0,200}?RAISE EXCEPTION/)
  })

  it('no longer selects a source document that may not exist', () => {
    // The original form matched nothing on a freshly created farm.
    expect(sectionI).not.toMatch(/FROM public\.farmer_documents fd WHERE fd\.farm_id = farm_id_v LIMIT 1/)
    expect(sectionI).toMatch(/WHERE fd\.id = src_doc_id AND fd\.farm_id = farm_id_v/)
  })

  it('verifies origin, source document, farm and shape of the linked row', () => {
    expect(sectionI).toMatch(/a\.origin = 'existing_farm_document'/)
    expect(sectionI).toMatch(/a\.farmer_document_id = src_doc_id/)
    expect(sectionI).toMatch(/fd\.farm_id = farm_id_v/)
    expect(sectionI).toMatch(/a\.storage_object_path IS NULL/)
    expect(sectionI).toMatch(/a\.upload_state IS NULL/)
  })

  it('proves a document from another farm is refused', () => {
    expect(sectionI).toMatch(/other_farm_v/)
    expect(sectionI).toMatch(/a document from another farm was linked/)
    expect(sectionI).toMatch(/WHEN check_violation THEN NULL/)
  })

  it('asserts the history event names the linked attachment', () => {
    expect(sectionI).toMatch(/attachment_id = linked_att_id/)
  })
})

// ── Codex P2: direct DML is denied to EVERY client role ────────────────────
describe('migration 24 — Codex P2: append-only history cannot be worked around', () => {
  it('revokes direct write DML from service_role on all four tables', () => {
    // Supabase default privileges grant service_role full DML on new public
    // tables, which allowed DELETE + re-INSERT to erase a history pointer.
    for (const t of ['evidence_requests', 'evidence_request_responses',
      'evidence_request_attachments', 'evidence_request_history']) {
      expect(FWD, `service_role DML not revoked on ${t}`)
        .toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\\.${t}\\s+FROM service_role`))
    }
  })

  it('retains SELECT for back-office reads', () => {
    expect(FWD).not.toMatch(/REVOKE SELECT[^;]*FROM service_role/)
  })

  it('still denies direct DML to PUBLIC, anon and authenticated', () => {
    for (const t of ['evidence_requests', 'evidence_request_responses',
      'evidence_request_attachments', 'evidence_request_history']) {
      expect(FWD).toMatch(new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM PUBLIC, anon, authenticated`))
    }
  })
})

// ── Codex P2: terminal requests must not strand unsubmitted draft evidence ──
describe('migration 24 — Codex P2: terminal draft cleanup', () => {
  const remove = BODIES.get('remove_draft_evidence_attachment') ?? ''
  const deletePolicy = STO.match(/CREATE POLICY "evidence-request-files: farmer delete own draft"[\s\S]*?\);/)?.[0] ?? ''
  const insertPolicy = STO.match(/CREATE POLICY "evidence-request-files: farmer insert reserved path"[\s\S]*?\);/)?.[0] ?? ''

  it('cleanup no longer requires an actionable parent request', () => {
    expect(remove).not.toBe('')
    // The guard that made removal and the storage policy mutually gating.
    expect(remove).not.toMatch(/req\.status NOT IN \('open','clarification_requested'\)/)
  })

  it('cleanup is still gated on a DRAFT response', () => {
    expect(remove).toMatch(/resp\.state <> 'draft'[\s\S]{0,120}?RAISE EXCEPTION 'INVALID_TRANSITION'/)
  })

  it('cleanup still requires operational farm access and attachment ownership', () => {
    expect(remove).toMatch(/NOT public\.can_operationally_access_farm\(req\.farm_id\)/)
    expect(remove).toMatch(/att\.created_by_user_id IS DISTINCT FROM auth\.uid\(\)/)
  })

  it('the storage DELETE policy survives a terminal request but keeps every other gate', () => {
    expect(deletePolicy).not.toBe('')
    expect(deletePolicy).not.toMatch(/er\.status IN \('open','clarification_requested'\)/)
    expect(deletePolicy).toMatch(/a\.removal_requested_at\s+IS NOT NULL/)
    expect(deletePolicy).toMatch(/r\.state = 'draft'/)
    expect(deletePolicy).toMatch(/a\.storage_object_path = storage\.objects\.name/)
    expect(deletePolicy).toMatch(/a\.created_by_user_id = auth\.uid\(\)/)
    expect(deletePolicy).toMatch(/public\.can_operationally_access_farm\(er\.farm_id\)/)
  })

  it('adding evidence STILL requires an actionable request', () => {
    // The INSERT policy must keep the status gate the DELETE policy dropped.
    expect(insertPolicy).toMatch(/er\.status IN \('open','clarification_requested'\)/)
    for (const fn of ['reserve_evidence_attachment', 'link_existing_evidence_document',
      'save_evidence_response_draft', 'submit_evidence_response', 'finalize_evidence_attachment']) {
      expect(BODIES.get(fn) ?? '', `${fn} lost its actionable-request guard`)
        .toMatch(/req\.status NOT IN \('open','clarification_requested'\)|terminal_statuses/)
    }
  })

  it('there is no path-prefix-only delete authority', () => {
    expect(deletePolicy).toMatch(/EXISTS \(/)
    expect(deletePolicy).not.toMatch(/string_to_array\(name/)
  })

  it('the two-phase race correction is preserved', () => {
    const markerAt = remove.indexOf('SET removal_requested_at = now()')
    const existsAt = remove.indexOf('SELECT EXISTS')
    expect(markerAt).toBeGreaterThan(-1)
    expect(existsAt).toBeGreaterThan(-1)
    expect(markerAt, 'marker must still precede the existence check').toBeLessThan(existsAt)
    const phase1 = remove.match(/IF att\.removal_requested_at IS NULL THEN[\s\S]*?END IF;/)?.[0] ?? ''
    expect(phase1).not.toMatch(/DELETE FROM public\.evidence_request_attachments/)
    expect(insertPolicy).toMatch(/a\.removal_requested_at\s+IS NULL/)
  })

  it('VERIFY J covers cancellation, completion, retry and submitted-evidence denial', () => {
    const j = VER.match(/DO \$verify_j\$[\s\S]*?\$verify_j\$;/)?.[0] ?? ''
    expect(j).not.toBe('')
    expect(j).toMatch(/status = 'cancelled'/)
    expect(j).toMatch(/GET DIAGNOSTICS n = ROW_COUNT/)
    expect(j).toMatch(/submitted evidence was deletable/)
    expect(j).toMatch(/retry after completion affected/)
    expect(j).toMatch(/an attachment resolved under the wrong farm/)
  })
})

// ── Storage SELECT must not authorise orphans ──────────────────────────────
describe('migration 24 — storage read authority is tied to a live attachment row', () => {
  const selectPolicy = STO.match(/CREATE POLICY "evidence-request-files: farmer read own farm"[\s\S]*?\);/)?.[0] ?? ''

  it('read is no longer granted on the path prefix alone', () => {
    expect(selectPolicy).not.toBe('')
    expect(selectPolicy).not.toMatch(/string_to_array\(name/)
    expect(selectPolicy).toMatch(/FROM public\.evidence_request_attachments a/)
    expect(selectPolicy).toMatch(/a\.storage_object_path = storage\.objects\.name/)
  })

  it('the farm comes from the request, not from the object name', () => {
    expect(selectPolicy).toMatch(/JOIN public\.evidence_requests er ON er\.id = a\.request_id/)
    expect(selectPolicy).toMatch(/public\.can_operationally_access_farm\(er\.farm_id\)/)
  })

  it('the bucket stays private with no UPDATE policy and no public access', () => {
    expect(STO).not.toMatch(/CREATE POLICY[^;]*FOR UPDATE[^;]*storage\.objects/)
    expect(STO).not.toMatch(/public\s*=\s*true/)
  })
})

// ── Codex P2: filename extension allow-listing ─────────────────────────────
describe('migration 24 — Codex P2: filename extensions are validated', () => {
  const helper = BODIES.get('evidence_filename_extension_allowed') ?? ''
  const reserve = BODIES.get('reserve_evidence_attachment') ?? ''
  const finalize = BODIES.get('finalize_evidence_attachment') ?? ''

  it('the helper exists with the intended signature and safety properties', () => {
    expect(helper).not.toBe('')
    expect(FWD).toMatch(/CREATE OR REPLACE FUNCTION public\.evidence_filename_extension_allowed\(\s*p_category text, p_mime text, p_filename text\s*\)/)
    expect(helper).toMatch(/IMMUTABLE/)
    expect(helper).toMatch(/SET search_path = public, pg_temp/)
    expect(helper).not.toMatch(/EXECUTE\s+format|EXECUTE\s+'/)   // no dynamic SQL
  })

  it('the MIME-to-extension map is complete and matches the MIME allow-list', () => {
    const mimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4']
    for (const m of mimes) expect(helper, `map is missing ${m}`).toContain(`'${m}'`)
    for (const e of ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'mp4']) {
      expect(helper, `map is missing extension ${e}`).toMatch(new RegExp(`'${e}'`))
    }
    // Every MIME the category allow-list can return must appear in the map.
    const allowed = BODIES.get('evidence_mime_allowed') ?? ''
    for (const [, m] of allowed.matchAll(/'((?:application|image|video)\/[a-z0-9+.-]+)'/g)) {
      expect(mimes, `${m} is allowed by MIME policy but absent from the extension map`).toContain(m)
    }
  })

  it('the helper rejects the malformed and traversal cases', () => {
    expect(helper).toMatch(/p_filename IS NULL\s+THEN false/)
    expect(helper).toMatch(/btrim\(p_filename\) = ''\s+THEN false/)
    expect(helper).toMatch(/p_filename ~ '\[\/\\\\\]'\s+THEN false/)     // path separators
    expect(helper).toMatch(/!~ '\\\.\[A-Za-z0-9\]\+\$'/)                 // missing/trailing-dot suffix
  })

  it('the rule is conjunctive — category/MIME consistency is inside the helper', () => {
    expect(helper).toMatch(/NOT public\.evidence_mime_allowed\(p_category, p_mime\)\s+THEN false/)
  })

  it('only the FINAL suffix is compared, case-insensitively', () => {
    expect(helper).toMatch(/lower\(regexp_replace\(p_filename, '\^\.\*\\\.', ''\)\)/)
  })

  it('reservation invokes the helper on the ORIGINAL filename before path construction', () => {
    expect(reserve).toMatch(/public\.evidence_filename_extension_allowed\(req\.category, p_mime_type, p_original_filename\)/)
    const checkAt = reserve.indexOf('evidence_filename_extension_allowed')
    const sanitizeAt = reserve.indexOf('sanitized :=')
    const insertAt = reserve.indexOf('INSERT INTO public.evidence_request_attachments')
    expect(checkAt).toBeGreaterThan(-1)
    expect(checkAt, 'must be validated before sanitization').toBeLessThan(sanitizeAt)
    expect(checkAt, 'must be validated before any row is created').toBeLessThan(insertAt)
  })

  it('finalization revalidates from STORED fields, not caller input', () => {
    expect(finalize).toMatch(/public\.evidence_filename_extension_allowed\(req\.category, att\.mime_type, att\.original_filename\)/)
    expect(finalize).toMatch(/NOT public\.evidence_mime_allowed\(req\.category, att\.mime_type\)/)
    // The canonical path's final extension must agree with the stored filename.
    expect(finalize).toMatch(/att\.storage_object_path[\s\S]{0,160}?att\.original_filename/)
  })

  it('finalization takes no filename argument that could launder a bad reservation', () => {
    expect(FWD).toMatch(/CREATE OR REPLACE FUNCTION public\.finalize_evidence_attachment\([\s\S]{0,200}?\)/)
    const sig = FWD.match(/CREATE OR REPLACE FUNCTION public\.finalize_evidence_attachment\(([\s\S]*?)\)/)?.[1] ?? ''
    expect(sig).not.toMatch(/filename/i)
  })

  it('rollback drops the helper before the allow-list it depends on', () => {
    expect(RBK).toMatch(/DROP FUNCTION IF EXISTS public\.evidence_filename_extension_allowed\(text,text,text\);/)
    expect(RBK.indexOf('evidence_filename_extension_allowed'))
      .toBeLessThan(RBK.indexOf('DROP FUNCTION IF EXISTS public.evidence_mime_allowed'))
  })

  it('VERIFY K covers the accepted and rejected extension cases', () => {
    const k = VER.match(/DO \$verify_k\$[\s\S]*?\$verify_k\$;/)?.[0] ?? ''
    expect(k).not.toBe('')
    for (const c of ['payload.exe', 'report.pdf.exe', 'report.exe.pdf', 'REPORT.PDF',
      "'report.'", 'dir/report.pdf', 'clip.mp4', 'photo.jpeg']) {
      expect(k, `VERIFY K is missing case ${c}`).toContain(c.replace(/^'|'$/g, ''))
    }
    expect(k).toMatch(/checked < 26[\s\S]{0,140}?test would be vacuous/)
  })

  it('the contract comment no longer overstates what is enforced', () => {
    // The claim that both MIME and extension are validated must now be true.
    // The guarantee is now scoped to uploaded evidence, because linked existing
    // documents carry no reliable filename and are deliberately not checked.
    expect(FWD_RAW).toMatch(/both\s*--?\s*MIME and extension are validated/)
    expect(FWD_RAW).toMatch(/LINKED EXISTING documents are deliberately NOT extension-validated/)
    expect(BODIES.get('link_existing_evidence_document') ?? '')
      .not.toContain('evidence_filename_extension_allowed')
    expect(reserve).toContain('evidence_filename_extension_allowed')
  })
})
