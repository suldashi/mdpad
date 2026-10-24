// Which Host headers the server answers. Without this check, a website could
// point its own domain name at 127.0.0.1 (DNS rebinding) and its pages would
// then count as same-origin with Mdpad and could read and change every note.
// Rebinding needs a domain name, so IP addresses and localhost are always
// fine; any other name has to be listed.

import net from 'node:net';

// The host name in a Host header, lower-cased and without the port or the
// brackets around an IPv6 address. Null if the header is not a valid host.
export function hostName(header: string | undefined): string | null {
  if (!header) return null;
  try {
    const url = new URL('http://' + header);
    if (url.host !== header.toLowerCase() && url.host !== header.toLowerCase().replace(/:80$/, '')) return null;
    return url.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

// `allowed` lists extra host names; "*" allows any.
export function hostChecker(allowed: string[] = []): (header: string | undefined) => boolean {
  const names = new Set(allowed.map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (names.has('*')) return () => true;
  return (header) => {
    const name = hostName(header);
    if (!name) return false;
    return net.isIP(name) !== 0 || name === 'localhost' || name.endsWith('.localhost') || names.has(name);
  };
}
