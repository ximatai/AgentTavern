import type { ThemePreset } from "../types";

const sunset: ThemePreset = {
  id: "sunset",
  labelKey: "theme.sunset",
  algorithm: "dark",
  antdTokens: {
    colorPrimary: "#FB923C",
    colorBgContainer: "#1A0F0A",
    colorBgElevated: "#2A1A12",
    colorBgLayout: "#1A0F0A",
    colorBorder: "#3D2A1E",
    colorBorderSecondary: "#4A362A",
    colorText: "#FFF7ED",
    colorTextSecondary: "#D4A574",
    colorTextTertiary: "#8B6A4E",
    colorSuccess: "#4ADE80",
    colorWarning: "#FCD34D",
    colorError: "#F87171",
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
      colorBgContainer: "#221410",
      activeBorderColor: "#FB923C",
      hoverBorderColor: "#FB923C",
    },
    Modal: {
      colorBgElevated: "#2A1A12",
      headerBg: "#2A1A12",
      contentBg: "#2A1A12",
    },
    Menu: {
      colorBgContainer: "#2A1A12",
      itemBg: "transparent",
      itemHoverBg: "#3D2A1E",
      itemSelectedBg: "rgba(194, 65, 12, 0.25)",
      itemSelectedColor: "#FB923C",
    },
    List: {
      colorBorder: "#3D2A1E",
      colorSplit: "#3D2A1E",
    },
  },
  cssVars: {
    "--bg-base": "#1A0F0A",
    "--bg-inset": "#1E1210",
    "--bg-surface": "#2A1A12",
    "--bg-input": "#221410",
    "--accent": "#FB923C",
    "--accent-dim": "#C2410C",
    "--accent-alpha": "rgba(251, 146, 60, 0.15)",
    "--font-primary": "#FFF7ED",
    "--font-secondary": "#D4A574",
    "--font-tertiary": "#8B6A4E",
    "--font-muted": "#5C3D28",
    "--border-default": "#3D2A1E",
    "--border-secondary": "#4A362A",
  },
  preview: {
    primary: "#FB923C",
    bg: "#1A0F0A",
  },
};

export default sunset;
