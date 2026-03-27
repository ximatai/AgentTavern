import type { ThemePreset, ResolvedThemeId } from "./types";
import defaultDark from "./presets/default-dark";
import light from "./presets/light";
import darkVibrant from "./presets/dark-vibrant";
import oceanDark from "./presets/ocean-dark";
import forestDark from "./presets/forest-dark";
import sunset from "./presets/sunset";
import monochrome from "./presets/monochrome";

export const themeRegistry: Record<ResolvedThemeId, ThemePreset> = {
  "default-dark": defaultDark,
  light,
  "dark-vibrant": darkVibrant,
  "ocean-dark": oceanDark,
  "forest-dark": forestDark,
  sunset,
  monochrome,
};

export { defaultDark, light, darkVibrant, oceanDark, forestDark, sunset, monochrome };
