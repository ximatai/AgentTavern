import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { withTranslation } from "react-i18next";
import type { WithTranslation } from "react-i18next";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundaryImpl extends Component<Props & WithTranslation, State> {
  constructor(props: Props & WithTranslation) {
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

    const { t } = this.props;

    return (
      <div className="eb-fallback">
        <div className="eb-card">
          <div className="eb-icon">!</div>
          <h2 className="eb-title">{t("errorBoundary.title")}</h2>
          <p className="eb-message">
            {this.state.error?.message || t("errorBoundary.defaultError")}
          </p>
          <button className="eb-retry" onClick={this.handleReset}>
            {t("errorBoundary.retry")}
          </button>
        </div>
      </div>
    );
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryImpl);
