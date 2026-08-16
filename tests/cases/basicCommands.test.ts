import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import CaptainCommand from "../../src/commands/CaptainCommand";
import RegisterCommand from "../../src/commands/RegisterCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import UnregisterCommand from "../../src/commands/UnregisterCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ModifierSelector } from "../../src/logic/ModifierSelector";
import { ConfigManager } from "../../src/ConfigManager";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";

// Provide minimal TeamCommand instance dependency for commands that need it
const teamCommand = new TeamCommand();

test("AnnouncementCommand handleButtonPress default path responds", async () => {
  const cmd = new AnnouncementCommand();
  const guild = new FakeGuild() as any;
  // simulate an unrelated button to hit default
  const interaction = createChatInputInteraction("u1", { guild });
  await cmd.handleButtonPress!({
    customId: "unknown-button",
    deferReply: async () => ({}) as any,
    editReply: async (_: any) => ({}) as any,
    guild,
  } as any);
  assert(true, "button handled");
});

test("AnnouncementCommand reroll modifiers is rate-limited to once every 15 seconds", async () => {
  const cmd = new AnnouncementCommand() as any;
  const guild = new FakeGuild() as any;
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.modifierMode = "randomised";

  let rerolls = 0;
  const originalRunSelection = ModifierSelector.runSelection;
  const originalUpdateAnnouncementMessages = cmd.updateAnnouncementMessages;

  ModifierSelector.runSelection = (() => {
    rerolls += 1;
  }) as typeof ModifierSelector.runSelection;
  cmd.updateAnnouncementMessages = async () => {};
  cmd.initialBannedClasses = [];

  const replies: string[] = [];
  const interaction: any = {
    customId: "announcement-edit-modifiers",
    deferReply: async () => ({}),
    editReply: async (payload: any) => {
      replies.push(typeof payload === "string" ? payload : String(payload));
      return {};
    },
    guild,
  };

  try {
    await cmd.handleButtonPress(interaction);
    await cmd.handleButtonPress(interaction);

    assert(rerolls === 1, "Second reroll should be blocked by cooldown");
    assert(
      replies.some((r) => /Modifiers have been rerolled/i.test(r)),
      "First reroll should succeed"
    );
    assert(
      replies.some((r) => /on cooldown/i.test(r)),
      "Second reroll should return a cooldown message"
    );
  } finally {
    ModifierSelector.runSelection = originalRunSelection;
    cmd.updateAnnouncementMessages = originalUpdateAnnouncementMessages;
    game.reset();
  }
});

test("Announcement modifier modes configure captain bans without clearing organiser bans", () => {
  const cmd = new AnnouncementCommand() as any;
  const game = CurrentGameManager.getCurrentGame();

  game.reset();
  cmd.initialBannedClasses = ["SCOUT"];
  cmd.configureModifierMode("default");
  assert(game.modifierMode === "default", "Default mode should be recorded");
  assert(game.classBanMode === "shared", "Default bans should be shared");
  assert(game.classBanLimit === 2, "Default should allow one ban per captain");
  assert(
    game.settings.organiserBannedClasses.includes("SCOUT" as any),
    "Default should preserve organiser bans"
  );

  cmd.configureModifierMode("none");
  assert(game.modifierMode === "none", "None mode should be recorded");
  assert(
    game.classBanMode === null,
    "None should disable the captain ban mode"
  );
  assert(game.classBanLimit === 0, "None should disable /class ban");
  assert(
    game.settings.organiserBannedClasses.includes("SCOUT" as any),
    "None should preserve organiser bans"
  );
  assert(game.settings.modifiers.length === 0, "None should use baselines");
  game.reset();
});

test("Custom modifier editor stages changes and applies only on save", async () => {
  const cmd = new AnnouncementCommand() as any;
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  cmd.initialBannedClasses = ["SCOUT"];
  cmd.configureModifierMode("custom");

  const cfg = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  const organiser = new FakeGuildMember("custom-org");
  await organiser.roles.add(cfg.roles.organiserRole);
  guild.addMember(organiser);

  const previewEdits: any[] = [];
  const preview = {
    edit: async (payload: any) => previewEdits.push(payload),
  } as any;
  cmd.announcementPreviewMessage = preview;

  const editorReplies: any[] = [];
  await cmd.handleButtonPress({
    customId: "announcement-edit-modifiers",
    user: { id: organiser.id },
    guild,
    reply: async (payload: any) => editorReplies.push(payload),
  } as any);
  assert(editorReplies.length === 1, "Custom editor should open ephemerally");

  const updates: any[] = [];
  const select = async (customId: string, value: string) =>
    cmd.handleSelectMenu({
      customId,
      values: [value],
      user: { id: organiser.id },
      guild,
      update: async (payload: any) => updates.push(payload),
      reply: async () => {},
    } as any);

  await select("announcement-custom-category", "Nexus HP");
  await select("announcement-custom-value", "100");
  assert(
    game.settings.modifiers.length === 0,
    "Selecting a value should not mutate the game before Save"
  );

  await cmd.handleButtonPress({
    customId: "announcement-custom-save",
    user: { id: organiser.id },
    guild,
    update: async (payload: any) => updates.push(payload),
    reply: async () => {},
  } as any);

  assert(
    game.settings.modifiers.some(
      (modifier: any) =>
        modifier.category === "Nexus HP" && modifier.name === "100"
    ),
    "Save should apply the staged non-default modifier"
  );
  assert(
    game.settings.organiserBannedClasses.includes("SCOUT" as any),
    "Custom Save should preserve organiser bans"
  );
  assert(previewEdits.length === 1, "Save should refresh the preview");
  game.reset();
});

