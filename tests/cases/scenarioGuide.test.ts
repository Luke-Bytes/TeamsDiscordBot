import { ComponentType, EmbedBuilder, MessageFlags } from "discord.js";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { GameInstance } from "../../src/database/GameInstance";
import GameCommand from "../../src/commands/GameCommand";
import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import ScenarioCommand from "../../src/commands/ScenarioCommand";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { Channels } from "../../src/Channels";
import { scenarioRegistry } from "../../src/logic/scenarios/ScenarioRegistry";
import { scenarioGuide, scenarioInformation, GUIDE_MENU_ID, GUIDE_OPEN_ID, handleScenarioGuideMenu, handleScenarioGuideButton } from "../../src/logic/scenarios/ScenarioGuide";
import { announcementScenarioEmbeds, publishScenarioInformation, clearScenarioInformation } from "../../src/logic/scenarios/ScenarioAnnouncementInformation";
import { isScenarioInteraction } from "../../src/logic/scenarios/ScenarioInteractionRouter";

test("Scenario guide includes all seven playable scenarios and a clearly marked upcoming preview", () => {
  const ids = ["mystery-dungeon", "peoples-captains", "partners-in-crime", "masked-draft", "draft-roulette", "captains-wildcards", "class-hex"];
  const home = scenarioGuide()!;
  const options = home.components[0].toJSON().components[0].options;
  assertEqual(options.map((o) => o.value).join(","), ["home", ...ids, "the-impostors"].join(","), "home, playable IDs and upcoming preview");
  for (const id of ids) {
    const def = scenarioRegistry.requireAvailable(id);
    const page = scenarioGuide(id)!;
    const embed = page.embeds[0].toJSON();
    assertEqual(JSON.stringify(embed), JSON.stringify(scenarioInformation(def).toJSON()), "same guide page renderer");
    assertEqual(embed.title, def.name, "canonical display name");
    assert(embed.fields!.length >= 3 && embed.fields!.every((f) => f.value.length <= 1024), "complete Discord-safe fields");
    assert(page.embeds[0].length < 6000, "embed budget");
    assert(!JSON.stringify(embed).includes("—"), "hyphens only");
    assertEqual(page.components[0].toJSON().components[0].options.filter((o) => o.default)[0].value, id, "selected page highlighted");
  }
  assertEqual(scenarioRegistry.get("class-hex")!.name, "Cursed Classes", "internal ID unchanged");
  const preview = scenarioGuide("the-impostors")!;
  const previewEmbed = preview.embeds[0].toJSON();
  assertEqual(previewEmbed.title, "The Impostors", "planned scenario name");
  assert(previewEmbed.description!.includes("Coming soon"), "clearly not live");
  assert(previewEmbed.footer!.text.includes("Not available"), "no live command promise");
  assert(previewEmbed.fields!.every((f) => f.value.length <= 1024), "preview fields fit Discord");
  assert(options.find((o) => o.value === "the-impostors")!.label.includes("Coming soon"), "menu identifies preview");
  assert(!scenarioRegistry.available().some((s) => s.id === "the-impostors"), "preview cannot be announced");
  assertEqual(scenarioGuide("unknown"), null, "reject forged selection");
});

test("Scenario guide is accessible without a game and navigation is private and read-only", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const before = game.scenarios.snapshot();
  const replies: any[] = [];
  const updates: any[] = [];
  const reply = async (payload: any) => { replies.push(payload); };
  const command = new GameCommand();
  await command.execute({ options: { getSubcommand: () => "guide", getSubcommandGroup: () => "scenario" }, reply } as any);
  assertEqual(replies[0].flags, MessageFlags.Ephemeral, "ordinary user gets own guide");
  await handleScenarioGuideButton({ customId: GUIDE_OPEN_ID, reply } as any);
  assertEqual(replies[1].flags, MessageFlags.Ephemeral, "public learn button opens private guide");
  const menu = { customId: GUIDE_MENU_ID, values: ["class-hex"], message: { flags: { has: () => true } }, reply,
    update: async (payload: any) => { updates.push(payload); } };
  await handleScenarioGuideMenu(menu as any);
  assertEqual(updates[0].embeds[0].toJSON().title, "Cursed Classes", "private page updated");
  await handleScenarioGuideMenu({ ...menu, values: ["home"] } as any);
  assertEqual(updates[1].embeds[0].toJSON().title, "Friendly Wars - Scenario Guide", "home navigation");
  await handleScenarioGuideMenu({ ...menu, message: { flags: { has: () => false } } } as any);
  assertEqual(replies[2].flags, MessageFlags.Ephemeral, "shared message is not edited");
  await handleScenarioGuideMenu({ ...menu, values: ["invalid"] } as any);
  await handleScenarioGuideMenu({ ...menu, values: ["home", "class-hex"] } as any);
  assertEqual(updates.length, 2, "invalid navigation cannot edit");
  assertEqual(replies.length, 5, "invalid selections get a private reply");
  assert(!isScenarioInteraction({ customId: GUIDE_MENU_ID }) && !isScenarioInteraction({ customId: GUIDE_OPEN_ID }), "guide isolated from game actions");
  assertEqual(game.scenarios.snapshot(), before, "no game mutation");
});

