// Adapted from p2 (apps/p2/src/web/ThemeButton.tsx): the top bar's theme control, kept per browser (theme.ts).
import { type ComponentType, useSyncExternalStore } from "react";
import { MoonIcon, SunIcon, SystemThemeIcon } from "./icons.tsx";
import { getTheme, setTheme, subscribeTheme, type ThemePreference } from "./theme.ts";

/** Each theme preference's label and icon, and the one the button switches to next. */
const THEME_CHOICES: Readonly<
  Record<ThemePreference, { readonly label: string; readonly icon: ComponentType; readonly next: ThemePreference }>
> = {
  system: { label: "System", icon: SystemThemeIcon, next: "light" },
  light: { label: "Light", icon: SunIcon, next: "dark" },
  dark: { label: "Dark", icon: MoonIcon, next: "system" },
};

/** Cycles System → Light → Dark; the choice is kept per browser. */
export function ThemeButton() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  const { label, icon: Icon, next } = THEME_CHOICES[theme];
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${label}. Switch to ${THEME_CHOICES[next].label}`}
      title={`Theme: ${label}`}
    >
      <Icon />
    </button>
  );
}
