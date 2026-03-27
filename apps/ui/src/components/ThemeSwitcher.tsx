import { Popover, Button } from "antd";
import { BgColorsOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../stores/settings";
import { themeRegistry } from "../styles/themes/registry";
import type { ThemeId, ResolvedThemeId } from "../styles/themes/types";
import "../styles/theme-switcher.css";

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const themeId = useSettingsStore((s) => s.themeId);
  const setThemeId = useSettingsStore((s) => s.setThemeId);

  const entries = Object.entries(themeRegistry) as [
    ResolvedThemeId,
    (typeof themeRegistry)[ResolvedThemeId],
  ][];

  const popoverContent = (
    <div className="theme-picker-grid">
      {entries.map(([id, preset]) => (
        <button
          key={id}
          type="button"
          className={`theme-picker-swatch${themeId === id ? " active" : ""}`}
          onClick={() => setThemeId(id)}
        >
          <div
            className="theme-picker-preview"
            style={{
              background: `linear-gradient(135deg, ${preset.preview.bg} 50%, ${preset.preview.primary} 50%)`,
            }}
          />
          <span className="theme-picker-label">{t(preset.labelKey)}</span>
          {themeId === id && <span className="theme-picker-check">&#10003;</span>}
        </button>
      ))}
      <button
        type="button"
        className={`theme-picker-swatch${themeId === "system" ? " active" : ""}`}
        onClick={() => setThemeId("system")}
      >
        <div
          className="theme-picker-preview"
          style={{ background: "linear-gradient(135deg, #F1F5F9 50%, #0A0F1C 50%)" }}
        />
        <span className="theme-picker-label">{t("theme.system")}</span>
        {themeId === "system" && <span className="theme-picker-check">&#10003;</span>}
      </button>
    </div>
  );

  return (
    <Popover
      content={popoverContent}
      trigger="click"
      placement="bottomRight"
      arrow={false}
    >
      <Button type="text" icon={<BgColorsOutlined />} />
    </Popover>
  );
}
