import { describe, expect, it } from 'vitest';
import { describeLoginEvent, parseUserAgent, type LoginEventRow } from '../loginActivity';

// Unit tests for the Settings → Account login-activity display helpers
// (added 2026-06-12, commit 8f32e82). The detection-order rules are the
// whole contract: Edge/Opera embed "Chrome", Chrome embeds "Safari", and
// iPad UAs carry "like Mac OS X" — get the order wrong and every Edge user
// reads "Chrome on Windows".

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.2535.51',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0',
  firefoxWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.165 Mobile Safari/537.36',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1',
};

describe('parseUserAgent', () => {
  it('returns "Chrome on macOS" for a Chrome-on-Mac UA (Chrome wins over the embedded Safari token)', () => {
    expect(parseUserAgent(UA.chromeMac)).toBe('Chrome on macOS');
  });

  it('returns "Edge on Windows" for an Edge UA even though it embeds Chrome AND Safari tokens', () => {
    expect(parseUserAgent(UA.edgeWindows)).toBe('Edge on Windows');
  });

  it('returns "Opera on Windows" for an Opera UA (OPR/ beats the embedded Chrome token)', () => {
    expect(parseUserAgent(UA.operaWindows)).toBe('Opera on Windows');
  });

  it('returns "Firefox on Windows" for a Firefox UA', () => {
    expect(parseUserAgent(UA.firefoxWindows)).toBe('Firefox on Windows');
  });

  it('classifies an iPad UA as iOS, not macOS, despite the "like Mac OS X" token', () => {
    expect(parseUserAgent(UA.safariIpad)).toBe('Safari on iOS');
  });

  it('classifies Chrome-on-iPhone as iOS (the "like Mac OS X" trap again)', () => {
    // CriOS has no Chrome/ token, so the browser falls through to Safari —
    // the OS is the load-bearing assertion here.
    expect(parseUserAgent(UA.chromeIphone)).toContain('on iOS');
  });

  it('returns "Safari on macOS" for desktop Safari', () => {
    expect(parseUserAgent(UA.safariMac)).toBe('Safari on macOS');
  });

  it('classifies Android-Chrome as Android, not Linux, despite the Linux token', () => {
    expect(parseUserAgent(UA.chromeAndroid)).toBe('Chrome on Android');
  });

  it('returns null for null, empty, and unrecognizable input', () => {
    expect(parseUserAgent(null)).toBeNull();
    expect(parseUserAgent('')).toBeNull();
    expect(parseUserAgent('curl/8.4.0')).toBeNull();
  });

  it('falls back to the lone recognized half when only browser OR os is detectable', () => {
    expect(parseUserAgent('Firefox/126.0')).toBe('Firefox');
    expect(parseUserAgent('something something Windows NT 10.0')).toBe('Windows');
  });
});

describe('describeLoginEvent', () => {
  const row = (ua: string | null, ip: string | null): LoginEventRow => ({
    id: 'evt-1',
    created_at: '2026-06-12T10:00:00Z',
    ip,
    user_agent: ua,
  });

  it('appends the IP when present', () => {
    expect(describeLoginEvent(row(UA.chromeMac, '203.0.113.7'), 'Unknown device')).toBe(
      'Chrome on macOS · 203.0.113.7',
    );
  });

  it('omits the IP separator when ip is null', () => {
    expect(describeLoginEvent(row(UA.chromeMac, null), 'Unknown device')).toBe('Chrome on macOS');
  });

  it('falls back to the provided unknown-device label when the UA is unparseable', () => {
    expect(describeLoginEvent(row(null, null), 'Unknown device')).toBe('Unknown device');
    expect(describeLoginEvent(row('curl/8.4.0', '203.0.113.7'), 'Dispositivo desconocido')).toBe(
      'Dispositivo desconocido · 203.0.113.7',
    );
  });
});
