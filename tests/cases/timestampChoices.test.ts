import { test } from "../framework/test";
import { assert } from "../framework/assert";
import TimestampCommand from "../../src/commands/TimeStampCommand";
import { createChatInputInteraction } from "../framework/mocks";

function extractUnixFromReply(rep: any): number | null {
  const content = String(rep?.payload?.content || "");
  const m = content.match(/<t:(\d+):/);
  return m ? parseInt(m[1], 10) : null;
}

test("timestamp uses timezone choices and yields different epochs", async () => {
  const cmd = new (TimestampCommand as any)();

  const igmt = createChatInputInteraction("U1", {
    strings: { time: "2025-01-01 19:00", timezone: "GMT", echo: false as any },
  });
  await cmd.execute(igmt as any);
  const r1 = igmt.replies.find((r: any) => r.type === "reply");
  const u1 = extractUnixFromReply(r1);

  const iest = createChatInputInteraction("U1", {
    strings: { time: "2025-01-01 19:00", timezone: "EST", echo: false as any },
  });
  await cmd.execute(iest as any);
  const r2 = iest.replies.find((r: any) => r.type === "reply");
  const u2 = extractUnixFromReply(r2);

  assert(
    u1 !== null && u2 !== null,
    "Both replies include a discord timestamp"
  );
  assert(u1 !== u2, "Different timezones produce different epoch seconds");
});
