/**
 * PM2 command audit logs are operator-visible and can outlive an interaction.
 * Keep typed slash-command parameters useful, but never dump resolved Discord
 * objects, free-form unbounded text, or recognisable credential values.
 */
export type AuditableOption = {
  name: string;
  value?: unknown;
  options?: readonly AuditableOption[];
};

const SENSITIVE_NAME =
  /(?:password|passphrase|secret|token|credential|authorization|api[-_]?key|access[-_]?key|webhook|otp|private[-_]?key)/i;
const SENSITIVE_VALUE =
  /(?:gsk_[a-z0-9_-]{16,}|sk-[a-z0-9_-]{16,}|AIza[a-z0-9_-]{20,}|mfa\.[a-z0-9_-]{20,}|\bBearer\s+\S+|-----BEGIN\s+[^\n]*PRIVATE KEY-----|\b(?:MC_AI_[A-Z0-9_]+|BOT_TOKEN|DATABASE_URL|API_KEY|ACCESS_TOKEN|PASSWORD|SECRET|AUTHORIZATION)\s*[:=]\s*\S+|https?:\/\/[^\s/]+:[^\s/@]+@)/i;

const MAX_ARGUMENTS = 24;
const MAX_VALUE_LENGTH = 500;
const MAX_TOTAL_LENGTH = 2400;

export function redactAuditValue(raw: string): string {
  // For unexpected formats, drop the entire suspect value rather than
  // retaining a fragment of a token or accidentally logging its prefix.
  if (SENSITIVE_VALUE.test(raw)) return "[redacted]";
  return raw;
}

export function commandAuditArguments(
  options: readonly AuditableOption[]
): string {
  const values: Record<string, string | number | boolean | null> =
    Object.create(null);
  let remaining = MAX_TOTAL_LENGTH;
  let count = 0;

  function visit(
    items: readonly AuditableOption[],
    parents: string[],
    depth: number
  ): void {
    if (depth > 4) return;
    for (const item of items) {
      if (count >= MAX_ARGUMENTS || remaining <= 0) return;
      if (!item || typeof item.name !== "string") continue;
      const name = item.name.slice(0, 80);
      const path = [...parents, name];
      if (Array.isArray(item.options)) {
        visit(item.options, path, depth + 1);
      } else {
        count++;
        const key = path.join(".").slice(0, 260);
        const sensitive = path.some((part) => SENSITIVE_NAME.test(part));
        const raw = item.value;
        if (sensitive) {
          values[key] = "[redacted]";
        } else if (typeof raw === "string") {
          const safe = redactAuditValue(raw);
          const clipped = safe.slice(0, Math.min(MAX_VALUE_LENGTH, remaining));
          values[key] =
            clipped.length < safe.length ? clipped + "…[truncated]" : clipped;
          remaining -= clipped.length;
        } else if (typeof raw === "number" && Number.isFinite(raw)) {
          values[key] = raw;
        } else if (typeof raw === "boolean" || raw === null) {
          values[key] = raw;
        } else {
          values[key] = "[omitted]";
        }
      }
    }
  }

  visit(options, [], 0);
  return JSON.stringify(values);
}

export function commandAuditLog(
  tag: string,
  commandName: string,
  options: readonly AuditableOption[]
): string {
  const safeTag = redactAuditValue(tag)
    .replace(/[\r\n\u0000-\u001f\u007f]/g, "")
    .slice(0, 96);
  const safeCommand = commandName.replace(/[^a-z0-9_-]/gi, "").slice(0, 70);
  return `[${safeTag}] ran /${safeCommand} args=${commandAuditArguments(options)}`;
}
