import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  title?: string;
  resetKey?: string | number | null;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.handleReset();
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: '16px',
            padding: '40px',
            background: 'var(--bg-canvas)',
            color: 'var(--text-strong)',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              background: 'rgba(239,68,68,0.15)',
              border: '1px solid rgba(239,68,68,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '24px',
            }}
          >
            ⚠
          </div>
          <div>
            <p style={{ fontWeight: 600, fontSize: '16px', marginBottom: '6px' }}>
              {this.props.title || 'Something went wrong'}
            </p>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '400px' }}>
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
          </div>
          <button
            onClick={this.handleReset}
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              background: 'rgba(6,182,212,0.15)',
              border: '1px solid rgba(6,182,212,0.3)',
              color: 'var(--accent)',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Try Again
          </button>
          {import.meta.env.DEV && (
            <pre
              style={{
                fontSize: '11px',
                color: 'var(--text-faint)',
                background: 'var(--bg-elev-1)',
                padding: '12px',
                borderRadius: '8px',
                maxWidth: '600px',
                overflow: 'auto',
                textAlign: 'left',
                maxHeight: '200px',
              }}
            >
              {this.state.error?.stack}
            </pre>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
