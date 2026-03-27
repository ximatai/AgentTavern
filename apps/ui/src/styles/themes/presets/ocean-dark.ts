import type { ThemePreset } from "../types";

const oceanDark: ThemePreset = {
  id: "ocean-dark",
  labelKey: "theme.oceanDark",
  algorithm: "dark",
  antdTokens: {
    colorPrimary: "#2DD4BF",
    colorBgContainer: "#0B1120",
    colorBgElevated: "#15203A",
    colorBgLayout: "#0B1120",
    colorBorder: "#1E3048",
    colorBorderSecondary: "#2A4060",
    colorText: "#E0F2FE",
    colorTextSecondary: "#7DD3FC",
    colorTextTertiary: "#4A7A9B",
    colorSuccess: "#34D399",
    colorWarning: "#FBBF24",
    colorError: "#FB7185",
    borderRadius: 10,
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  antdComponents: {
    Button: {
      defaultShadow: "none",
      primaryShadow: "none",
    },
    Input: {
      colorBgContainer: "#111C34",
      activeBorderColor: "#2DD4BF",
      hoverBorderColor: "#2DD4BF",
    },
    Modal: {
      colorBgElevated: "#15203A",
      headerBg: "#15203A",
      contentBg: "#15203A",
    },
    Menu: {
      colorBgContainer: "#15203A",
      itemBg: "transparent",
      itemHoverBg: "#1E3048",
      itemSelectedBg: "rgba(13, 148, 136, 0.25)",
      itemSelectedColor: "#2DD4BF",
    },
    List: {
      colorBorder: "#1E3048",
      colorSplit: "#1E3048",
    },
  },
  cssVars: {
    "--bg-base": "#0B1120",
    "--bg-inset": "#0E1629",
    "--bg-surface": "#15203A",
    "--bg-input": "#111C34",
    "--accent": "#2DD4BF",
    "--accent-dim": "#0D9488",
    "--accent-alpha": "rgba(45, 212, 191, 0.15)",
    "--font-primary": "#E0F2FE",
    "--font-secondary": "#7DD3FC",
    "--font-tertiary": "#4A7A9B",
    "--font-muted": "#2A4A64",
    "--border-default": "#1E3048",
    "--border-secondary": "#2A4060",
  },
  preview: {
    primary: "#2DD4BF",
    bg: "#0B1120",
  },
};

export default oceanDark;
