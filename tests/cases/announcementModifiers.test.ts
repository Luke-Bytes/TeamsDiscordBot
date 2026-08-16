import { MessageFlags } from "discord.js";
import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import { ConfigManager } from "../../src/ConfigManager";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ModifierSelector } from "../../src/logic/ModifierSelector";
import { assert, assertEqual } from "../framework/assert";
import { FakeGuild, FakeGuildMember } from "../framework/mocks";
import { test } from "../framework/test";

type TestInteraction = {
  customId: string;
  values?: string[];
  user: { id: string };
  guild: FakeGuild;
  replies: any[];
  updates: any[];
  reply: (payload: any) => Promise<void>;
  update: (payload: any) => Promise<void>;
  deferReply: () => Promise<void>;
  editReply: (payload: any) => Promise<void>;
};

function makeInteraction(
  customId: string,
  userId: string,
  guild: FakeGuild,
  values?: string[]
): TestInteraction {
  const replies: any[] = [];
  const updates: any[] = [];
  return {
    customId,
    values,
    user: { id: userId },
    guild,
    replies,
    updates,
    reply: async (payload: any) => {
      replies.push(payload);
    },
    update: async (payload: any) => {
      updates.push(payload);
    },
    deferReply: async () => {},
    editReply: async (payload: any) => {
      replies.push(payload);
    },
  };
}

async function addOrganiser(guild: FakeGuild, id: string) {
  const member = new FakeGuildMember(id);
  await member.roles.add(ConfigManager.getConfig().roles.organiserRole);
  guild.addMember(member);
  return member;
}

function prepareCustomCommand() {
  const command = new AnnouncementCommand() as any;
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  command.initialBannedClasses = ["SCOUT"];
  command.configureModifierMode("custom");
  const previewEdits: any[] = [];
  command.announcementPreviewMessage = {
    edit: async (payload: any) => {
      previewEdits.push(payload);
    },
  };
  return { command, game, previewEdits };
}

async function chooseCustomModifier(
  command: any,
  guild: FakeGuild,
  userId: string,
  category: string,
  value: string
) {
  await command.handleSelectMenu(
    makeInteraction("announcement-custom-category", userId, guild, [
      category,
    ]) as any
  );
  await command.handleSelectMenu(
    makeInteraction("announcement-custom-value", userId, guild, [value]) as any
  );
}

test("Announcement exposes exactly the four modifier modes", () => {
  const command = new AnnouncementCommand();
  const json = command.data.toJSON() as any;
  const start = json.options.find((option: any) => option.name === "start");
  const modifiers = start.options.find(
    (option: any) => option.name === "modifiers"
  );

  assert(modifiers.required === true, "Modifier mode should remain required");
  assertEqual(modifiers.choices.length, 4, "Should expose four modifier modes");
  assert(
    JSON.stringify(modifiers.choices) ===
      JSON.stringify([
        { name: "Custom", value: "custom" },
        { name: "Randomised", value: "randomised" },
        { name: "Default", value: "default" },
        { name: "None", value: "none" },
      ]),
    "Modifier choices should have the expected labels, values, and order"
  );
});

test("ModifierSelector maps defaults and changed choices without mutating config", () => {
  const selector = new ModifierSelector();
  const defaults = selector.getDefaultChoices();
  const categories = selector.getCategories();

  assertEqual(
    Object.keys(defaults).length,
    categories.length,
    "Every modifier category should have a default"
  );
  assertEqual(
    selector.selectionsFromChoices(defaults).length,
    0,
    "Baseline choices should be omitted from stored modifiers"
  );

  const changed = { ...defaults, "Nexus HP": "100" };
  const selections = selector.selectionsFromChoices(changed);
  assertEqual(selections.length, 1, "Only changed choices should be stored");
  assert(
    selections[0].category === "Nexus HP" && selections[0].name === "100",
    "Changed Nexus HP should be represented exactly"
  );
  assert(
    selector.getDefaultChoices()["Nexus HP"] === "75",
    "Editing a returned choice map must not mutate selector defaults"
  );

  let rejected = false;
  try {
    selector.selectionsFromChoices({ ...defaults, "Nexus HP": "999" });
  } catch (error) {
    rejected = /Unknown modifier/.test(String(error));
  }
  assert(rejected, "Unknown custom modifier values should be rejected");
});

