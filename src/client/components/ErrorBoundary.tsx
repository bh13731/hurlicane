import React from 'react';

interface ErrorBoundaryProps {
  /** Label shown in the fallback UI to identify which section crashed */
  section?: string;
  /** Optional custom fallback -- receives the error and a reset function */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.section ? `: ${this.props.section}` : ''}]`,
      error,
      info.componentStack,
    );
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(error, this.handleReset);
      }
      return (
        <div className="error-boundary-fallback">
          <div className="error-boundary-content">
            <h3 className="error-boundary-title">
              Something went wrong{this.props.section ? ` in ${this.props.section}` : ''}
            </h3>
            <pre className="error-boundary-message">{error.message}</pre>
            <button className="btn btn-secondary btn-sm" onClick={this.handleReset}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
