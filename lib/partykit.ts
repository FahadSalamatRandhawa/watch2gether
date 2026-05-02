const DEFAULT_LOCAL_HOST = 'localhost:1999';

export function partyHost(): string {
  return process.env.NEXT_PUBLIC_PARTYKIT_HOST || DEFAULT_LOCAL_HOST;
}

function isInsecure(host: string): boolean {
  return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

export function partyHttpUrl(roomId: string): string {
  const host = partyHost();
  const proto = isInsecure(host) ? 'http:' : 'https:';
  return `${proto}//${host}/parties/main/${encodeURIComponent(roomId)}`;
}

export function partyWsUrl(roomId: string, params: Record<string, string>): string {
  const host = partyHost();
  const proto = isInsecure(host) ? 'ws:' : 'wss:';
  const qs = new URLSearchParams(params).toString();
  return `${proto}//${host}/parties/main/${encodeURIComponent(roomId)}${qs ? `?${qs}` : ''}`;
}
