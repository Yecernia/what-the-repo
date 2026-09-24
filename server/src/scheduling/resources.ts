import { randomUUID } from 'node:crypto';
import { controlFailure } from '../services/execution-error.js';
import { performance } from 'node:perf_hooks';
import { delay, LEASE_MS, type PermitRow, type PermitStore, type CapacityPermit } from './permits.js';

export interface ResourceDemand {
  units: number;
  limit: number;
  /** Background work may raise usage only to this level, leaving the rest for users;
   * a larger single demand starts only on an otherwise idle resource. */
  backgroundCeiling?: number;
}
export type ResourceDemands = Record<string, ResourceDemand>;
interface ResourceRow extends PermitRow { demands?: ResourceDemands; task?: string; enqueuedAt?: number }

/** All required resources are granted together: no slot is held while waiting
 * for another pool. The transaction never spans execution or an upstream call. */
export class ResourceScheduler {
  constructor(private readonly store: PermitStore, private readonly namespace = 'resource-admission-v1') {}

  async acquire(input: { owner: string; task: string; demands: ResourceDemands; signal?: AbortSignal;
    waitMs?: number; maxOwnerWaiting?: number; onWaiting?: () => void | Promise<void> }): Promise<CapacityPermit> {
    for (const [name, demand] of Object.entries(input.demands)) {
      if (!name || !Number.isSafeInteger(demand.units) || !Number.isSafeInteger(demand.limit)
        || demand.units < 1 || demand.units > demand.limit) throw new Error('resource_request_exceeds_capacity:' + name);
    }
    const id = randomUUID();
    const lost = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, lost.signal]) : lost.signal;
    const deadline = input.waitMs === undefined ? undefined : AbortSignal.timeout(input.waitMs);
    const waitingSignal = deadline ? AbortSignal.any([signal, deadline]) : signal;
    const renewalController = new AbortController();
    const renewalSignal = AbortSignal.any([signal, renewalController.signal]);
    let admitted = false, released = false, renewing = false;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const release = async () => {
      if (released) return;
      released = true;
      clearInterval(renewal); clearTimeout(watchdog);
      renewalController.abort(new Error('permit_released'));
      if (admitted) await this.store.change(this.namespace, rows => {
        const index = rows.findIndex(row => row.id === id);
        if (index >= 0) rows.splice(index, 1);
      }, AbortSignal.timeout(1000)).catch(() => undefined);
    };
    const change = async (first: boolean, operationSignal: AbortSignal) => this.store.change(this.namespace, (raw, now) => {
      const rows = raw as ResourceRow[];
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.expires <= now) rows.splice(i, 1);
      let own = rows.find(row => row.id === id);
      if (first) {
        // A bounded metadata queue, independent of user-facing accepted jobs.
        if (rows.length >= 4096) throw new Error('resource_admission_overloaded');
        if (rows.filter(row => row.owner === input.owner && row.state === 'waiting').length >= (input.maxOwnerWaiting ?? 64))
          throw new Error('owner_resource_queue_full');
        for (const row of rows) for (const [name, demand] of Object.entries(input.demands)) {
          if (row.demands?.[name] && row.demands[name].limit !== demand.limit)
            throw new Error('resource_capacity_configuration_mismatch:' + name);
        }
        own = { id, owner: input.owner, task: input.task, resource: '', state: 'waiting', enqueuedAt: now,
          order: Math.max(0, ...rows.map(row => row.order)) + 1, expires: now + LEASE_MS,
          deadline: input.waitMs === undefined ? Number.MAX_SAFE_INTEGER : now + input.waitMs, demands: input.demands };
        rows.push(own);
      }
      if (!own) throw new Error('runtime_lease_lost');
      if (own.state === 'waiting' && now >= own.deadline) throw new Error('resource_wait_timeout');
      own.expires = now + LEASE_MS;
      promoteResources(rows, now);
      return own.state;
    }, operationSignal);
    try {
      let started = performance.now();
      let state = await change(true, waitingSignal);
      admitted = true;
      if (state === 'waiting') await input.onWaiting?.();
      let polls = 0;
      while (state === 'waiting') {
        await delay(Math.min(1000, 100 + polls++ * 100) + Math.floor(Math.random() * 50), waitingSignal);
        started = performance.now();
        state = await change(false, waitingSignal);
      }
      waitingSignal.throwIfAborted();
      const arm = (since: number) => {
        clearTimeout(watchdog);
        const remaining = LEASE_MS - 1000 - (performance.now() - since);
        if (remaining <= 0) lost.abort(new Error('runtime_lease_lost'));
        else { watchdog = setTimeout(() => lost.abort(new Error('runtime_lease_lost')), remaining); watchdog.unref(); }
      };
      arm(started);
      renewal = setInterval(() => {
        if (released || renewing || signal.aborted) return;
        renewing = true;
        const since = performance.now();
        void change(false, renewalSignal).then(() => { if (!released && !signal.aborted) arm(since); })
          .catch(error => { if (!released) lost.abort(controlFailure(error)); }).finally(() => { renewing = false; });
      }, LEASE_MS / 3);
      renewal.unref();
      signal.throwIfAborted();
      return { id, signal, release };
    } catch (error) { await release(); throw error; }
  }
}

/** Prefer owners, then tasks with fewer current grants. FIFO breaks ties.
 * Aging reserves contested resources for a large waiter instead of allowing an
 * endless stream of small jobs to starve it. Already executing work is not preempted. */
export function promoteResources(rows: ResourceRow[], now: number): void {
  const running = rows.filter(row => row.state === 'running');
  const waiting = rows.filter(row => row.state === 'waiting' && row.deadline > now);
  const used = (name: string) => running.reduce((sum, row) => sum + (row.demands?.[name]?.units ?? 0), 0);
  const shares = (row: ResourceRow, task: boolean) => running.filter(active => active.owner === row.owner
    && (!task || active.task === row.task) && Object.keys(row.demands ?? {}).some(name => active.demands?.[name])).length;
  const reserved = new Set<string>();
  const background = (row: ResourceRow) => Object.values(row.demands ?? {}).some(demand => demand.backgroundCeiling !== undefined);
  // Users first: background work never jumps ahead of a waiting user demand.
  const pending = [...waiting];
  const userWaiting = (name: string) => pending.some(row => row.state === 'waiting' && !background(row) && row.demands?.[name]);
  while (waiting.length) {
    waiting.sort((a, b) => Number(background(a)) - Number(background(b))
      || shares(a, false) - shares(b, false) || shares(a, true) - shares(b, true) || a.order - b.order);
    const row = waiting.shift()!;
    const demands = Object.entries(row.demands ?? {});
    const fits = ([name, demand]: [string, ResourceDemand]) => {
      if (reserved.has(name) || used(name) + demand.units > demand.limit) return false;
      if (demand.backgroundCeiling === undefined) return true;
      return !userWaiting(name) && (used(name) + demand.units <= demand.backgroundCeiling || used(name) === 0);
    };
    if (demands.every(fits)) {
      row.state = 'running'; running.push(row);
    } else if (!background(row)
      && (now - (row.enqueuedAt ?? now) >= 10_000 || row.order < Math.max(0, ...rows.map(item => item.order)) - 32)) {
      // Only user demands age into a reservation; background work simply waits.
      for (const [name] of demands) reserved.add(name);
    }
  }
}
