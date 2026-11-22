/** A small last-mile safeguard: Discord renders lists and bold, not Markdown tables. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function tableDivider(line: string, columns: number): boolean {
  const cells = tableCells(line);
  return (
    cells?.length === columns && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function simpleLabel(value: string): string {
  return value.replace(/^\*\*(.*?)\*\*$/, "$1");
}

/**
 * A fallback for provider formatting mistakes, not a substitute for the
 * model's Discord style prompt. Keep supported Discord **bold** and bullets.
 */
export function formatNaviDiscordMessage(message: string): string {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  const rendered: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const header = tableCells(lines[index]);
    if (
      header &&
      header.length >= 2 &&
      index + 2 < lines.length &&
      tableDivider(lines[index + 1], header.length)
    ) {
      let cursor = index + 2;
      while (cursor < lines.length) {
        const cells = tableCells(lines[cursor]);
        if (!cells || cells.length !== header.length) break;
        const ranked = /^(?:rank|#)$/i.test(header[0]);
        const leadCount = ranked ? 2 : 1;
        const lead = ranked
          ? `${simpleLabel(cells[0])}. ${simpleLabel(cells[1])}`
          : simpleLabel(cells[0]);
        const details = cells
          .slice(leadCount)
          .map((value, column) => `${header[column + leadCount]}: ${value}`)
          .join(" · ");
        rendered.push(
          `${ranked ? "" : "- "}${lead}${details ? ` — ${details}` : ""}`
        );
        cursor++;
      }
      if (cursor > index + 2) {
        index = cursor - 1;
        continue;
      }
    }
    const line = lines[index];
    // Strip code fence delimiters, not the useful slash command inside them.
    if (/^\s*(?:```|''')[a-z0-9_-]*\s*$/i.test(line)) continue;
    rendered.push(
      line.replace(/^\s{0,3}#{1,6}\s+(.+)$/, "$1").replace(/^\s{0,3}>\s?/, "")
    );
  }
  let boldUsed = false;
  return (
    rendered
      .join("\n")
      .replace(
        /\b(?:run|call|execute|use|try|check)\s+`?(?:get|list|search)_[a-z][a-z0-9_]*`?/gi,
        "ask Navi to check"
      )
      .replace(
        /\b(?:get|list|search)_[a-z][a-z0-9_]*\b/gi,
        "Navi's internal lookup"
      )
      // The model occasionally invents HTTP syntax for a genuine slash command.
      .replace(/\bGET\s+(\/(?:registered|stats|leaderboards|help))\b/g, "$1")
      // Most of a conversational reply should remain plain text. Preserve at
      // most one short emphasis; never decorate every row of a leaderboard.
      .replace(/\*\*([^*\n]+)\*\*/g, (_match, content: string) => {
        if (boldUsed || content.length > 45) return content;
        boldUsed = true;
        return `**${content}**`;
      })
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
      .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