test("ModifierSelector random rolls omit baselines and respect categories", () => {
  const selector = new ModifierSelector();
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    assertEqual(
      selector.select().length,
      0,
      "Rolling the first option should produce no stored modifiers"
    );

    Math.random = () => 0.999999;
    const selections = selector.select();
    const categories = new Set(
      selections.map((selection) => selection.category)
    );
    assertEqual(
      categories.size,
      selections.length,
      "A random roll should not duplicate categories"
    );
    assert(
      selections.some(
        (selection) =>
          selection.category === "Nexus HP" && selection.name === "125"
      ),
      "Weighted selection should be able to choose a non-default value"
    );
  } finally {
    Math.random = originalRandom;
  }
});

test("Applying modifiers resets derived state and enforces selected effects", () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.settings.organiserBannedClasses = [
    "SCOUT",
    "SWAPPER",
    "TRANSPORTER",
  ] as any;
  game.settings.sharedCaptainBannedClasses = ["ACROBAT"] as any;
  game.settings.nonSharedCaptainBannedClasses = {
    RED: ["SWAPPER"] as any,
    BLUE: ["TRANSPORTER"] as any,
  };

  ModifierSelector.applySelection([
    { category: "Class Bans", name: "Delayed Ban (Phase 3)" },
    { category: "Swapper", name: "Enabled" },
    { category: "TP Enabled - Skying Banned", name: "Enabled" },
    {
      category: "Captain's Pick Other Team's Support Roles",
      name: "Yes",
    },
  ]);

  assert(game.classBanMode === "shared", "Delayed bans should use shared mode");
  assertEqual(
    game.classBanLimit,
    2,
    "Delayed bans should allow one per captain"
  );
  assertEqual(
    game.settings.delayedBan,
    3,
    "Delayed-ban phase should be applied"
  );
  assert(
    game.pickOtherTeamsSupportRoles,
    "Support-role picking should be enabled"
  );
  assert(
    !game.settings.organiserBannedClasses.includes("SWAPPER" as any) &&
      !game.settings.organiserBannedClasses.includes("TRANSPORTER" as any),
    "Modifier-protected classes should be removed from organiser bans"
  );
  assertEqual(
    game.settings.sharedCaptainBannedClasses.length,
    0,
    "Applying a new selection should clear old shared captain bans"
  );
  assertEqual(
    game.settings.nonSharedCaptainBannedClasses.RED.length +
      game.settings.nonSharedCaptainBannedClasses.BLUE.length,
    0,
    "Applying a new selection should clear old team-specific captain bans"
  );

  ModifierSelector.applySelection([]);
  assert(game.classBanMode === null, "Baselines should disable captain bans");
  assertEqual(game.classBanLimit, 0, "Baselines should set a zero ban limit");
  assertEqual(
    game.settings.delayedBan,
    0,
    "Baselines should clear delayed bans"
  );
  assert(
    !game.pickOtherTeamsSupportRoles,
    "Baselines should disable support picks"
  );
  assertEqual(
    game.settings.modifiers.length,
    0,
    "Baselines should store no modifiers"
  );
  game.reset();
});

