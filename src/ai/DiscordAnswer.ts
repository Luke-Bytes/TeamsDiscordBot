/** Reject unsupported slash paths when Discord's registered catalogue is available. */
export function unverifiedSlashCommands(
  reply: string,
  paths: readonly string[]
): string[] {
  const allowed = new Set(paths.map((path) => path.toLowerCase()));
  const roots = new Set(paths.map((path) => path.split(" ")[0].toLowerCase()));
  const invalid: string[] = [];
  const prose = new Set([
    "to",
    "for",
    "with",
    "after",
    "before",
    "and",
    "or",
    "in",
    "on",
    "if",
    "when",
    "then",
    "from",
    "as",
    "is",
    "will",
  ]);
  for (const match of reply.matchAll(
    /(?:^|[\s(`])\/([a-z][a-z0-9_-]*)(?:[ \t]+([a-z][a-z0-9_-]*)(?![\w:-]))?(?:[ \t]+([a-z][a-z0-9_-]*)(?![\w:-]))?/gi
  )) {
    const root = `/${match[1].toLowerCase()}`;
    const child = match[2]?.toLowerCase();
    const third = match[3]?.toLowerCase();
    const prefix = `${root} ${child}`;
    if (
      !roots.has(root) ||
      (child &&
        !prose.has(child) &&
        paths.some((path) => path.toLowerCase().startsWith(`${root} `)) &&
        !allowed.has(prefix) &&
        !paths.some((path) => path.toLowerCase().startsWith(`${prefix} `))) ||
      (child &&
        third &&
        !prose.has(third) &&
        paths.some((path) => path.toLowerCase().startsWith(`${prefix} `)) &&
        !allowed.has(`${prefix} ${third}`))
    )
      invalid.push(match[0].trim());
  }
  return invalid;
}

/** Keep the last complete sentence or list row rather than slicing mid-command. */
export function completeDiscordReply(text: string, limit = 1450): string {
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit);
  const boundaries = [...clipped.matchAll(/[.!?](?=\s|$)|\n(?=\S)/g)]
    .map((match) => match.index! + (match[0] === "\n" ? 0 : 1))
    .filter((index) => index > 150);
  if (!boundaries.length)
    return "That answer is too long to fit safely in one reply. Ask me for a shorter summary.";
  return clipped.slice(0, boundaries[boundaries.length - 1]).trim();
}

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
