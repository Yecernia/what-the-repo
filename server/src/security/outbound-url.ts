import dns from "node:dns/promises";
import net from "node:net";

export interface LookupAddress {
  address: string;
  family: number;
}

export type PublicUrlLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ReadonlyArray<LookupAddress>>;

export interface PublicFetchOptions {
  fetchImpl?: typeof globalThis.fetch;
  lookup?: PublicUrlLookup;
}

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".nip.io",
  ".xip.io",
  ".sslip.io",
  ".lvh.me",
  ".localtest.me",
  ".vcap.me",
] as const;

function ipv4Parts(value: string): [number, number, number, number] | null {
  if (net.isIP(value) !== 4) return null;
  const parts = value.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts as [number, number, number, number]
    : null;
}

function ipv4IsPrivateOrReserved(value: string): boolean {
  const parts = ipv4Parts(value);
  if (!parts) return true;
  const [first, second, third] = parts;
  return first === 0
    || first === 10
    || first === 100 && second >= 64 && second <= 127
    || first === 127
    || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31
    || first === 192 && second === 0 && third === 0
    || first === 192 && second === 0 && third === 2
    || first === 192 && second === 168
    || first === 198 && second === 18
    || first === 198 && second === 19
    || first === 198 && second === 51 && third === 100
    || first === 203 && second === 0 && third === 113
    || first >= 224;
}

function parseIpv6Words(value: string): number[] | null {
  let address = value.toLowerCase();
  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    if (separator < 0) return null;
    const embedded = ipv4Parts(address.slice(separator + 1));
    if (!embedded) return null;
    const [a, b, c, d] = embedded;
    address = `${address.slice(0, separator)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  if ((address.match(/::/g) ?? []).length > 1) return null;
  const hasCompression = address.includes("::");
  const [leftRaw, rightRaw] = hasCompression ? address.split("::") : [address, ""];
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const valid = (part: string): boolean => /^[0-9a-f]{1,4}$/.test(part);
  if (![...left, ...right].every(valid)) return null;
  if (!hasCompression && left.length !== 8) return null;
  if (hasCompression && left.length + right.length >= 8) return null;
  const words = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...(hasCompression ? Array.from({ length: 8 - left.length - right.length }, () => 0) : []),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  return words.length === 8 ? words : null;
}

function ipv6IsPrivateOrReserved(value: string): boolean {
  const words = parseIpv6Words(value);
  if (!words) return true;
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = words;
  const mapped = first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && sixth === 0xffff;
  if (mapped) {
    const mappedAddress = `${seventh >> 8}.${seventh & 0xff}.${eighth >> 8}.${eighth & 0xff}`;
    return ipv4IsPrivateOrReserved(mappedAddress);
  }
  return (first & 0xfe00) === 0xfc00 // Unique-local (fc00::/7)
    || (first & 0xffc0) === 0xfe80 // Link-local (fe80::/10)
    || (first & 0xff00) === 0xff00 // Multicast
    || first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && sixth === 0 && seventh === 0 && (eighth === 0 || eighth === 1)
    || first === 0x2001 && second === 0x0db8 // Documentation range
    || first === 0x2001 && second === 0x0000 // Teredo
    || first === 0x2001 && (second & 0xfff0) === 0x0020 // ORCHID
    || first === 0x2002 // 6to4 can tunnel private IPv4 ranges
    || first === 0x0100 && second === 0; // Discard-only 0100::/64
}

function hostIsBlocked(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host === "local") return true;
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
}

/** Synchronous syntax/hostname gate used before persisting or exposing a URL. */
export function safePublicHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || hostIsBlocked(url.hostname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const defaultLookup: PublicUrlLookup = (hostname, options) => dns.lookup(hostname, options);

/** Resolve every address for a URL immediately before an outbound request. */
export async function assertPublicHttpsUrl(
  value: unknown,
  lookup: PublicUrlLookup = defaultLookup,
): Promise<string> {
  const safe = safePublicHttpsUrl(value);
  if (!safe) throw new Error("outbound_url_blocked");
  const url = new URL(safe);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: ReadonlyArray<LookupAddress>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("outbound_dns_unavailable");
  }
  if (!addresses.length || addresses.some((row) => {
    const address = row.address.replace(/^\[|\]$/g, "");
    return net.isIP(address) === 4
      ? ipv4IsPrivateOrReserved(address)
      : ipv6IsPrivateOrReserved(address);
  })) {
    throw new Error("outbound_address_blocked");
  }
  return safe;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Fetch only a previously validated public HTTPS URL and never follow redirects. */
export function createPublicFetch(options: PublicFetchOptions = {}): typeof globalThis.fetch {
  const lookup = options.lookup ?? defaultLookup;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);
    await assertPublicHttpsUrl(rawUrl, lookup);
    const response = await (options.fetchImpl ?? globalThis.fetch)(input, { ...init, redirect: "manual" });
    if (REDIRECT_STATUS.has(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("outbound_redirect_blocked");
    }
    return response;
  };
}
