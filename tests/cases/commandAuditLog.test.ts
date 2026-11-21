import { test } from "../framework/test";
import { assert } from "../framework/assert";
import {
  commandAuditLog,
  commandAuditArguments,
  redactAuditValue,
} from "../../src/util/CommandAuditLog";

test("Slash command audit contains full /ask question on one JSON-escaped line", () => {
  const question = "who are you? what can you do?";
  const line = commandAuditLog("kyuremblack", "ask", [
    { name: "question", value: question },
  ]);
  assert(
    line.startsWith("[kyuremblack] ran /ask args="),
    "Same recognisable command prefix"
  );
  assert(
    JSON.parse(line.split(" args=")[1]).question === question,
    "Complete question is available for PM2 audit"
  );
  const multiline = commandAuditLog("user", "ask", [
    { name: "question", value: "hello\nFORGED LOG ENTRY\tend" },
  ]);
  assert(
    !multiline.includes("\n") &&
      !multiline.includes("\t") &&
      JSON.parse(multiline.split(" args=")[1]).question.includes("\n"),
    "JSON encoding avoids multiline or tab log injection"
  );
});

test("Slash command audit captures nested subcommand paths and typed values", () => {
  const audit = JSON.parse(
    commandAuditArguments([
      {
        name: "event",
        options: [
          {
            name: "create",
            options: [
              { name: "title", value: "Friendly Wars Saturday" },
              { name: "max_players", value: 20 },
              { name: "open", value: true },
              { name: "thread", value: null },
            ],
          },
        ],
      },
      { name: "user", value: "123456789012345678" },
    ])
  );
  assert(
    audit["event.create.title"] === "Friendly Wars Saturday" &&
      audit["event.create.max_players"] === 20 &&
      audit["event.create.open"] === true &&
      audit["event.create.thread"] === null &&
      audit.user === "123456789012345678",
    "Nested arguments preserve their full name and value, including IDs"
  );
});

test("Command audit protects tokens, secret-named parameters and URLs with credentials", () => {
  const parsed = JSON.parse(
    commandAuditArguments([
      { name: "password", value: "a-real-password" },
      { name: "api_token", value: "a-long-token" },
      {
        name: "question",
        value: "Please check MC_AI_GROQ_KEY=very-secret-value",
      },
      { name: "description", value: "Bearer abc123-secret-value" },
      { name: "callback", value: "https://user:pass@service.example/callback" },
      {
        name: "secret nested",
        options: [{ name: "anything", value: "should-not-leak" }],
      },
    ])
  );
  assert(
    Object.values(parsed).every((value) => value === "[redacted]"),
    "Named secrets and recognisable credential-bearing text are fully redacted"
  );
  for (const token of [
    "gsk_abcdefghijklmnopqrstuvwxyz",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "AIzaabcdefghijklmnopqrstuvwxyz",
    "mfa.abcdefghijklmnopqrstuvwxyz",
    "BOT_TOKEN=a-password",
    "DATABASE_URL=postgres://login:pass@host",
  ])
    assert(
      redactAuditValue(token) === "[redacted]",
      "Recognisable credentials are never logged"
    );
});

test("Audit logging is bounded, avoids resolved objects and has no prototype pollution", () => {
  const oversized = commandAuditArguments([
    { name: "question", value: "x".repeat(9000) },
    { name: "__proto__", value: "prototype-attempt" },
    ...Array.from({ length: 40 }, (_, i) => ({ name: "item" + i, value: i })),
    { name: "resolved", value: { rawRecord: "private" } },
  ]);
  const parsed = JSON.parse(oversized);
  assert(
    parsed.question.length <= 515 && parsed.question.endsWith("[truncated]"),
    "Oversized arguments truncated before logging"
  );
  assert(
    Object.prototype.hasOwnProperty.call(parsed, "__proto__") &&
      ({} as any).polluted === undefined,
    "No prototype pollution from an option key"
  );
  assert(
    Object.keys(parsed).length <= 24 && !oversized.includes("private"),
    "Bounded item count and no raw resolved Discord objects"
  );
});
