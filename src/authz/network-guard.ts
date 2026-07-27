import { isIPv4, isIPv6 } from "node:net";
import { lookup } from "node:dns/promises";
import { TargetAuthorizationError } from "../domain/errors.js";

function ipv4ToBigInt(ip: string): bigint {
  return ip.split(".").reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
  let normalized = ip;
  const v4Match = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const hex = ipv4ToBigInt(v4Match[1]!).toString(16).padStart(8, "0");
    normalized = normalized.slice(0, normalized.length - v4Match[1]!.length) + `${hex.slice(0, 4)}:${hex.slice(4)}`;
  }

  let headParts: string[];
  let tailParts: string[];
  if (normalized.includes("::")) {
    const [head, tail] = normalized.split("::");
    headParts = head ? head.split(":").filter(Boolean) : [];
    tailParts = tail ? tail.split(":").filter(Boolean) : [];
  } else {
    headParts = normalized.split(":").filter(Boolean);
    tailParts = [];
  }
  const missing = Math.max(8 - headParts.length - tailParts.length, 0);
  const allParts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  return allParts.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part || "0", 16)), 0n);
}

function ipToBigInt(ip: string): { value: bigint; bits: number } {
  if (isIPv4(ip)) return { value: ipv4ToBigInt(ip), bits: 32 };
  if (isIPv6(ip)) return { value: ipv6ToBigInt(ip), bits: 128 };
  throw new Error(`Not a valid IP address: ${ip}`);
}

function inCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const ipParsed = ipToBigInt(ip);
  const rangeParsed = ipToBigInt(rangeIp!);
  if (ipParsed.bits !== rangeParsed.bits) return false;
  const shift = BigInt(ipParsed.bits - prefix);
  return ipParsed.value >> shift === rangeParsed.value >> shift;
}

// IANA special-purpose address registries (IPv4 + IPv6). Beta default is
// deny-by-default for anything private/reserved — there is no
// "approved private range" override yet (see network-guard tests / README).
const V4_RESERVED_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
];

const V6_RESERVED_CIDRS = ["::1/128", "::/128", "fc00::/7", "fe80::/10", "ff00::/8"];

export function isPrivateOrReservedAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    return V4_RESERVED_CIDRS.some((cidr) => inCidr(ip, cidr));
  }
  if (isIPv6(ip)) {
    const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4Mapped) {
      return isPrivateOrReservedAddress(v4Mapped[1]!);
    }
    return V6_RESERVED_CIDRS.some((cidr) => inCidr(ip, cidr));
  }
  // Anything we can't classify is treated as unsafe (fail closed).
  return true;
}

export async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * Resolves `hostname` and rejects if any resolved address is private,
 * loopback, link-local, or otherwise reserved. Call this immediately before
 * every outbound connection (not just once at authorization time) to guard
 * against DNS rebinding between the check and the connect.
 */
export async function assertPublicAddress(hostname: string): Promise<void> {
  const addresses = await resolveHostAddresses(hostname);
  if (addresses.length === 0) {
    throw new TargetAuthorizationError(`Could not resolve host: ${hostname}`);
  }
  for (const address of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      throw new TargetAuthorizationError(
        `Target host "${hostname}" resolves to a private/reserved address (${address}); private network ranges are not authorized`,
      );
    }
  }
}
