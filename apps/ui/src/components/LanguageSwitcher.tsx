import { Button, Dropdown } from "antd";
import { GlobalOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import type { MenuProps } from "antd";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();

  const LANGUAGES = [
    { key: "zh", label: t("language.zh") },
    { key: "en", label: t("language.en") },
  ] as const;

  const items: MenuProps["items"] = LANGUAGES.map((lang) => ({
    key: lang.key,
    label: lang.label,
  }));

  return (
    <Dropdown
      menu={{
        items,
        onClick: ({ key }) => i18n.changeLanguage(key),
        selectedKeys: [i18n.language],
      }}
      trigger={["click"]}
    >
      <Button type="text" icon={<GlobalOutlined />} />
    </Dropdown>
  );
}
