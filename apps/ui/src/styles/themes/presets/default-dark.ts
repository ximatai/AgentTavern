import type { ThemePreset } from "../types";

const defaultDark: ThemePreset = {
  id: "default-dark",
  labelKey: "theme.defaultDark",
  algorithm: "dark",
  antdTokens: {
    colorPrimary: "#22D3EE",
    colorBgContainer: "#0A0F1C",
    colorBgElevated: "#1E293B",
    colorBgLayout: "#0A0F1C",
    colorBorder: "#1E293B",
    colorBorderSecondary: "#334155",
    colorText: "#FFFFFF",
    colorTextSecondary: "#94A3B8",
    colorTextTertiary: "#64748B",
    colorSuccess: "#34D399",
    colorWarning: "#FBBF24",
    colorError: "#F87171",
    borderRadius: 8,
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  antdComponents: {
    Button: {
      defaultShadow: "none",
      primaryShadow: "none",
    },
    Input: {
      colorBgContainer: "#1A2332",
      activeBorderColor: "#22D3EE",
      hoverBorderColor: "#22D3EE",
    },
    Modal: {
      colorBgElevated: "#1E293B",
      headerBg: "#1E293B",
      contentBg: "#1E293B",
    },
    Menu: {
      colorBgContainer: "#1E293B",
      itemBg: "transparent",
      itemHoverBg: "#334155",
      itemSelectedBg: "#0E7490",
      itemSelectedColor: "#22D3EE",
    },
    List: {
      colorBorder: "#1E293B",
      colorSplit: "#1E293B",
    },
  },
  cssVars: {
    "--bg-base": "#0A0F1C",
    "--bg-inset": "#111827",
    "--bg-surface": "#1E293B",
    "--bg-input": "#1A2332",
    "--accent": "#22D3EE",
    "--accent-dim": "#0E7490",
    "--accent-alpha": "rgba(34, 211, 238, 0.15)",
    "--font-primary": "#FFFFFF",
    "--font-secondary": "#94A3B8",
    "--font-tertiary": "#64748B",
    "--font-muted": "#475569",
    "--border-default": "#1E293B",
    "--border-secondary": "#334155",
  },
  preview: {
    primary: "#22D3EE",
    bg: "#0A0F1C",
  },
};

export default defaultDark;