test("All announcement modes reset stale state and preserve organiser bans", () => {
  const command = new AnnouncementCommand() as any;
  const game = CurrentGameManager.getCurrentGame();
  const originalRunSelection = ModifierSelector.runSelection;
  let randomRuns = 0;
  ModifierSelector.runSelection = (() => {
    randomRuns += 1;
  }) as typeof ModifierSelector.runSelection;

  try {
    game.reset();
    command.initialBannedClasses = ["SCOUT"];
    game.settings.sharedCaptainBannedClasses = ["ACROBAT"] as any;
    game.settings.delayedBan = 4;
    game.pickOtherTeamsSupportRoles = true;

    command.configureModifierMode("randomised");
    assertEqual(
      randomRuns,
      1,
      "Randomised mode should run the weighted selector"
    );
    assert(
      game.modifierMode === "randomised",
      "Randomised mode should be stored"
    );
    assert(
      game.settings.organiserBannedClasses.includes("SCOUT" as any),
      "Randomised mode should preserve organiser bans before applying its roll"
    );
    assertEqual(
      game.settings.delayedBan,
      0,
      "Mode changes should clear stale delay"
    );
    assert(
      !game.pickOtherTeamsSupportRoles,
      "Mode changes should clear stale flags"
    );

    command.configureModifierMode("default");
    assert(game.classBanMode === "shared", "Default should use shared bans");
    assertEqual(
      game.classBanLimit,
      2,
      "Default should allow one ban per captain"
    );

    command.configureModifierMode("none");
    assert(game.classBanMode === null, "None should disable captain bans");
    assertEqual(game.classBanLimit, 0, "None should disable /class ban");
    assertEqual(game.settings.modifiers.length, 0, "None should use baselines");

    command.configureModifierMode("custom");
    assert(
      game.classBanMode === null,
      "Custom defaults should disable captain bans"
    );
    assertEqual(
      game.classBanLimit,
      0,
      "Custom should start from baseline values"
    );
    assertEqual(
      Object.keys(command.customModifierChoices).length,
      command.modifierSelector.getCategories().length,
      "Custom should initialize every category to its default"
    );
  } finally {
    ModifierSelector.runSelection = originalRunSelection;
    game.reset();
  }
});

test("Custom editor is ephemeral, organiser-only, and shows every category", async () => {
  const { command, game } = prepareCustomCommand();
  const guild = new FakeGuild();
  await addOrganiser(guild, "org");
  guild.addMember(new FakeGuildMember("player"));

  const denied = makeInteraction(
    "announcement-edit-modifiers",
    "player",
    guild
  );
  await command.handleButtonPress(denied as any);
  assert(
    /Only organisers/.test(denied.replies[0].content),
    "Non-organisers should be rejected"
  );
  assertEqual(
    command.customModifierSessions.size,
    0,
    "Rejected users should not receive a session"
  );

  const opened = makeInteraction("announcement-edit-modifiers", "org", guild);
  await command.handleButtonPress(opened as any);
  assertEqual(opened.replies.length, 1, "Organiser should receive the editor");
  assertEqual(
    opened.replies[0].flags,
    MessageFlags.Ephemeral,
    "Custom editor should be ephemeral"
  );
  const categoryMenu = opened.replies[0].components[0].toJSON().components[0];
  assertEqual(
    categoryMenu.options.length,
    new ModifierSelector().getCategories().length,
    "Editor should expose every configured category"
  );
  assert(
    /No changes from baseline defaults/.test(opened.replies[0].content),
    "Fresh Custom editor should summarize baseline state"
  );
  game.reset();
});

test("Custom reset and cancel discard staged modifier changes", async () => {
  const { command, game } = prepareCustomCommand();
  const guild = new FakeGuild();
  await addOrganiser(guild, "org");

  await command.handleButtonPress(
    makeInteraction("announcement-edit-modifiers", "org", guild) as any
  );
  await chooseCustomModifier(command, guild, "org", "Nexus HP", "100");
  assertEqual(
    game.settings.modifiers.length,
    0,
    "Staged edits must not apply early"
  );

  const reset = makeInteraction("announcement-custom-reset", "org", guild);
  await command.handleButtonPress(reset as any);
  const session = command.customModifierSessions.get("org");
  assert(
    session.choices["Nexus HP"] === "75",
    "Reset should restore the category default"
  );
  assert(
    /Reset to baseline defaults/.test(reset.updates[0].content),
    "Reset should confirm what happened"
  );

  await chooseCustomModifier(command, guild, "org", "Nexus HP", "125");
  const cancel = makeInteraction("announcement-custom-cancel", "org", guild);
  await command.handleButtonPress(cancel as any);
  assertEqual(
    command.customModifierSessions.size,
    0,
    "Cancel should close the session"
  );
  assertEqual(
    game.settings.modifiers.length,
    0,
    "Cancel should discard staged values"
  );
  game.reset();
});

