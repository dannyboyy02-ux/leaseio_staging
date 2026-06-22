// @vitest-environment jsdom
import '../../workspace/__tests__/_jsdomPolyfills';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from '@testing-library/react';

// Regression coverage for the C1 in-place re-upload rewrite of
// src/components/leases/FailedLeaseBanner.tsx. The banner has three mutually
// exclusive states; each one's contract is pinned here:
//
//   1. readOnly (Vault) — renders the read-only note, NO retry/upload control.
//      Re-invoking process_lease is AI spend; a regression that put a button
//      back on a Vault lease would silently let a read-only workspace pay to
//      reprocess.
//   2. canRetry (storagePath present) — "Retry Processing" re-runs the original
//      file via a PLAIN-OBJECT body { leaseId }. If this regressed to FormData
//      (or dropped the JSON shape), retry_lease's JSON branch would 400.
//   3. !canRetry (storagePath null) — "Upload New Document" + a hidden file
//      input. A non-PDF must be rejected client-side (toast, no invoke). A PDF
//      must POST a FormData (file + leaseId), then on success fire
//      onRetrySuccess + the success toast.
//
// NOTE on isolation: src/integrations/supabase/client.ts calls createClient()
// at module load against import.meta.env. We mock that whole module below, so
// the real client never initializes — the SUT imports our stub instead.

// --- Mocks ----------------------------------------------------------------

const invokeMock = vi.fn();
const getSessionMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    auth: { getSession: (...args: unknown[]) => getSessionMock(...args) },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

// Echo the i18n key so assertions can match keys, not translated copy.
vi.mock('@/hooks/useAppTranslation', () => ({
  useAppTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object') {
        const params = Object.entries(opts)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(',');
        return params ? `${key}(${params})` : key;
      }
      return key;
    },
  }),
}));

import { FailedLeaseBanner } from '../FailedLeaseBanner';

// --- Helpers --------------------------------------------------------------

const LEASE_ID = 'lease-abc-123';

function renderBanner(
  overrides: Partial<React.ComponentProps<typeof FailedLeaseBanner>> = {},
) {
  const props: React.ComponentProps<typeof FailedLeaseBanner> = {
    leaseId: LEASE_ID,
    errorMessage: 'Extraction timed out',
    storagePath: null,
    onRetrySuccess: vi.fn(),
    ...overrides,
  };
  render(<FailedLeaseBanner {...props} />);
  return props;
}

/** The hidden <input type="file"> — there's exactly one in the !canRetry state. */
function fileInput(): HTMLInputElement {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  if (!input) throw new Error('file input not found');
  return input;
}

/**
 * Fire a change event with a real File. jsdom's File constructor + the
 * input.files setter both work; we set files via defineProperty since the
 * property is read-only on the element.
 */
async function selectFile(file: File) {
  const input = fileInput();
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });
  await act(async () => {
    fireEvent.change(input);
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  getSessionMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  // Default: an authenticated session and a clean invoke result.
  getSessionMock.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
  invokeMock.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
});

// --- Tests ----------------------------------------------------------------

describe('FailedLeaseBanner — readOnly (Vault) state', () => {
  it('renders the read-only note and NO retry/upload control', () => {
    renderBanner({ readOnly: true, storagePath: 's3/path.pdf' });

    // The read-only note key renders.
    expect(screen.getByText('readonly.lease_note')).toBeTruthy();

    // No retry button (even though storagePath is present, readOnly wins).
    expect(screen.queryByRole('button', { name: /Retry Processing/ })).toBeNull();
    // No upload button.
    expect(
      screen.queryByRole('button', { name: /failed_lease\.reupload_button/ }),
    ).toBeNull();
    // No file input either.
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('FailedLeaseBanner — canRetry (storagePath present)', () => {
  it('renders "Retry Processing" and re-invokes with a PLAIN object body { leaseId } (not FormData)', async () => {
    const props = renderBanner({ storagePath: 'leases/lease-abc-123/original.pdf' });

    const retryBtn = screen.getByRole('button', { name: /Retry Processing/ });
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    const [fnName, opts] = invokeMock.mock.calls[0] as [
      string,
      { body: unknown },
    ];
    expect(fnName).toBe('retry_lease');
    // Body is a plain JSON object, NOT FormData.
    expect(opts.body).not.toBeInstanceOf(FormData);
    expect(opts.body).toEqual({ leaseId: LEASE_ID });

    // Success path fires the callback (storagePath retry uses hardcoded copy,
    // so we assert success toast was called at least — copy is not keyed here).
    await waitFor(() => expect(props.onRetrySuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccessMock).toHaveBeenCalled();
  });
});

describe('FailedLeaseBanner — !canRetry (storagePath null) re-upload', () => {
  it('renders the "Upload New Document" button and a hidden file input', () => {
    renderBanner({ storagePath: null });

    expect(
      screen.getByRole('button', { name: /failed_lease\.reupload_button/ }),
    ).toBeTruthy();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.className).toContain('hidden');
  });

  it('rejects a non-PDF file: toasts reupload_not_pdf and does NOT invoke', async () => {
    renderBanner({ storagePath: null });

    const txt = new File(['hello'], 'notalease.txt', { type: 'text/plain' });
    await selectFile(txt);

    expect(toastErrorMock).toHaveBeenCalledWith('failed_lease.reupload_not_pdf');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('rejects a PDF over the 50 MB cap: toasts reupload_too_large and does NOT invoke', async () => {
    renderBanner({ storagePath: null });

    const bigPdf = new File(['%PDF'], 'huge.pdf', { type: 'application/pdf' });
    // File.size is read-only; override it to exceed the client-side cap.
    Object.defineProperty(bigPdf, 'size', {
      value: 51 * 1024 * 1024,
      configurable: true,
    });
    await selectFile(bigPdf);

    expect(toastErrorMock).toHaveBeenCalledWith('failed_lease.reupload_too_large');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('accepts a PDF: invokes retry_lease with a FormData (file + leaseId), fires onRetrySuccess + success toast', async () => {
    const props = renderBanner({ storagePath: null });

    const pdf = new File(['%PDF-1.4 ...'], 'lease.pdf', {
      type: 'application/pdf',
    });
    await selectFile(pdf);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    const [fnName, opts] = invokeMock.mock.calls[0] as [
      string,
      { body: unknown },
    ];
    expect(fnName).toBe('retry_lease');

    // The body must be a FormData carrying the file + leaseId.
    expect(opts.body).toBeInstanceOf(FormData);
    const fd = opts.body as FormData;
    expect(fd.get('leaseId')).toBe(LEASE_ID);
    const sentFile = fd.get('file');
    expect(sentFile).toBeInstanceOf(File);
    expect((sentFile as File).name).toBe('lease.pdf');

    // Success path.
    await waitFor(() => expect(props.onRetrySuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccessMock).toHaveBeenCalledWith('failed_lease.reupload_started');
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('accepts a .pdf by extension even when the browser reports an empty MIME type', async () => {
    // Some browsers hand back an empty file.type; the SUT falls back to the
    // .pdf extension check, so this must still be treated as a PDF.
    renderBanner({ storagePath: null });

    const pdf = new File(['%PDF'], 'Quarterly Lease.PDF', { type: '' });
    await selectFile(pdf);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).not.toHaveBeenCalledWith('failed_lease.reupload_not_pdf');
  });
});
