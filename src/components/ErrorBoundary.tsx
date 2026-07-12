// Top-level React error boundary.
//
// Without this, any thrown error during render in any route crashes
// the entire SPA to a blank white page — the user has no path back
// except hard-refresh, and there's no visible signal of what went
// wrong. This boundary catches all uncaught render errors, shows a
// recoverable fallback, and logs the error to the console + window.
// Survives across routes because it wraps <App /> at the very root
// of the React tree (src/main.tsx).
//
// Functional components cannot catch errors via componentDidCatch;
// React only supports class-component error boundaries. This is the
// one place a class component is required.

import { Component, type ReactNode } from 'react';
// Class components can't use the useAppTranslation hook; the global t is
// safe here because i18n is initialized at boot (src/i18n.ts via main.tsx)
// and this fallback only renders after the app tree has already mounted.
import { t } from 'i18next';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: { componentStack?: string } | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] uncaught render error', error, errorInfo);
    this.setState({ errorInfo });
    // Future: forward to Sentry / Datadog / etc. via window.__leaseio_error_handler
    if (typeof window !== 'undefined' && (window as any).__leaseio_error_handler) {
      try {
        (window as any).__leaseio_error_handler(error, errorInfo);
      } catch {
        /* swallow handler errors */
      }
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const message = this.state.error?.message ?? String(this.state.error ?? t('errors.unknown'));
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            background: '#fafafa',
          }}
        >
          <div
            style={{
              maxWidth: 560,
              width: '100%',
              background: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: '2rem',
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
            }}
          >
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: 0, marginBottom: '0.5rem', color: '#111827' }}>
              {t('errors.boundary_title')}
            </h1>
            <p style={{ fontSize: '0.9rem', color: '#4b5563', lineHeight: 1.6, marginBottom: '1rem' }}>
              {t('errors.boundary_desc')}
            </p>
            <details
              style={{
                fontSize: '0.8rem',
                color: '#6b7280',
                background: '#f9fafb',
                border: '1px solid #e5e7eb',
                borderRadius: 4,
                padding: '0.5rem 0.75rem',
                marginBottom: '1.25rem',
              }}
            >
              <summary style={{ cursor: 'pointer', fontWeight: 500, color: '#374151' }}>
                {t('errors.details')}
              </summary>
              <pre
                style={{
                  marginTop: '0.5rem',
                  marginBottom: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: '0.75rem',
                  color: '#dc2626',
                }}
              >
                {message}
                {this.state.errorInfo?.componentStack
                  ? `\n\n${this.state.errorInfo.componentStack.trim()}`
                  : ''}
              </pre>
            </details>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={this.handleReset}
                style={{
                  padding: '0.5rem 1rem',
                  background: '#1d4ed8',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {t('errors.try_again')}
              </button>
              <button
                onClick={this.handleReload}
                style={{
                  padding: '0.5rem 1rem',
                  background: '#fff',
                  color: '#374151',
                  border: '1px solid #d1d5db',
                  borderRadius: 4,
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {t('errors.reload_app')}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
