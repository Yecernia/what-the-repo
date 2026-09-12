import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRevisionRedirectChain,
  type RevisionLink,
  type RevisionRedirect,
} from "./lifecycle.js";

const link = (from: string, to: string, created_at = "2026-01-01T00:00:00.000Z"): RevisionLink => ({
  repository_identity: "example/repo",
  from_public_snapshot_key: from,
  to_public_snapshot_key: to,
  created_at,
});

const redirect = (from: string, to: string, old_path: string, kind: RevisionRedirect["kind"], candidates: RevisionRedirect["candidates"]): RevisionRedirect => ({
  repository_identity: "example/repo",
  from_public_snapshot_key: from,
  to_public_snapshot_key: to,
  old_path,
  old_stable_id: null,
  kind,
  candidates,
  created_at: "2026-01-01T00:00:00.000Z",
});

test("revision redirect resolves an unchanged path and tolerates a stable-id hint", () => {
  const result = resolveRevisionRedirectChain({
    fromPublicKey: "A",
    toPublicKey: "B",
    oldPath: "src/unchanged.ts",
    oldStableId: "symbol:old",
    links: [link("A", "B")],
    redirects: [redirect("A", "B", "src/unchanged.ts", "unchanged", [{ path: "src/unchanged.ts", stable_id: null, confidence: 1 }])],
  });
  assert.equal(result?.kind, "unchanged");
  assert.deepEqual(result?.candidates[0]?.path, "src/unchanged.ts");
});

test("revision redirect composes two renamed revisions", () => {
  const result = resolveRevisionRedirectChain({
    fromPublicKey: "A",
    toPublicKey: "C",
    oldPath: "src/old.ts",
    links: [link("A", "B"), link("B", "C")],
    redirects: [
      redirect("A", "B", "src/old.ts", "renamed", [{ path: "src/mid.ts", stable_id: null, confidence: 1 }]),
      redirect("B", "C", "src/mid.ts", "renamed", [{ path: "src/new.ts", stable_id: null, confidence: 0.8 }]),
    ],
  });
  assert.equal(result?.kind, "renamed");
  assert.equal(result?.from_public_snapshot_key, "A");
  assert.equal(result?.to_public_snapshot_key, "C");
  assert.equal(result?.candidates[0]?.path, "src/new.ts");
  assert.equal(result?.candidates[0]?.confidence, 0.8);
});

test("revision redirect preserves deletion without inventing a reason", () => {
  const result = resolveRevisionRedirectChain({
    fromPublicKey: "A",
    toPublicKey: "C",
    oldPath: "src/deleted.ts",
    links: [link("A", "B"), link("B", "C")],
    redirects: [
      redirect("A", "B", "src/deleted.ts", "deleted", []),
    ],
  });
  assert.equal(result?.kind, "deleted");
  assert.deepEqual(result?.candidates, []);
});