test("Announcement preview and confirmed rendering share the guide page without affecting ordinary games", () => {
  const game = GameInstance.getInstance();
  game.reset();
  const command = new AnnouncementCommand() as any;
  try {
    for (const preview of [false, true])
      assertEqual(command.createGameAnnouncementEmbed(preview).embeds.length, 1, "no scenario page for ordinary games");
    for (const def of scenarioRegistry.available()) {
      game.scenarios.configure(def.id);
      for (const preview of [false, true]) {
        const embeds = command.createGameAnnouncementEmbed(preview).embeds;
        assertEqual(embeds.length, 2, "announcement and scenario page");
        assertEqual(JSON.stringify(embeds[1].toJSON()), JSON.stringify(scenarioInformation(def).toJSON()), "exact shared page");
        assert(embeds[0].toJSON().title.includes("FRIENDLY WAR ANNOUNCEMENT"), "primary embed stays first");
      }
      game.scenarios.reset();
    }
    const large = new EmbedBuilder().setDescription("a".repeat(4096)).addFields({ name: "large", value: "b".repeat(1024) }, { name: "large2", value: "c".repeat(700) });
    assertEqual(announcementScenarioEmbeds(large, scenarioRegistry.requireAvailable("class-hex")).length, 1, "aggregate limit preserves primary");
  } finally { game.reset(); }
});

test("Scenario publication is advisory, avoids duplicate feed pages and cleans up cancellation", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const originalChannel = Channels.gameFeed;
  const edits: any[] = [];
  const sent: any[] = [];
  let deleted = 0;
  const base = new EmbedBuilder().setTitle("FRIENDLY WAR ANNOUNCEMENT").addFields({ name: "🎭 **SCENARIO**", value: "Cursed Classes" });
  try {
    (Channels as any).gameFeed = { isSendable: () => true, send: async (payload: any) => { sent.push(payload); return { delete: async () => { deleted++; } }; } };
    (game as any).announcementMessage = { embeds: [{ ...base.toJSON(), toJSON: () => base.toJSON() }], edit: async (payload: any) => { edits.push(payload); } };
    await publishScenarioInformation(game, base);
    assertEqual(sent.length, 0, "ordinary game sends no scenario info");
    game.scenarios.configure("class-hex");
    await publishScenarioInformation(game, base);
    await publishScenarioInformation(game, base);
    assertEqual(sent.length, 1, "no duplicate feed page");
    assertEqual(sent[0].components.length, 1, "public guide has no premature private action button");
    assertEqual(edits[0].components.length, 1, "announcement has no premature private action button");
    assertEqual(sent[0].components[0].toJSON().components[0].custom_id, `${GUIDE_OPEN_ID}:${game.getLifecycleToken()}`, "guide button remains match-bound");
    assertEqual(JSON.stringify(sent[0].embeds[0].toJSON()), JSON.stringify(edits[0].embeds[1].toJSON()), "identical public page");
    await game.scenarios.cancel();
    await clearScenarioInformation(game, game.getLifecycleToken());
    assertEqual(deleted, 1, "cancelled feed page removed");
    assertEqual(edits[edits.length - 1].embeds[0].toJSON().fields[0].value, "None", "announcement no longer advertises scenario");
    game.scenarios.configure("class-hex");
    (game as any).announcementMessage = { edit: async () => { throw new Error("offline fixture"); } };
    (Channels as any).gameFeed = { isSendable: () => true, send: async () => { throw new Error("offline fixture"); } };
    await publishScenarioInformation(game, base);
  } finally {
    (Channels as any).gameFeed = originalChannel;
    game.reset();
  }
});

test("Scenario cancellation after recovery only deletes the exact match-bound bot guide page", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const token = game.getLifecycleToken();
  const channel = Channels.gameFeed;
  const removed: string[] = [];
  const message = (id: string, author: string, name: string, matchToken: string, guide: boolean) => ({
    author: { id: author }, embeds: [{ title: name }],
    components: [{ type: ComponentType.ActionRow, components: [
      { customId: `fwscopen:${matchToken}` }, ...(guide ? [{ customId: GUIDE_OPEN_ID }] : []),
    ] }],
    delete: async () => { removed.push(id); },
  });
  try {
    (Channels as any).gameFeed = { client: { user: { id: "bot" } }, messages: { fetch: async () => [
      message("match", "bot", "Cursed Classes", token, true),
      { ...message("new-match", "bot", "Cursed Classes", token, false), components: [{ type: ComponentType.ActionRow, components: [{ customId: `${GUIDE_OPEN_ID}:${token}` }] }] },
      message("old-game", "bot", "Cursed Classes", "old-token", true),
      message("other-author", "player", "Cursed Classes", token, true),
      message("other-page", "bot", "Other page", token, true),
      message("ordinary-prompt", "bot", "Cursed Classes", token, false),
    ] } };
    await clearScenarioInformation(game, token, "Cursed Classes");
    assertEqual(removed.join(","), "match,new-match", "only exact recovered information pages removed");
  } finally {
    (Channels as any).gameFeed = channel;
    game.reset();
  }
});

test("Renamed debug-scenario command retains the development-only guard", async () => {
  const command = new ScenarioCommand();
  assertEqual(command.name, "debug-scenario", "registered command name");
  assertEqual(command.data.toJSON().name, command.name, "builder and dispatch agree");
  const original = PermissionsUtil.isDebugEnabled;
  const replies: any[] = [];
  try {
    PermissionsUtil.isDebugEnabled = () => false;
    await command.execute({ replied: false, deferred: false, reply: async (payload: any) => { replies.push(payload); } } as any);
    assertEqual(replies[0].flags, MessageFlags.Ephemeral, "private development guard");
    assert(replies[0].content.includes("development mode"), "denied before fixture mutation");
  } finally { PermissionsUtil.isDebugEnabled = original; }
});
