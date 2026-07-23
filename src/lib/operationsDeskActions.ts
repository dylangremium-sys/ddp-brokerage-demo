import type { Page } from '../types'
import type { OperationsDeskItem } from './operationsDesk'

/**
 * Whether a matter's action can open its authoritative record.
 *
 * A stock- or farm-level follow-up can only route to the inventory/farm review
 * when the target row is actually present in the currently loaded arrays. When
 * the farm/inventory source is still loading or (partially) failed — the exact
 * incomplete-source state this desk tolerates — the target may be absent, and
 * the review page would render an empty shell. In that case the action is
 * disabled rather than navigating nowhere. Other destinations (list pages,
 * Watchtower, etc.) carry no per-record target and are always available.
 *
 * Pure, so the enable/disable decision is unit-testable.
 */
export function operationsDeskActionAvailable(
  item: OperationsDeskItem,
  loadedFarmIds: ReadonlySet<string>,
  loadedItemIds: ReadonlySet<string>,
): boolean {
  const farmId = item.destinationParams?.farmId
  const itemId = item.destinationParams?.itemId
  if (item.destinationPage === 'ddp-farm-review') return farmId !== undefined && loadedFarmIds.has(farmId)
  if (item.destinationPage === 'ddp-inventory-review') return itemId !== undefined && loadedItemIds.has(itemId)
  return true
}

/** The navigation an action should perform. `none` = target not loaded → do
 *  nothing (the action is also disabled), so no callback can open an empty shell. */
export type OperationsDeskRoute =
  | { kind: 'open-farm'; farmId: string }
  | { kind: 'open-item'; itemId: string }
  | { kind: 'open-evidence-request'; requestId: string }
  | { kind: 'go'; page: Page }
  | { kind: 'none' }

export function resolveOperationsDeskRoute(
  item: OperationsDeskItem,
  loadedFarmIds: ReadonlySet<string>,
  loadedItemIds: ReadonlySet<string>,
): OperationsDeskRoute {
  if (!operationsDeskActionAvailable(item, loadedFarmIds, loadedItemIds)) return { kind: 'none' }
  const farmId = item.destinationParams?.farmId
  const itemId = item.destinationParams?.itemId
  const requestId = item.destinationParams?.requestId
  if (item.destinationPage === 'ddp-farm-review' && farmId) return { kind: 'open-farm', farmId }
  if (item.destinationPage === 'ddp-inventory-review' && itemId) return { kind: 'open-item', itemId }
  // Contract §11.3/§11.4: an evidence-request row always opens its detail page,
  // including when the target is unavailable — the request itself is loaded by
  // the detail page from its own id, so no desk-side target check applies.
  if (item.destinationPage === 'admin-evidence-request-detail' && requestId) {
    return { kind: 'open-evidence-request', requestId }
  }
  return { kind: 'go', page: item.destinationPage }
}
