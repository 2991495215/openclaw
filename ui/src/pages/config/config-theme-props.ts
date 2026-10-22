import type { ApplicationTheme } from "../../app/context-types.ts";
import type { ContrastPreference } from "../../app/contrast.ts";
import type { ServerUiPrefState, SyncedPrefValue } from "../../app/server-prefs-state.ts";
import { UI_APPEARANCE_DEFAULTS, type UiSettings } from "../../app/settings.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";

type ThemePreferenceKey = "theme" | "themeMode" | "contrast";

type Options = {
  settings: Pick<UiSettings, ThemePreferenceKey>;
  theme: Pick<ApplicationTheme, "appliedPalette" | "setMode">;
  readPreference: <K extends ThemePreferenceKey>(key: K) => ServerUiPrefState<SyncedPrefValue<K>>;
  resetPreference: (key: ThemePreferenceKey) => void;
  applySettings: (patch: Partial<UiSettings>, selectedTheme?: ThemeName) => void;
};

export function configThemeProps({
  settings,
  theme,
  readPreference,
  resetPreference,
  applySettings,
}: Options) {
  const themePref = readPreference("theme");
  const themeModePref = readPreference("themeMode");
  const contrastPref = readPreference("contrast");
  return {
    theme: settings.theme,
    themeOverridden: themePref.overridden,
    themeProvenance: themePref.provenance,
    themeResetValue: themePref.resetValue ?? UI_APPEARANCE_DEFAULTS.theme,
    themeMode: settings.themeMode,
    themeModeOverridden: themeModePref.overridden,
    themeModeProvenance: themeModePref.provenance,
    themeModeResetValue: themeModePref.resetValue ?? UI_APPEARANCE_DEFAULTS.themeMode,
    contrast: settings.contrast ?? UI_APPEARANCE_DEFAULTS.contrast,
    appliedContrast: theme.appliedPalette?.contrast ?? "standard",
    contrastSupported: theme.appliedPalette?.contrastSupported ?? false,
    contrastProvenance: contrastPref.provenance,
    contrastOverridden: contrastPref.overridden,
    contrastResetValue: contrastPref.resetValue ?? UI_APPEARANCE_DEFAULTS.contrast,
    setContrast: (contrast: ContrastPreference) => {
      const preference = readPreference("contrast");
      if (
        preference.overridden &&
        contrast === (preference.resetValue ?? UI_APPEARANCE_DEFAULTS.contrast)
      ) {
        resetPreference("contrast");
      } else {
        applySettings({ contrast });
      }
    },
    setTheme: (selectedTheme: ThemeName) => {
      const preference = readPreference("theme");
      if (preference.overridden && selectedTheme === preference.resetValue) {
        resetPreference("theme");
      } else {
        applySettings({}, selectedTheme);
      }
    },
    setThemeMode: (mode: ThemeMode) => {
      const preference = readPreference("themeMode");
      if (preference.overridden && mode === preference.resetValue) {
        resetPreference("themeMode");
      } else {
        theme.setMode(mode);
      }
    },
  };
}
