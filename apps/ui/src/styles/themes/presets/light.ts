import type { ThemePreset } from "../types";

const light: ThemePreset = {
  id: "light",
  labelKey: "theme.light",
  algorithm: "light",
  antdTokens: {
    colorPrimary: "#0E7490",
    colorBgContainer: "#FFFFFF",
    colorBgElevated: "#F8FAFC",
    colorBgLayout: "#F1F5F9",
    colorBorder: "#E2E8F0",
    colorBorderSecondary: "#CBD5E1",
    colorText: "#0F172A",
    colorTextSecondary: "#475569",
    colorTextTertiary: "#94A3B8",
    colorSuccess: "#059669",
    colorWarning: "#D97706",
    colorError: "#DC2626",
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
      colorBgContainer: "#FFFFFF",
      activeBorderColor: "#0E7490",
      hoverBorderColor: "#0E7490",
    },
    Modal: {
      colorBgElevated: "#FFFFFF",
      headerBg: "#FFFFFF",
      contentBg: "#FFFFFF",
    },
    Menu: {
      colorBgContainer: "#FFFFFF",
      itemBg: "transparent",
      itemHoverBg: "#F1F5F9",
      itemSelectedBg: "rgba(14, 116, 144, 0.08)",
      itemSelectedColor: "#0E7490",
    },
    List: {
      colorBorder: "#E2E8F0",
      colorSplit: "#E2E8F0",
    },
  },
  cssVars: {
    "--bg-base": "#F1F5F9",
    "--bg-inset": "#FFFFFF",
    "--bg-surface": "#F8FAFC",
    "--bg-input": "#FFFFFF",
    "--accent": "#0E7490",
    "--accent-dim": "#0E7490",
    "--accent-alpha": "rgba(14, 116, 144, 0.1)",
    "--font-primary": "#0F172A",
    "--font-secondary": "#475569",
    "--font-tertiary": "#94A3B8",
    "--font-muted": "#CBD5E1",
    "--border-default": "#E2E8F0",
    "--border-secondary": "#CBD5E1",
  },
  preview: {
    primary: "#0E7490",
    bg: "#F1F5F9",
  },
};

export default light;
