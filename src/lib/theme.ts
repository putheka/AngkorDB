/**
 * Keep the `.dark` class on <html> in sync with macOS appearance.
 * shadcn/ui tokens switch on `.dark`; a manual override comes in ANG-51.
 */
export function syncSystemTheme(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", media.matches);
  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
