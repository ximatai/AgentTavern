import type { ThemePreset } from "../types";

const monochrome: ThemePreset = {
  id: "monochrome",
  labelKey: "theme.monochrome",
  algorithm: "dark",
  antdTokens: {
    colorPrimary: "#E2E8F0",
    colorBgContainer: "#09090B",
    colorBgElevated: "#18181B",
    colorBgLayout: "#09090B",
    colorBorder: "#27272A",
    colorBorderSecondary: "#3F3F46",
    colorText: "#FAFAFA",
    colorTextSecondary: "#A1A1AA",
    colorTextTertiary: "#71717A",
    colorSuccess: "#34D399",
    colorWarning: "#FBBF24",
    colorError: "#F87171",
    borderRadius: 6,
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  antdComponents: {
    Button: {
      defaultShadow: "none",
      primaryShadow: "none",
    },
    Input: {
      colorBgContainer: "#111114",
      activeBorderColor: "#E2E8F0",
      hoverBorderColor: "#E2E8F0",
    },
    Modal: {
      colorBgElevated: "#18181B",
      headerBg: "#18181B",
      contentBg: "#18181B",
    },
    Menu: {
      colorBgContainer: "#18181B",
      itemBg: "transparent",
      itemHoverBg: "#27272A",
      itemSelectedBg: "#3F3F46",
      itemSelectedColor: "#FAFAFA",
    },
    List: {
      colorBorder: "#27272A",
      colorSplit: "#27272A",
    },
  },
  cssVars: {
    "--bg-base": "#09090B",
    "--bg-inset": "#0F0F12",
    "--bg-surface": "#18181B",
    "--bg-input": "#111114",
    "--accent": "#E2E8F0",
    "--accent-dim": "#52525B",
    "--accent-alpha": "rgba(226, 232, 240, 0.1)",
    "--font-primary": "#FAFAFA",
    "--font-secondary": "#A1A1AA",
    "--font-tertiary": "#71717A",
    "--font-muted": "#3F3F46",
    "--border-default": "#27272A",
    "--border-secondary": "#3F3F46",
  },
  preview: {
    primary: "#E2E8F0",
    bg: "#09090B",
  },
};

export default monochrome;
