import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PiMemoryRecord } from "./types.js";

export interface PiMemoryRepository {
  list(ownerId: string): Promise<PiMemoryRecord[]>;
  upsert(record: PiMemoryRecord): Promise<void>;
  clear(ownerId: string): Promise<void>;
}

export class PiMemoryStore implements PiMemoryRepository {
  constructor(private readonly root: string) {}

  private path(ownerId: string): string {
    const safe = Buffer.from(ownerId, "utf8").toString("base64url");
    return join(this.root, `${safe}.json`);
  }

  async list(ownerId: string): Promise<PiMemoryRecord[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(ownerId), "utf8"));
      return Array.isArray(value) ? value as PiMemoryRecord[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async upsert(record: PiMemoryRecord): Promise<void> {
    const current = await this.list(record.ownerId);
    const next = current.filter((row) => row.memoryId !== record.memoryId && row.key !== record.key);
    next.push(record);
    await mkdir(this.root, { recursive: true });
    const target = this.path(record.ownerId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
    await rename(temporary, target);
  }

  async clear(ownerId: string): Promise<void> {
    const current = await this.list(ownerId);
    if (!current.length) return;
    await mkdir(this.root, { recursive: true });
    const target = this.path(ownerId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, "[]\n", "utf8");
    await rename(temporary, target);
  }
}
