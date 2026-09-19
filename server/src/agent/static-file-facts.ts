import { Type } from "typebox";
import type { StaticFileFacts } from "../persistence/analysis-payload.js";

export const STATIC_FILE_INPUT = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 400 }),
  kind: Type.Union([Type.Literal("calls"), Type.Literal("imports"), Type.Literal("exports")]),
  query: Type.Optional(Type.String({ maxLength: 120 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export function staticFilePage(file: StaticFileFacts | null | undefined, input: {
  path: string; kind: "calls" | "imports" | "exports"; query?: string; offset?: number; limit?: number;
}) {
  const query = input.query?.trim().toLowerCase();
  const rows = (file?.[input.kind] ?? []).filter(row => !query ||
    ("callee" in row ? row.callee : "source" in row ? row.source : row.name).toLowerCase().includes(query));
  const start = Math.max(0, Math.floor(input.offset ?? 0));
  const size = Math.min(50, Math.max(1, Math.floor(input.limit ?? 30)));
  const items = rows.slice(start, start + size);
  return {
    path: input.path, kind: input.kind, available: Boolean(file), coverage: "discovered_static_sites",
    items, total: rows.length, next_offset: start + items.length < rows.length ? start + items.length : null,
    syntax_completed: file?.syntax_completed ?? false, semantic_completed: file?.semantic_completed ?? false,
    diagnostics: file?.diagnostics.slice(0, 20) ?? [], diagnostics_total: file?.diagnostics.length ?? 0,
    limitation: "Missing facts are not evidence of absence. Static bindings do not prove unique runtime dispatch.",
  };
}
