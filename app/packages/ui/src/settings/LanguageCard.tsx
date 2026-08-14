import { useGT, useLocaleSelector } from "gt-react";
import { setStoredLocale } from "../i18n/locale-preference.js";
import { CARD, INPUT, LABEL } from "./styles.js";

/**
 * Device-scoped UI language picker. Selecting a language stores it (see
 * locale-preference.ts) and hands it to gt-react, which reloads the window so
 * every already-rendered string re-resolves in the new locale.
 */
export function LanguageCard() {
  const gt = useGT();
  const { locale, locales, getLocaleProperties, setLocale } = useLocaleSelector();
  // The resolved locale can be a regional variant of a configured one
  // (e.g. en-US); keep the select controlled by listing it explicitly.
  const options = locales.includes(locale) ? locales : [locale, ...locales];

  return (
    <div className={CARD}>
      <h2 className="text-sm font-semibold text-on-surface-secondary mb-1">{gt("Language")}</h2>
      <p className="text-xs text-on-surface-muted max-w-md mb-3">
        {gt(
          "The language of the app on this device. Anything not translated yet falls back to English.",
        )}
      </p>
      <label htmlFor="ui-language" className={LABEL}>
        {gt("Language")}
      </label>
      <select
        id="ui-language"
        value={locale}
        onChange={(e) => {
          setStoredLocale(e.target.value);
          setLocale(e.target.value);
        }}
        className={`${INPUT} max-w-xs`}
      >
        {options.map((code) => (
          <option key={code} value={code}>
            {getLocaleProperties(code).nativeNameWithRegionCode}
          </option>
        ))}
      </select>
    </div>
  );
}
