import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import zh from "./locales/zh.json";

const STORED_LANG_KEY = "agent-tavern-lang";

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: localStorage.getItem(STORED_LANG_KEY) ?? "zh",
  fallbackLng: "zh",
  interpolation: {
    escapeValue: false,
  },
});

i18n.on("languageChanged", (lng) => {
  localStorage.setItem(STORED_LANG_KEY, lng);
});

export default i18n;
