// Helpers for the Settings → Account login-activity card.
//
// parseUserAgent is a deliberately small heuristic — enough to render
// "Chrome on macOS" from a raw UA string. It is display-only; nothing
// security-relevant branches on it.

export interface LoginEventRow {
  id: string;
  created_at: string;
  ip: string | null;
  user_agent: string | null;
}

export function parseUserAgent(ua: string | null): string | null {
  if (!ua) return null;

  let browser: string | null = null;
  // Order matters: Edge and Opera embed "Chrome"; Chrome embeds "Safari".
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  let os: string | null = null;
  // iOS before macOS: iPad UAs can carry "like Mac OS X".
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';

  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os;
}

export function describeLoginEvent(row: LoginEventRow, unknownDeviceLabel: string): string {
  const device = parseUserAgent(row.user_agent) ?? unknownDeviceLabel;
  return row.ip ? `${device} · ${row.ip}` : device;
}