test("Custom save applies all staged choices atomically and refreshes preview", async () => {
  const { command, game, previewEdits } = prepareCustomCommand();
  const guild = new FakeGuild();
  await addOrganiser(guild, "org");

  await command.handleButtonPress(
    makeInteraction("announcement-edit-modifiers", "org", guild) as any
  );
  await chooseCustomModifier(command, guild, "org", "Nexus HP", "100");
  await chooseCustomModifier(
    command,
    guild,
    "org",
    "Captain's Pick Other Team's Support Roles",
    "Yes"
  );
  await chooseCustomModifier(
    command,
    guild,
    "org",
    "Class Bans",
    "1 Captain Ban Each (Shared)"
  );

  const save = makeInteraction("announcement-custom-save", "org", guild);
  await command.handleButtonPress(save as any);

  assertEqual(
    game.settings.modifiers.length,
    3,
    "Save should apply every changed category"
  );
  assert(
    game.settings.modifiers.some(
      (modifier: any) =>
        modifier.category === "Nexus HP" && modifier.name === "100"
    ),
    "Saved choices should contain Nexus HP"
  );
  assert(
    game.pickOtherTeamsSupportRoles,
    "Saved support-role choice should take effect"
  );
  assert(
    game.classBanMode === "shared",
    "Saved class-ban mode should take effect"
  );
  assertEqual(
    game.classBanLimit,
    2,
    "Saved class-ban limit should take effect"
  );
  assert(
    game.settings.organiserBannedClasses.includes("SCOUT" as any),
    "Save should preserve organiser-provided bans"
  );
  assertEqual(
    previewEdits.length,
    1,
    "Save should refresh the announcement preview"
  );
  assertEqual(
    command.customModifierSessions.size,
    0,
    "Save should close the editor"
  );
  game.reset();
});

test("Older Custom sessions expire after another organiser saves", async () => {
  const { command, game } = prepareCustomCommand();
  const guild = new FakeGuild();
  await addOrganiser(guild, "org-a");
  await addOrganiser(guild, "org-b");

  await command.handleButtonPress(
    makeInteraction("announcement-edit-modifiers", "org-a", guild) as any
  );
  await command.handleButtonPress(
    makeInteraction("announcement-edit-modifiers", "org-b", guild) as any
  );
  await chooseCustomModifier(command, guild, "org-a", "Nexus HP", "100");
  await chooseCustomModifier(command, guild, "org-b", "Nexus HP", "125");

  await command.handleButtonPress(
    makeInteraction("announcement-custom-save", "org-a", guild) as any
  );
  const staleSave = makeInteraction("announcement-custom-save", "org-b", guild);
  await command.handleButtonPress(staleSave as any);

  assert(
    /expired/.test(staleSave.replies[0].content),
    "An older editor should be rejected after another save"
  );
  assert(
    game.settings.modifiers.some(
      (modifier: any) =>
        modifier.category === "Nexus HP" && modifier.name === "100"
    ),
    "A stale save must not overwrite the committed selection"
  );
  game.reset();
});

test("Modifier editing and rerolling lock after announcement confirmation", async () => {
  const custom = prepareCustomCommand();
  const guild = new FakeGuild();
  await addOrganiser(guild, "org");
  custom.command.announcementMessage = { edit: async () => {} };

  const customClick = makeInteraction(
    "announcement-edit-modifiers",
    "org",
    guild
  );
  await custom.command.handleButtonPress(customClick as any);
  assert(
    /locked/.test(customClick.replies[0].content),
    "Custom editor should be locked after confirmation"
  );

  const random = new AnnouncementCommand() as any;
  random.announcementMessage = { edit: async () => {} };
  CurrentGameManager.getCurrentGame().modifierMode = "randomised";
  const reroll = makeInteraction("announcement-edit-modifiers", "org", guild);
  await random.handleButtonPress(reroll as any);
  assert(
    reroll.replies.some((reply) => /locked/.test(String(reply))),
    "Random reroll should be locked after confirmation"
  );

  const rows = random.getEditComponents(true);
  const modifierButton = rows[1]
    .toJSON()
    .components.find(
      (component: any) => component.custom_id === "announcement-edit-modifiers"
    );
  assert(
    modifierButton.disabled === true,
    "Confirmed preview button should be disabled"
  );
  CurrentGameManager.getCurrentGame().reset();
});
