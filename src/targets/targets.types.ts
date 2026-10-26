import { isIP } from 'node:net';

export interface TargetDefinition {
  name: string;
  url: string;
  kind: 'demo' | 'remote';
  allowPrivate: boolean;
  oracle: boolean;
}

export interface PublicTarget {
  name: string;
  kind: 'demo' | 'remote';
  oracle: boolean;
}

export const MAX_TARGETS = 20;

export function normalizeTargetUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Literal private/loopback/link-local host detection (DNS checks happen at
 * delivery time). Handles both bracketed (`[::1]`, from `URL.hostname`) and
 * bare (`::1`, from `dns.lookup`) IPv6 spellings, plus IPv4-mapped and
 * IPv4-compatible IPv6 addresses so an `::ffff:127.0.0.1` cannot smuggle a
 * private IPv4 past the check.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().trim();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const version = isIP(bare);
  if (version === 4) {
    return isPrivateIpv4(bare);
  }
  if (version === 6) {
    return isPrivateIpv6(bare);
  }
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') {
    return true;
  }
  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`).
  const mapped = /^(?:::ffff:|::)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (mapped) {
    return isPrivateIpv4(`${mapped[1]}.${mapped[2]}.${mapped[3]}.${mapped[4]}`);
  }
  // Unique local fc00::/7 and link-local fe80::/10.
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

