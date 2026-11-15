import { escapeText } from "../util/Utils";

export function eventCsvCell(value: unknown): string {
  let text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function eventPages(text: string, limit = 1800): string[] {
  const pages: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const split = newline > limit / 2 ? newline : limit;
    pages.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  pages.push(remaining || "(empty)");
  return pages;
}

export function eventDisplay(value: string): string {
  return escapeText(value);
}
