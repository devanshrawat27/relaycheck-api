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

/** Literal private/loopback/link-local host detection (DNS checks happen at delivery time). */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return true;
  }
  if (host.endsWith('.local')) {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    if (inner === '::1') {
      return true;
    }
    if (/^f[cd][0-9a-f]{2}:/.test(inner) || /^fe[89ab][0-9a-f]:/.test(inner)) {
      return true;
    }
    return false;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    );
  }
  return false;
}

