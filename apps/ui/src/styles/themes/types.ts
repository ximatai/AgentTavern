import type { ThemeConfig } from "antd";

/**
 * CSS custom properties bridging antd tokens with our custom CSS files.
 * These are injected into :root via applyThemeCssVars() at runtime.
 */
export interface ThemeCssVars {
  // Layout backgrounds
  "--bg-base": string;
  "--bg-inset": string;
  "--bg-surface": string;
  "--bg-input": string;

  // Accent colors
  "--accent": string;
  "--accent-dim": string;
  "--accent-alpha": string;

  // Text hierarchy
  "--font-primary": string;
  "--font-secondary": string;
  "--font-tertiary": string;
  "--font-muted": string;

  // Border colors
  "--border-default": string;
  "--border-secondary": string;
}

export interface ThemePreset {
  id: string;
  labelKey: string;
  algorithm: "dark" | "light";
  antdTokens: ThemeConfig["token"];
  antdComponents?: ThemeConfig["components"];
  cssVars: ThemeCssVars;
  preview: {
    primary: string;
    bg: string;
  };
}

export type ThemeId =
  | "default-dark"
  | "light"
  | "dark-vibrant"
  | "ocean-dark"
  | "forest-dark"
  | "sunset"
  | "monochrome"
  | "system";

export type ResolvedThemeId = Exclude<ThemeId, "system">;
