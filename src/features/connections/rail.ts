/** The connection to bring to the front when `closed` is closed: the one after it, else the one before. */
export function frontAfterClose(open: readonly string[], closed: string): string | null {
  const at = open.indexOf(closed);
  if (at === -1) return null;
  return open[at + 1] ?? open[at - 1] ?? null;
}

/** A short label for the strip: the name, cut to what fits under an icon. */
export function railLabel(name: string): string {
  const one = name.trim().replace(/\s+/g, " ");
  return one.length > 12 ? `${one.slice(0, 11)}…` : one;
}
