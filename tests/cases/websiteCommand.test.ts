import { test } from "../framework/test";
import { assert } from "../framework/assert";
import WebsiteCommand from "../../src/commands/WebsiteCommand";
import { createChatInputInteraction } from "../framework/mocks";

test("/website responds with link", async () => {
  const cmd = new WebsiteCommand();
  const i = createChatInputInteraction("U1");
  await cmd.execute(i as any);
  const reply = i.replies.find((r: any) => r.type === "reply");
  assert(
    String(reply?.payload?.content || "").includes("https://anniwars.win/"),
    "Includes website link"
  );
});
