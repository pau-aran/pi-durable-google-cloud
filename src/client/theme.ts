// Adapted from p2 (apps/p2/src/web/theme.ts): the page's colour theme, light or dark, by a preference this page owns.

/*
 * The preference (System / Light / Dark, chosen with the top bar's theme button) is this origin's localStorage
 * `pi-theme` (absent: system), "system" resolved with `matchMedia`, other tabs followed through `storage` events. The
 * resolved theme is always written to `<html data-theme>`, which style.css keys off, and `<html data-color-scheme>`,
 * which Elanor's design tokens key off (elanor.css). The page's inline script (index.html) sets both before styles load
 * (no flash), by the same rule.
 *
 * A change of the shown scheme after load cross-fades: the DOM change runs in a view transition of type `pi-theme`
 * (the browser's default cross-fade of the whole page). No fade for what the page shows while it starts (anything
 * before the first frame was shown), an unchanged scheme, a hidden document, reduced motion, or a browser without view
 * transitions. A change during a fade starts a new one (the browser finishes the running one). A page hidden right
 * after a fade started shows the change without it: the browser skips the transition and still runs the DOM change.
 */

export type ThemePreference = "system" | "light" | "dark";

/** A resolved theme. */
export type ThemeScheme = "light" | "dark";

const KEY = "pi-theme";
// Must match --bg in style.css: the mobile browser bar takes this colour.
const BACKGROUND = { light: "#fbfaf8", dark: "#151413" } as const;
const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
let system: MediaQueryList | undefined;
/** Whether the page has shown a frame since `startTheme`: what it shows while starting never fades. */
let shown = false;
/** The scheme last asked to show; a fade's DOM change, which runs later, shows the latest one. */
let showing: ThemeScheme | undefined;

/** How a change shows: in one frame, or cross-faded when the rules above allow it. */
type Show = "at once" | "fade";

/** Called once from main.tsx, before the first render. */
export function startTheme(): void {
  if (system) return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  system = media;
  preference = read();
  apply("at once");
  window.requestAnimationFrame(() => {
    shown = true;
  });
  media.addEventListener("change", () => apply("fade"));
  // Another tab of this origin changed the theme.
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY && event.key !== null) return;
    preference = read();
    changed("fade");
  });
}

function read(): ThemePreference {
  try {
    return themePreference(localStorage.getItem(KEY)) ?? "system";
  } catch {
    return "system";
  }
}

function store(next: ThemePreference): void {
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
}

/** `value` if it is a preference (stored values are checked with it). */
function themePreference(value: unknown): ThemePreference | undefined {
  return value === "system" || value === "light" || value === "dark" ? value : undefined;
}

/** Shows the current scheme, `show`n as asked when the rules above allow it, else at once. */
function apply(show: Show): void {
  const next = scheme();
  // Shown or about to be: painting it again now could land before a pending fade captures the old state.
  if (next === showing) return;
  const fade =
    show === "fade" &&
    shown &&
    "startViewTransition" in document &&
    document.visibilityState === "visible" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  showing = next;
  if (!fade) {
    paint();
    return;
  }
  let transition: ViewTransition;
  try {
    transition = document.startViewTransition({ update: paint, types: ["pi-theme"] });
  } catch {
    // Browsers with view transitions but without types take only the update function.
    transition = document.startViewTransition(paint);
  }
  // A skipped transition (the page got hidden before the browser captured the old state) rejects `ready`; `paint`
  // ran all the same, so there is nothing to report.
  transition.ready.catch(() => {});
}

/** Writes the scheme last asked to show into the DOM. */
function paint(): void {
  const resolved = showing ?? scheme();
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.colorScheme = resolved;
  // The page has one theme-color per system scheme; the resolved theme overrides both.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
    meta.setAttribute("content", BACKGROUND[resolved]);
}

/** The theme to show: a forced preference, else the system's. */
function scheme(): ThemeScheme {
  if (preference !== "system") return preference;
  return system?.matches ? "dark" : "light";
}

function changed(show: Show): void {
  apply(show);
  for (const listener of listeners) listener();
}

export const getTheme = (): ThemePreference => preference;

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Picks `next` and stores it for this browser. */
export function setTheme(next: ThemePreference): void {
  store(next);
  preference = next;
  changed("fade");
}
