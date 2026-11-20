/** The name with the characters the filter matched in bold. */
export function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return text;
  const hit = new Set(indices);
  return Array.from(text, (char, i) =>
    hit.has(i) ? (
      <b key={i} className="font-semibold text-foreground">
        {char}
      </b>
    ) : (
      char
    ),
  );
}