test("Announcement organiser autocomplete includes the new organisers", async () => {
  const cmd = new AnnouncementCommand();
  const results: any[] = [];
  await cmd.handleAutocomplete!({
    options: {
      getFocused: () => ({ name: "organiser", value: "" }),
    },
    respond: async (choices: any[]) => results.push(...choices),
  } as any);

  assert(
    results.some((choice) => choice.value === "JOJOB3AN"),
    "JOJOB3AN should be an organiser choice"
  );
  assert(
    results.some((choice) => choice.value === "xNolva"),
    "xNolva should be an organiser choice"
  );
});

test("CaptainCommand errors when used outside guild", async () => {
  const cmd = new CaptainCommand(teamCommand);
  const interaction = createChatInputInteraction("u2"); // no guild
  await cmd.execute(interaction);
  assert(interaction.replies.length > 0, "should have replied with an error");
});

test("RegisterCommand enforces registration channel or no-announcement check", async () => {
  const cmd = new RegisterCommand(teamCommand);
  const interaction = createChatInputInteraction("u3", {
    channelId: "not-registration",
  });
  await cmd.execute(interaction);
  assert(interaction.replies.length > 0, "should reply early");
});

test("TeamCommand list subcommand responds", async () => {
  const cmd = new TeamCommand();
  const interaction = createChatInputInteraction("u4", { subcommand: "list" });
  await cmd.execute(interaction);
  assert(true, "list handled");
});

test("UnregisterCommand enforces registration channel or no-announcement check", async () => {
  const cmd = new UnregisterCommand(teamCommand);
  const interaction = createChatInputInteraction("u5", {
    channelId: "not-registration",
  });
  await cmd.execute(interaction);
  assert(interaction.replies.length > 0, "should reply early");
});

test("PlayerCommand basic exec does not throw", async () => {
  const Cmd = (await import("../../src/commands/PlayerCommand")).default;
  const cmd = new Cmd();
  const interaction = createChatInputInteraction("u6");
  await cmd.execute(interaction);
  assert(true, "player executed");
});

test("WinnerCommand basic exec does not throw", async () => {
  const Cmd = (await import("../../src/commands/WinnerCommand")).default;
  const cmd = new Cmd();
  const interaction = createChatInputInteraction("u7");
  await cmd.execute(interaction);
  assert(true, "winner executed");
});

test("MVPCommand basic exec does not throw", async () => {
  const Cmd = (await import("../../src/commands/MVPCommand")).default;
  const cmd = new Cmd();
  const interaction = createChatInputInteraction("u8");
  await cmd.execute(interaction);
  assert(true, "mvp executed");
});

test("GameCommand basic exec does not throw", async () => {
  const Cmd = (await import("../../src/commands/GameCommand")).default;
  const cmd = new Cmd();
  const interaction = createChatInputInteraction("u9");
  await cmd.execute(interaction);
  assert(true, "game executed");
});

test("MissingCommand basic exec does not throw", async () => {
  const Cmd = (await import("../../src/commands/MissingCommand")).default;
  const cmd = new Cmd();
  const guild = new FakeGuild() as any;
  const interaction = createChatInputInteraction("u10", { guild });
  await cmd.execute(interaction);
  assert(true, "missing executed");
});

test("TeamlessCommand basic exec does not throw", async () => {
  const Cmd = (await import("../../src/commands/TeamlessCommand")).default;
  const cmd = new Cmd();
  const interaction = createChatInputInteraction("u11");
  await cmd.execute(interaction);
  assert(true, "teamless executed");
});

test("ClassbanCommand basic exec does not throw", async () => {
  const Cmd = (await import("../../src/commands/ClassbanCommand")).default;
  const cmd = new Cmd();
  const interaction = createChatInputInteraction("u12");
  await cmd.execute(interaction);
  assert(true, "classban executed");
});

test("TimestampCommand basic exec does not throw", async () => {
  const Cmd = (await import("../../src/commands/TimeStampCommand")).default;
  const cmd = new Cmd();
  const interaction = createChatInputInteraction("u13");
  await cmd.execute(interaction);
  assert(true, "timestamp executed");
});
