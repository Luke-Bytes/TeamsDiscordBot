import { test } from "../framework/test";
import { assert } from "../framework/assert";
import IgnsCommand from "../../src/commands/IgnsCommand";
import { createChatInputInteraction } from "../framework/mocks";
import { PrismaUtils } from "../../src/util/PrismaUtils";

test("/igns lists all minecraft accounts for self when no user param provided", async () => {
  const cmd = new IgnsCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      discordSnowflake: "U1",
      latestIGN: "Name_One",
      minecraftAccounts: ["Name_One", "SecondIGN"],
    });
    const i = createChatInputInteraction("U1", { strings: {} });
    await cmd.execute(i as any);
    const reply = i.replies.find((r: any) => r.type === "editReply");
    assert(!!reply && reply.payload?.embeds, "Responds with embed");
    const fields = reply.payload.embeds[0]?.data?.fields ?? [];
    const accountsField = fields.find((f: any) => /Accounts/i.test(f.name));
    const val = String(accountsField?.value || "");
    assert(
      val.includes("1. Name_One") && val.includes("2. SecondIGN"),
      "Lists accounts while formatting safely"
    );
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
  }
});
