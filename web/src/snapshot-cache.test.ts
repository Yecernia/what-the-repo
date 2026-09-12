import { beforeEach, expect, it } from 'vitest';
import { clearSnapshotCache, getMemorySnapshot, readCachedSnapshot, removeSnapshotCache, writeSnapshotCache } from './snapshot-cache';
import type { Snapshot } from './types';

beforeEach(clearSnapshotCache);

it('keeps same-id language variants separate and removes both when deleting a project', async () => {
  const zh = { snapshot_id: 'same', display_language: 'zh-CN' } as Snapshot;
  const en = { snapshot_id: 'same', display_language: 'en' } as Snapshot;
  writeSnapshotCache('project', zh);
  expect(getMemorySnapshot('project', 'same', 'en')).toBeNull();
  writeSnapshotCache('project', en);
  expect(await readCachedSnapshot('project', 'same', 'zh-CN')).toBe(zh);
  expect(await readCachedSnapshot('project', 'same', 'en')).toBe(en);
  expect(getMemorySnapshot('project', 'new-snapshot', 'en')).toBeNull();
  removeSnapshotCache('project');
  expect(await readCachedSnapshot('project', 'same', 'zh-CN')).toBeNull();
  expect(await readCachedSnapshot('project', 'same', 'en')).toBeNull();
});
