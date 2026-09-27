import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { KeyedMutex } from './mutex.js';
import { containsSensitiveMemory } from './memory-summary.js';
import type { PiMemoryRecord } from "./types.js";

export interface PiMemoryRepository {
  list(ownerId: string): Promise<PiMemoryRecord[]>;
  upsert(record: PiMemoryRecord): Promise<void>;
  clear(ownerId: string): Promise<void>;
  remove(ownerId: string, key: string): Promise<void>;
}

export function memoryId(ownerId: string, key: string): string {
  return 'memory:' + createHash('sha256').update(ownerId + ':' + key).digest('hex').slice(0, 24);
}
const writes = new KeyedMutex();

export class PiMemoryStore implements PiMemoryRepository {
  constructor(private readonly root: string) {}

  private path(ownerId: string): string {
    const safe = Buffer.from(ownerId, "utf8").toString("base64url");
    return join(this.root, `${safe}.json`);
  }

  async list(ownerId: string): Promise<PiMemoryRecord[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(ownerId), "utf8"));
      return Array.isArray(value) ? (value as PiMemoryRecord[]).filter(row => !containsSensitiveMemory(row.key, row.value)) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async upsert(record: PiMemoryRecord): Promise<void> {
    if (containsSensitiveMemory(record.key, record.value)) return;
    return writes.runExclusive(this.path(record.ownerId), async () => {
    const current = await this.list(record.ownerId);
    record = { ...record, memoryId: memoryId(record.ownerId, record.key),
      createdAt: current.find(row => row.key === record.key)?.createdAt ?? record.createdAt };
    const next = current.filter((row) => row.memoryId !== record.memoryId && row.key !== record.key);
    next.push(record);
    await mkdir(this.root, { recursive: true });
    const target = this.path(record.ownerId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
    await rename(temporary, target);
    });
  }

  async clear(ownerId: string): Promise<void> {
    return writes.runExclusive(this.path(ownerId), async () => {
    await mkdir(this.root, { recursive: true });
    const target = this.path(ownerId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, "[]\n", "utf8");
    await rename(temporary, target);
    });
  }

  async remove(ownerId: string, key: string): Promise<void> {
    return writes.runExclusive(this.path(ownerId), async () => {
      const next = (await this.list(ownerId)).filter(row => row.key !== key);
      await mkdir(this.root, { recursive: true });
      const target = this.path(ownerId), temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), 'utf8');
      await rename(temporary, target);
    });
  }
}
