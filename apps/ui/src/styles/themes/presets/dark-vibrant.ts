import type { ThemePreset } from "../types";

const darkVibrant: ThemePreset = {
  id: "dark-vibrant",
  labelKey: "theme.darkVibrant",
  algorithm: "dark",
  antdTokens: {
    colorPrimary: "#A78BFA",
    colorBgContainer: "#0F0B1E",
    colorBgElevated: "#1C1533",
    colorBgLayout: "#0F0B1E",
    colorBorder: "#2A2150",
    colorBorderSecondary: "#3D3563",
    colorText: "#F5F3FF",
    colorTextSecondary: "#A5A0C8",
    colorTextTertiary: "#6E6A8D",
    colorSuccess: "#6EE7B7",
    colorWarning: "#FCD34D",
    colorError: "#FCA5A5",
    borderRadius: 12,
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  antdComponents: {
    Button: {
      defaultShadow: "none",
      primaryShadow: "none",
    },
    Input: {
      colorBgContainer: "#17122E",
      activeBorderColor: "#A78BFA",
      hoverBorderColor: "#A78BFA",
    },
    Modal: {
      colorBgElevated: "#1C1533",
      headerBg: "#1C1533",
      contentBg: "#1C1533",
    },
    Menu: {
      colorBgContainer: "#1C1533",
      itemBg: "transparent",
      itemHoverBg: "#2A2150",
      itemSelectedBg: "rgba(124, 58, 237, 0.25)",
      itemSelectedColor: "#A78BFA",
    },
    List: {
      colorBorder: "#2A2150",
      colorSplit: "#2A2150",
    },
  },
  cssVars: {
    "--bg-base": "#0F0B1E",
    "--bg-inset": "#151029",
    "--bg-surface": "#1C1533",
    "--bg-input": "#17122E",
    "--accent": "#A78BFA",
    "--accent-dim": "#7C3AED",
    "--accent-alpha": "rgba(167, 139, 250, 0.15)",
    "--font-primary": "#F5F3FF",
    "--font-secondary": "#A5A0C8",
    "--font-tertiary": "#6E6A8D",
    "--font-muted": "#4A4668",
    "--border-default": "#2A2150",
    "--border-secondary": "#3D3563",
  },
  preview: {
    primary: "#A78BFA",
    bg: "#0F0B1E",
  },
};

export default darkVibrant;
