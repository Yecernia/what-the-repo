import { createHash, timingSafeEqual } from "node:crypto";
import type { ProductStore } from "../persistence/store.js";
import type { ConversationOwner } from "../services/conversation-service.js";

interface TokenBinding {
  digest: Buffer;
  ownerId: string;
}

export class McpTokenVerifier {
  private readonly bindings: TokenBinding[];

  constructor(
    private readonly store: ProductStore,
    values: ReadonlyArray<{ token: string; ownerId: string }>,
  ) {
    this.bindings = values.map(({ token, ownerId }) => {
      if (token.length < 32 || token.length > 4096 || !ownerId.trim()) {
        throw new Error("MCP Token 必须为 32-4096 个字符并绑定有效 owner ID");
      }
      return { digest: digestToken(token), ownerId: ownerId.trim() };
    });
  }

  async authenticate(authorization: string | undefined): Promise<ConversationOwner | null> {
    const token = bearerToken(authorization);
    if (!token || token.length > 4096) return null;
    const requested = digestToken(token);
    let ownerId: string | null = null;
    for (const binding of this.bindings) {
      if (timingSafeEqual(requested, binding.digest)) ownerId = binding.ownerId;
    }
    if (!ownerId) return null;
    const user = await this.store.loadUser(ownerId);
    const kind = user?.kind;
    if (kind !== "guest" && kind !== "github") return null;
    return { owner_id: ownerId, kind };
  }
}

function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function digestToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
