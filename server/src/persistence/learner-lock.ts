import { KeyedMutex } from '../agent/mutex.js';

const locks = new KeyedMutex();
/** File adapter coordination within one process; PostgreSQL uses transaction locks. */
export function withLearnerLocks<T>(root: string, owners: string[], task: () => Promise<T>): Promise<T> {
  const ids = [...new Set(owners)].sort();
  const enter = (index: number): Promise<T> => index === ids.length ? task()
    : locks.runExclusive(root + ':' + ids[index], () => enter(index + 1));
  return enter(0);
}
