import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import GameCommand, {
  GAME_START_BUTTON_ID,
} from "../../src/commands/GameCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import { GameInstance } from "../../src/database/GameInstance";
import { ConfigManager } from "../../src/ConfigManager";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";

function makeButtonInteraction(guild: any, userId: string) {
  const replies: any[] = [];
  return {
    customId: GAME_START_BUTTON_ID,
    guild,
    user: { id: userId },
    client: { users: {} },
    replies,
    reply: async (payload: any) => replies.push({ type: "reply", payload }),
    update: async (payload: any) => replies.push({ type: "update", payload }),
    editReply: async (payload: any) =>
      replies.push({ type: "editReply", payload }),
  } as any;
}

test("team finalization publishes one shared start-game prompt", async () => {
  const command = new TeamCommand();
  const followUps: any[] = [];
  const session = {
    state: "inProgress",
    getState() {
      return this.state;
    },
    async handleInteraction() {
      this.state = "finalized";
    },
  } as any;
  command.teamPickingSession = session;
  const interaction = {
    guild: {},
    followUp: async (payload: any) => followUps.push(payload),
  } as any;

  await command.handleButtonPress(interaction);
  await command.handleButtonPress(interaction);

  assertEqual(followUps.length, 1, "Prompt should be published once");
  assert(
    followUps[0].components[0].components[0].data.custom_id ===
      GAME_START_BUTTON_ID,
    "Prompt should contain the stable start button"
  );
  assert(
    followUps[0].components[0].components[0].data.style === 3,
    "Start button should be green"
  );
});

test("start-game button denies non-organisers without changing its prompt", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const guild = new FakeGuild() as any;
  guild.addMember(new FakeGuildMember("player"));
  const interaction = makeButtonInteraction(guild, "player");
  const command = new GameCommand();
  let workflowCalls = 0;
  (command as any).runGameStartWorkflow = async () => {
    workflowCalls += 1;
  };

  await command.handleButtonPress(interaction);

  assertEqual(workflowCalls, 0, "Denied click should not start the workflow");
  assertEqual(game.getGameStartStatus(), "idle", "Guard should remain idle");
  assertEqual(interaction.replies.length, 1, "Denial should reply once");
  assert(
    interaction.replies[0].type === "reply" &&
      interaction.replies[0].payload.flags !== undefined,
    "Denial should be ephemeral"
  );
});

test("simultaneous slash and button starts execute the workflow once", async () => {
  const originalAuth = PermissionsUtil.isUserAuthorised;
  (PermissionsUtil as any).isUserAuthorised = async () => true;
  const game = GameInstance.getInstance();
  game.reset();
  const guild = new FakeGuild() as any;
  const organiserId = "organiser";
  guild.addMember(
    new FakeGuildMember(organiserId, [
      ConfigManager.getConfig().roles.organiserRole,
    ])
  );
  const command = new GameCommand();
  let workflowCalls = 0;
  let finishWorkflow!: () => void;
  const workflowWait = new Promise<void>((resolve) => {
    finishWorkflow = resolve;
  });
  (command as any).runGameStartWorkflow = async () => {
    workflowCalls += 1;
    await workflowWait;
  };
  const slash = createChatInputInteraction(organiserId, {
    guild,
    subcommand: "start",
  }) as any;
  slash.client = { users: {} };
  const button = makeButtonInteraction(guild, organiserId);

  try {
    const slashPromise = command.execute(slash);
    const buttonPromise = command.handleButtonPress(button);
    await Promise.resolve();
    await Promise.resolve();
    assertEqual(workflowCalls, 1, "Only one attempt should enter the workflow");
    assertEqual(
      game.getGameStartStatus(),
      "starting",
      "First attempt should hold the guard"
    );
    finishWorkflow();
    await Promise.all([slashPromise, buttonPromise]);
    assertEqual(game.getGameStartStatus(), "started", "Start should complete");

    const later = makeButtonInteraction(guild, organiserId);
    await command.handleButtonPress(later);
    assertEqual(workflowCalls, 1, "Later click should not rerun workflow");
    assert(
      String(later.replies[0]?.payload?.content).includes(
        "already been started"
      ),
      "Later click should explain that the game already started"
    );
  } finally {
    (PermissionsUtil as any).isUserAuthorised = originalAuth;
    game.reset();
  }
});

test("failed button start releases guard and restores retry button", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const guild = new FakeGuild() as any;
  const organiserId = "organiser";
  guild.addMember(
    new FakeGuildMember(organiserId, [
      ConfigManager.getConfig().roles.organiserRole,
    ])
  );
  const command = new GameCommand();
  (command as any).runGameStartWorkflow = async () => {
    throw new Error("expected test failure");
  };
  const interaction = makeButtonInteraction(guild, organiserId);

  await command.handleButtonPress(interaction);

  assertEqual(
    game.getGameStartStatus(),
    "idle",
    "Failure should release guard"
  );
  const restored = interaction.replies.find(
    (entry: any) => entry.type === "editReply"
  )?.payload;
  assert(
    restored?.components?.[0]?.components?.[0]?.data?.custom_id ===
      GAME_START_BUTTON_ID,
    "Failure should restore the retry button"
  );

  (command as any).runGameStartWorkflow = async () => {};
  const retry = makeButtonInteraction(guild, organiserId);
  await command.handleButtonPress(retry);
  assertEqual(
    game.getGameStartStatus(),
    "started",
    "Restored button should allow a successful retry"
  );
  game.reset();
});

test("reset and confirmed announcement return game-start guard to idle", () => {
  const game = GameInstance.getInstance();
  game.reset();
  assertEqual(game.tryBeginGameStart(), "acquired", "Start should acquire");
  game.completeGameStart();
  game.beginConfirmedAnnouncement();
  assertEqual(
    game.getGameStartStatus(),
    "idle",
    "New announcement should reset start guard"
  );
  assertEqual(game.tryBeginGameStart(), "acquired", "Start should reacquire");
  game.completeGameStart();
  game.reset();
  assertEqual(
    game.getGameStartStatus(),
    "idle",
    "Full reset should clear guard"
  );
});
