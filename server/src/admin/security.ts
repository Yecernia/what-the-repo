import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  encryptProviderKey,
  decryptProviderKey,
} from '../persistence/encrypted-key-vault.js';
import { AdminDocuments } from './documents.js';

export function adminError(statusCode: number, code: string) {
  return Object.assign(new Error(code), { statusCode, code });
}
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function equalSecret(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export function seal(secret: string, purpose: string, value: string): string {
  const row = encryptProviderKey(secret, 'admin', value, purpose);
  return [
    row.ciphertext.toString('base64'),
    row.iv.toString('base64'),
    row.authTag.toString('base64'),
  ].join('.');
}
export function unseal(secret: string, purpose: string, value: string): string {
  const [ciphertext, iv, authTag] = value
    .split('.')
    .map((x) => Buffer.from(x, 'base64'));
  return decryptProviderKey(
    secret,
    'admin',
    { ciphertext: ciphertext!, iv: iv!, authTag: authTag!, keyVersion: 1 },
    purpose,
  );
}
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer) {
  let bits = 0,
    value = 0,
    output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}
function decode32(input: string) {
  let bits = 0,
    value = 0;
  const output: number[] = [];
  for (const c of input) {
    const n = ALPHABET.indexOf(c);
    if (n < 0) throw new Error('invalid_totp_seed');
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
/** RFC 6238, SHA-1, 6 digits, 30 seconds. Also exported for deterministic RFC/offline tests. */
export function totp(seed: string, step: number, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', decode32(seed)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits)
    .toString()
    .padStart(digits, '0');
}
interface Challenge {
  hash: string;
  expires: number;
  pending?: string;
  purpose?: 'enroll' | 'replace';
}
interface Session {
  hash: string;
  csrf: string;
  expires: number;
  lastSeen: number;
}
interface AuthState {
  seed?: string;
  lastStep: number;
  recovery: string[];
  challenges: Challenge[];
  sessions: Session[];
  failures: number;
  lockedUntil: number;
}
const empty = (): AuthState => ({
  lastStep: -1,
  recovery: [],
  challenges: [],
  sessions: [],
  failures: 0,
  lockedUntil: 0,
});
export interface AdminSecurityConfig {
  githubId?: string;
  encryptionSecret: string;
  bootstrapHash?: string;
  production: boolean;
}
export class AdminSecurity {
  constructor(
    readonly documents: AdminDocuments,
    readonly config: AdminSecurityConfig,
    private readonly now = Date.now,
  ) {}
  get enabled() {
    return (
      /^\d+$/.test(this.config.githubId ?? '') &&
      this.config.encryptionSecret.length >= 32
    );
  }
  private key() {
    return 'auth:' + this.config.githubId;
  }
  private async transaction<T>(
    operation: (state: AuthState) => T | Promise<T>,
  ): Promise<T> {
    if (!this.enabled) throw adminError(404, 'admin_unavailable');
    const result = await this.documents.change<
      AuthState,
      { value?: T; error?: string }
    >(this.key(), empty(), async (state) => {
      const now = this.now();
      state.challenges = state.challenges.filter((c) => c.expires > now);
      state.sessions = state.sessions.filter(
        (s) => s.expires > now && s.lastSeen > now - 30 * 60_000,
      );
      try {
        return { value: await operation(state) };
      } catch (error) {
        if (error instanceof Error && 'statusCode' in error)
          return { error: error.message };
        throw error;
      }
    });
    if (result.error)
      throw adminError(
        result.error === 'admin_rate_limited' ? 429 : 403,
        result.error,
      );
    return result.value as T;
  }
  async beginGithub(ownerId: string) {
    if (!this.enabled || ownerId !== `github:${this.config.githubId}`)
      throw adminError(403, 'admin_forbidden');
    const token = randomBytes(32).toString('base64url');
    await this.transaction((state) => {
      state.challenges.push({
        hash: digest(token),
        expires: this.now() + 5 * 60_000,
      });
      state.challenges = state.challenges.slice(-4);
    });
    return token;
  }
  async status(challenge: string, session: string) {
    if (!this.enabled) return { enabled: false, authenticated: false };
    const state = await this.documents.read(this.key(), empty());
    const now = this.now();
    const active = state.sessions.find(
      (s) =>
        s.hash === digest(session) &&
        s.expires > now &&
        s.lastSeen > now - 30 * 60_000,
    );
    return {
      enabled: true,
      authenticated: !!active,
      csrf: active?.csrf,
      expires_at: active?.expires,
      github_verified: state.challenges.some(
        (c) => c.hash === digest(challenge) && c.expires > now,
      ),
      enrolled: !!state.seed,
    };
  }
  private challenge(state: AuthState, token: string) {
    const challenge = state.challenges.find((c) => c.hash === digest(token));
    if (!challenge) throw adminError(403, 'admin_github_required');
    return challenge;
  }
  private check(state: AuthState, seed: string, code: string) {
    if (state.lockedUntil > this.now())
      throw adminError(429, 'admin_rate_limited');
    const current = Math.floor(this.now() / 30_000);
    const step = [current - 1, current, current + 1].find(
      (step) =>
        step > state.lastStep &&
        /^\d{6}$/.test(code) &&
        equalSecret(totp(seed, step), code),
    );
    if (step === undefined) {
      this.fail(state);
      throw adminError(403, 'admin_invalid_code');
    }
    state.lastStep = step;
    state.failures = 0;
  }
  private fail(state: AuthState) {
    state.failures++;
    if (state.failures >= 5) {
      state.lockedUntil = this.now() + 15 * 60_000;
      state.failures = 0;
    }
  }
  async enroll(challengeToken: string, bootstrap: string) {
    return this.transaction((state) => {
      const challenge = this.challenge(state, challengeToken);
      if (state.seed) throw adminError(403, 'admin_already_enrolled');
      if (state.lockedUntil > this.now())
        throw adminError(429, 'admin_rate_limited');
      if (
        !this.config.bootstrapHash ||
        !equalSecret(digest(bootstrap), this.config.bootstrapHash)
      ) {
        this.fail(state);
        throw adminError(403, 'admin_bootstrap_required');
      }
      if (!challenge.pending)
        challenge.pending = seal(
          this.config.encryptionSecret,
          'totp',
          base32(randomBytes(20)),
        );
      challenge.purpose = 'enroll';
      return this.enrollment(challenge.pending);
    });
  }
  private enrollment(encrypted: string) {
    const seed = unseal(this.config.encryptionSecret, 'totp', encrypted);
    return {
      seed,
      uri: `otpauth://totp/what-the-repo:admin?secret=${seed}&issuer=what-the-repo&algorithm=SHA1&digits=6&period=30`,
    };
  }
  private issue(state: AuthState) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    state.sessions.push({
      hash: digest(token),
      csrf,
      expires: this.now() + 8 * 60 * 60_000,
      lastSeen: this.now(),
    });
    state.sessions = state.sessions.slice(-5);
    return { token, csrf };
  }
  private codes(state: AuthState) {
    const codes = Array.from({ length: 10 }, () =>
      randomBytes(12).toString('hex'),
    );
    state.recovery = codes.map(digest);
    return codes;
  }
  async confirm(challengeToken: string, code: string) {
    return this.transaction((state) => {
      const challenge = this.challenge(state, challengeToken);
      if (!challenge.pending)
        throw adminError(403, 'admin_enrollment_required');
      // New verifier has its own replay counter. It is enabled only after proof of possession.
      const oldStep = state.lastStep;
      state.lastStep = -1;
      try {
        this.check(
          state,
          unseal(this.config.encryptionSecret, 'totp', challenge.pending),
          code,
        );
      } catch (error) {
        state.lastStep = oldStep;
        throw error;
      }
      state.seed = challenge.pending;
      state.challenges = [];
      state.sessions = [];
      return { ...this.issue(state), recovery_codes: this.codes(state) };
    });
  }
  async verify(challengeToken: string, code: string) {
    return this.transaction((state) => {
      this.challenge(state, challengeToken);
      if (!state.seed) throw adminError(403, 'admin_enrollment_required');
      this.check(
        state,
        unseal(this.config.encryptionSecret, 'totp', state.seed),
        code,
      );
      state.challenges = state.challenges.filter(
        (c) => c.hash !== digest(challengeToken),
      );
      return this.issue(state);
    });
  }
  /** Recovery grants only verifier replacement, never a management session. */
  async replace(challengeToken: string, code: string, recovery: boolean) {
    return this.transaction((state) => {
      const challenge = this.challenge(state, challengeToken);
      if (!state.seed) throw adminError(403, 'admin_enrollment_required');
      if (state.lockedUntil > this.now())
        throw adminError(429, 'admin_rate_limited');
      if (recovery) {
        const index = state.recovery.indexOf(digest(code));
        if (index < 0) {
          this.fail(state);
          throw adminError(403, 'admin_invalid_code');
        }
        state.recovery.splice(index, 1);
      } else
        this.check(
          state,
          unseal(this.config.encryptionSecret, 'totp', state.seed),
          code,
        );
      state.sessions = [];
      state.challenges = [challenge];
      challenge.pending = seal(
        this.config.encryptionSecret,
        'totp',
        base32(randomBytes(20)),
      );
      challenge.purpose = 'replace';
      return this.enrollment(challenge.pending);
    });
  }
  async authorize(token: string, csrf?: string) {
    return this.transaction((state) => {
      const session = state.sessions.find((s) => s.hash === digest(token));
      if (!session) throw adminError(403, 'admin_session_required');
      if (csrf !== undefined && !equalSecret(session.csrf, csrf))
        throw adminError(403, 'admin_csrf');
      session.lastSeen = this.now();
      return `github:${this.config.githubId}`;
    });
  }
  async logout(token: string) {
    await this.transaction((state) => {
      state.sessions = state.sessions.filter((s) => s.hash !== digest(token));
    });
  }
}
