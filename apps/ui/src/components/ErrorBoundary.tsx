import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  children: ReactNode;
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
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <ErrorBoundaryContent
        error={this.state.error}
        onReset={this.handleReset}
      />
    );
  }
}

function ErrorBoundaryContent({
  error,
  onReset,
}: {
  error: Error | null;
  onReset: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="eb-fallback">
      <div className="eb-card">
        <div className="eb-icon">!</div>
        <h2 className="eb-title">{t("errorBoundary.title")}</h2>
        <p className="eb-message">
          {error?.message || t("errorBoundary.defaultError")}
        </p>
        <button className="eb-retry" onClick={onReset}>
          {t("errorBoundary.retry")}
        </button>
      </div>
    </div>
  );
}
