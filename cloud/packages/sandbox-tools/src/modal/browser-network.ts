// Modal enforces destination IPs after DNS, covering redirects, subresources and rebinding without a browser-side race.
const PRIVATE_IPV4 = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 3],
] as const;
const IPV4_BITS = 32;
const IPV4_OCTET_BITS = 8;
const IPV4_OCTET_MAX = 255;
function publicRanges(start = 0, bits = 0): string[] {
  const size = 2 ** (IPV4_BITS - bits);
  if (PRIVATE_IPV4.some(([base, prefix]) => prefix <= bits && start >= base && start < base + 2 ** (IPV4_BITS - prefix))) return [];
  if (PRIVATE_IPV4.some(([base]) => base >= start && base < start + size)) {
    return [...publicRanges(start, bits + 1), ...publicRanges(start + size / 2, bits + 1)];
  }
  const address = [3, 2, 1, 0].map(octet => Math.floor(start / 2 ** (octet * IPV4_OCTET_BITS)) & IPV4_OCTET_MAX).join('.');
  return [`${address}/${bits}`];
}

/** IPv4 only: omitting IPv6 from the allowlist also denies IPv6 private and transition routes. */
export function browserSandboxOptions() {
  return {outboundCidrAllowlist: publicRanges()};
}
