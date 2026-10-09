import { useEffect, useState } from 'react';
import type { TeachingPhase } from './types';

/**
 * The friend on the bench scene: on the day a learning route is finished, a friend in an orange sweater comes and
 * leans on the bench behind the learner. Only this browser keeps what it needs, per signed-in owner: the last
 * teaching phase it saw for each project and the local day it last saw one change into `completed`. A project seen
 * for the first time is only a baseline, so routes finished long ago never bring the friend. Storage that cannot be
 * read or written simply means no friend.
 */
export const ROUTE_FRIEND_KEY = 'what-the-repo.route-friend';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
interface FriendRecord { phases: Record<string, TeachingPhase>; day?: string }

/** The viewer's local calendar day, as YYYY-MM-DD. */
export function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

const keyFor = (ownerId: string) => `${ROUTE_FRIEND_KEY}:${ownerId}`;

function read(storage: Store, ownerId: string): FriendRecord {
  const raw = storage.getItem(keyFor(ownerId));
  if (!raw) return { phases: {} };
  let parsed: unknown;
  // A record that cannot be read starts afresh (as a baseline) rather than keeping the friend away for good.
  try { parsed = JSON.parse(raw); } catch { return { phases: {} }; }
  if (!parsed || typeof parsed !== 'object') return { phases: {} };
  const { phases, day } = parsed as Partial<FriendRecord>;
  return { phases: phases && typeof phases === 'object' ? phases : {}, day: typeof day === 'string' ? day : undefined };
}

/**
 * Notes the phases just seen for some projects (the project list, or the open project's study state). When one that
 * was seen before in another phase is now `completed`, today becomes the day a route was finished. Returns whether
 * that day is today.
 */
export function observeRoutePhases(storage: Store | null, ownerId: string, seen: ReadonlyArray<readonly [projectId: string, phase: TeachingPhase]>,
  now: Date = new Date()): boolean {
  if (!storage) return false;
  try {
    const record = read(storage, ownerId);
    let changed = false;
    for (const [projectId, phase] of seen) {
      const before = record.phases[projectId];
      if (before === phase) continue;
      if (before !== undefined && phase === 'completed') record.day = localDay(now);
      record.phases[projectId] = phase;
      changed = true;
    }
    if (changed) storage.setItem(keyFor(ownerId), JSON.stringify(record));
    return record.day === localDay(now);
  } catch {
    return false;
  }
}

/** Whether a route was finished today (local time) by this owner, as this browser saw it. */
export function routeFinishedToday(storage: Store | null, ownerId: string, now: Date = new Date()): boolean {
  if (!storage) return false;
  try {
    return read(storage, ownerId).day === localDay(now);
  } catch {
    return false;
  }
}

export function friendStorage(): Store | null {
  try { return window.localStorage; } catch { return null; }
}

/**
 * Whether the home illustration has the friend today, for the signed-in owner: notes every change of the project list
 * and of the open project's phase, and looks again every few minutes (and when the page is shown again), so a page
 * left open past midnight lets the friend go.
 */
export function useRouteFriend(ownerId: string | null, projects: ReadonlyArray<{ project_id: string; teaching_phase: TeachingPhase }>,
  open: { projectId: string; phase: TeachingPhase } | null): boolean {
  const [today, setToday] = useState(false);
  useEffect(() => {
    if (!ownerId) { setToday(false); return; }
    setToday(observeRoutePhases(friendStorage(), ownerId, projects.map(item => [item.project_id, item.teaching_phase] as const)));
  }, [ownerId, projects]);
  const openId = open?.projectId, openPhase = open?.phase;
  useEffect(() => {
    if (!ownerId || !openId || !openPhase) return;
    setToday(observeRoutePhases(friendStorage(), ownerId, [[openId, openPhase]]));
  }, [ownerId, openId, openPhase]);
  useEffect(() => {
    if (!ownerId) return;
    const check = () => setToday(routeFinishedToday(friendStorage(), ownerId));
    const timer = window.setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [ownerId]);
  return today;
}
