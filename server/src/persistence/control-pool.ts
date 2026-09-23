import type { Pool } from 'pg';

// One explicitly owned pool per ProductStore; never create a pool per request,
// scheduler or permit. Reuses the existing object-admission connection budget.
const controls = new WeakMap<object, Pool>();
export function registerControlPool(business: Pool, control: Pool): void {
  controls.set(business, control);
  controls.set(control, control);
}
export function controlPoolFor(pool: Pool): Pool { return controls.get(pool) ?? pool; }
export function registeredControlPool(pool: object): Pool | undefined { return controls.get(pool); }
