import {
  CATEGORY_LABEL,
  type OperationsDeskCategory,
  type OperationsDeskItem,
} from './operationsDesk'
import { PRIORITY_RANK, type OperationsDeskPriority } from './operationsDeskPriority'

/**
 * Operations Desk search, filtering, sorting and summary counts.
 *
 * Pure and display-only. Kept out of the page component so the behaviour is
 * directly testable in this repo's node test environment.
 */

export interface OperationsDeskFilterState {
  search: string
  category: OperationsDeskCategory | 'all'
  priority: OperationsDeskPriority | 'all'
}

export const EMPTY_FILTERS: OperationsDeskFilterState = {
  search: '',
  category: 'all',
  priority: 'all',
}

/**
 * Default ordering: priority first, then `secondaryRank`, then the oldest matter
 * within each group. Items with no reliable date sort after dated ones rather
 * than being assigned a fabricated timestamp. `id` is the final tiebreak so the
 * order is fully deterministic and never depends on input order.
 *
 * `secondaryRank` defaults to 0. Every pre-existing queue leaves it unset, so
 * their comparisons are all 0 - 0 and fall straight through to the age tiebreak
 * exactly as before. It exists so evidence requests can express the eight-group
 * order of contract §11.6, which three display priorities cannot encode alone.
 */
export function sortOperationsDeskItems(items: OperationsDeskItem[]): OperationsDeskItem[] {
  return [...items].sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (byPriority !== 0) return byPriority

    const bySecondary = (a.secondaryRank ?? 0) - (b.secondaryRank ?? 0)
    if (bySecondary !== 0) return bySecondary

    const aTime = timestamp(a.occurredAt)
    const bTime = timestamp(b.occurredAt)
    if (aTime !== bTime) {
      if (aTime === null) return 1
      if (bTime === null) return -1
      return aTime - bTime // oldest first
    }

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

function timestamp(iso: string | undefined): number | null {
  if (!iso) return null
  const value = new Date(iso).getTime()
  return Number.isNaN(value) ? null : value
}

/**
 * Search matches across the fields an operator can actually see, so a result
 * is never hidden behind a field the row does not display.
 */
export function matchesOperationsDeskSearch(item: OperationsDeskItem, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (needle === '') return true
  const haystack = [
    item.title,
    item.entityLabel,
    item.reason,
    item.statusLabel,
    CATEGORY_LABEL[item.category],
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

export function filterOperationsDeskItems(
  items: OperationsDeskItem[],
  filters: OperationsDeskFilterState,
): OperationsDeskItem[] {
  return items.filter(item => {
    if (filters.category !== 'all' && item.category !== filters.category) return false
    if (filters.priority !== 'all' && item.priority !== filters.priority) return false
    return matchesOperationsDeskSearch(item, filters.search)
  })
}

/** Filter then sort, in that order — the page's single entry point. */
export function presentOperationsDeskItems(
  items: OperationsDeskItem[],
  filters: OperationsDeskFilterState,
): OperationsDeskItem[] {
  return sortOperationsDeskItems(filterOperationsDeskItems(items, filters))
}

export interface OperationsDeskSummaryGroup {
  key: string
  label: string
  count: number
  categories: OperationsDeskCategory[]
}

/**
 * Summary strip counts.
 *
 * Only groups backed by real data are produced. There is deliberately no
 * "Due or time-sensitive" group — no authoritative due date exists on any
 * record in this codebase — and no "Buyer Pack blockers" group, because that
 * queue is not implemented (its gate is not reusable; see operationsDesk.ts).
 */
export function summariseOperationsDeskItems(items: OperationsDeskItem[]): OperationsDeskSummaryGroup[] {
  const groups: Omit<OperationsDeskSummaryGroup, 'count'>[] = [
    { key: 'decision', label: 'Requires decision', categories: ['farmer-approval', 'inventory-review'] },
    { key: 'evidence', label: 'Document and COA evidence', categories: ['document', 'coa'] },
    { key: 'evidence-requests', label: 'Evidence requests', categories: ['evidence-request'] },
    { key: 'compliance', label: 'Compliance review', categories: ['compliance'] },
    { key: 'onboarding', label: 'Onboarding', categories: ['onboarding'] },
    { key: 'followup', label: 'Follow-up', categories: ['follow-up'] },
  ]
  return groups.map(group => ({
    ...group,
    count: items.filter(item => group.categories.includes(item.category)).length,
  }))
}

export function countByPriority(
  items: OperationsDeskItem[],
  priority: OperationsDeskPriority,
): number {
  return items.filter(item => item.priority === priority).length
}
