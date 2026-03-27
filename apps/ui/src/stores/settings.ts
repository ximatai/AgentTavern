import { useEffect } from "react";
import { create } from "zustand";
import { theme as antdTheme } from "antd";
import type { ThemeConfig } from "antd";
import { themeRegistry } from "../styles/themes/registry";
import type { ThemeId, ResolvedThemeId } from "../styles/themes/types";

const STORAGE_KEY = "agenttavern-settings";

interface SettingsState {
  themeId: ThemeId;
}

interface SettingsActions {
  setThemeId: (id: ThemeId) => void;
}

export type SettingsStore = SettingsState & SettingsActions;

function resolveSystemTheme(): ResolvedThemeId {
  if (typeof window === "undefined") return "default-dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "default-dark"
    : "light";
}

function loadPersistedState(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SettingsState>;
      return { themeId: parsed.themeId ?? "default-dark" };
    }
  } catch {
    // ignore parse errors
  }
  return { themeId: "default-dark" };
}

function persistState(state: SettingsState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ themeId: state.themeId }));
  } catch {
    // ignore quota errors
  }
}

export const useSettingsStore = create<SettingsStore>()((set, get) => {
  const initial = loadPersistedState();
  return {
    themeId: initial.themeId,
    setThemeId: (id) => {
      set({ themeId: id });
      persistState({ ...get(), themeId: id });
    },
  };
});

export function getEffectiveThemeId(id: ThemeId): ResolvedThemeId {
  return id === "system" ? resolveSystemTheme() : id;
}

export function getAntdThemeConfig(id: ThemeId): ThemeConfig {
  const effectiveId = getEffectiveThemeId(id);
  const preset = themeRegistry[effectiveId];
  return {
    algorithm:
      preset.algorithm === "light"
        ? antdTheme.defaultAlgorithm
        : antdTheme.darkAlgorithm,
    token: preset.antdTokens,
    components: preset.antdComponents,
  };
}

export function applyThemeCssVars(id: ThemeId) {
  const effectiveId = getEffectiveThemeId(id);
  const preset = themeRegistry[effectiveId];
  const root = document.documentElement;
  for (const [key, value] of Object.entries(preset.cssVars)) {
    root.style.setProperty(key, value);
  }
}

/**
 * Listen for OS dark/light preference changes and re-apply CSS vars
 * when the user has selected "system" theme.
 */
export function useSystemThemeListener() {
  const themeId = useSettingsStore((s) => s.themeId);

  useEffect(() => {
    if (themeId !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyThemeCssVars("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themeId]);
}

/** Apply CSS vars synchronously before React renders (call in main.tsx). */
applyThemeCssVars(useSettingsStore.getState().themeId);
