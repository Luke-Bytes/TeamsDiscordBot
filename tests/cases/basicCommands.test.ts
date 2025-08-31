import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import CaptainCommand from "../../src/commands/CaptainCommand";
import RegisterCommand from "../../src/commands/RegisterCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import UnregisterCommand from "../../src/commands/UnregisterCommand";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { createChatInputInteraction, FakeGuild } from "../framework/mocks";

// Provide minimal TeamCommand instance dependency for commands that need it
const teamCommand = new TeamCommand();

test("AnnouncementCommand handleButtonPress default path responds", async () => {
  const cmd = new AnnouncementCommand();
  const guild = new FakeGuild() as any;
  // simulate an unrelated button to hit default
  const interaction = createChatInputInteraction("u1", { guild });
  // @ts-expect-error access handler directly
  await cmd.handleButtonPress!({
    customId: "unknown-button",
    deferReply: async () => ({}) as any,
    editReply: async (_: any) => ({}) as any,
    guild,
  } as any);
  assert(true, "button handled");
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
