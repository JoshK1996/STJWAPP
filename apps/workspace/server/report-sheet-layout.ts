const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const glyphWidth = (value: string) => /\s/u.test(value) ? 0.5 : /^[MW@#%]$/.test(value) ? 1.65 : /^[il.,:;'!|]$/.test(value) ? 0.65 : /^[\x20-\x7e]$/.test(value) ? 1 : 2;
const units = (value: string) => [...graphemes.segment(value)].reduce((sum, part) => sum + glyphWidth(part.segment), 0);

/** Conservative explicit line breaks keep Excel's fixed row heights predictable.
 * A bounded readable excerpt is separate from the unmodified source sheets. */
export function reportSheetText(text: string, columnWidth: number, fontSize: number, minimumHeight: number, maximumHeight: number, fullTextSheet: "Data" | "Source JSON") {
  const capacity = Math.max(4, Math.floor((columnWidth - 4) * 0.72 * 11 / fontSize));
  const lineHeight = Math.ceil(fontSize * 1.45), padding = 14;
  const maxLines = Math.max(1, Math.floor((maximumHeight - padding) / lineHeight));
  const wrap = (value: string) => {
    const lines: string[] = [];
    for (const paragraph of value.split("\n")) {
      let line = "", width = 0;
      const words = paragraph.trim().split(/\s+/u).filter(Boolean);
      for (const word of words) {
        const wordWidth = units(word);
        if (line && width + 0.5 + wordWidth <= capacity) { line += " " + word; width += 0.5 + wordWidth; continue; }
        if (line) { lines.push(line); line = ""; width = 0; }
        for (const { segment } of graphemes.segment(word)) {
          const nextWidth = glyphWidth(segment);
          if (line && width + nextWidth > capacity) { lines.push(line); line = ""; width = 0; }
          line += segment; width += nextWidth;
        }
      }
      lines.push(line);
    }
    return lines;
  };
  let lines = wrap(text), abbreviated = lines.length > maxLines;
  if (abbreviated) {
    const marker = wrap(`… [full text: ${fullTextSheet}]`);
    lines = [...lines.slice(0, Math.max(0, maxLines - marker.length)), ...marker].slice(0, maxLines);
  }
  return { text: lines.join("\n"), height: Math.max(minimumHeight, Math.min(maximumHeight, lines.length * lineHeight + padding)), abbreviated, lines: lines.length };
}
