import type { ThemePreset } from "../types";

const forestDark: ThemePreset = {
  id: "forest-dark",
  labelKey: "theme.forestDark",
  algorithm: "dark",
  antdTokens: {
    colorPrimary: "#4ADE80",
    colorBgContainer: "#0A120E",
    colorBgElevated: "#162019",
    colorBgLayout: "#0A120E",
    colorBorder: "#1E3027",
    colorBorderSecondary: "#2A4236",
    colorText: "#E8F5E9",
    colorTextSecondary: "#81C784",
    colorTextTertiary: "#4A7A5C",
    colorSuccess: "#4ADE80",
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
      colorBgContainer: "#111C16",
      activeBorderColor: "#4ADE80",
      hoverBorderColor: "#4ADE80",
    },
    Modal: {
      colorBgElevated: "#162019",
      headerBg: "#162019",
      contentBg: "#162019",
    },
    Menu: {
      colorBgContainer: "#162019",
      itemBg: "transparent",
      itemHoverBg: "#1E3027",
      itemSelectedBg: "rgba(22, 163, 74, 0.25)",
      itemSelectedColor: "#4ADE80",
    },
    List: {
      colorBorder: "#1E3027",
      colorSplit: "#1E3027",
    },
  },
  cssVars: {
    "--bg-base": "#0A120E",
    "--bg-inset": "#0D1612",
    "--bg-surface": "#162019",
    "--bg-input": "#111C16",
    "--accent": "#4ADE80",
    "--accent-dim": "#16A34A",
    "--accent-alpha": "rgba(74, 222, 128, 0.15)",
    "--font-primary": "#E8F5E9",
    "--font-secondary": "#81C784",
    "--font-tertiary": "#4A7A5C",
    "--font-muted": "#2E4E3A",
    "--border-default": "#1E3027",
    "--border-secondary": "#2A4236",
  },
  preview: {
    primary: "#4ADE80",
    bg: "#0A120E",
  },
};

export default forestDark;
