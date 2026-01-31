import { test } from "../framework/test";
import { assert } from "../framework/assert";
import WinnerCommand from "../../src/commands/WinnerCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { createChatInputInteraction } from "../framework/mocks";

test("WinnerCommand /winner set replies with confirmation embed", async () => {
  const cmd = new WinnerCommand();
  const originalAuth = PermissionsUtil.isUserAuthorised;
  const originalGet = CurrentGameManager.getCurrentGame;

  const redCap = { ignUsed: "Red_Cap" };
  const blueCap = { ignUsed: "BlueCap" };
  const redPlayers = [
    { ignUsed: "RedOne" },
    { ignUsed: "RedTwo" },
    { ignUsed: "RedThree" },
    { ignUsed: "RedFour" },
  ];
  const bluePlayers = [
    { ignUsed: "BlueOne" },
    { ignUsed: "BlueTwo" },
    { ignUsed: "BlueThree" },
  ];

  const game = {
    getCaptainOfTeam: (team: string) => (team === "RED" ? redCap : blueCap),
    getPlayersOfTeam: (team: string) =>
      team === "RED" ? redPlayers : bluePlayers,
  };

  (PermissionsUtil as any).isUserAuthorised = async () => true;
  (CurrentGameManager as any).getCurrentGame = () => game;

  const interaction = createChatInputInteraction("u7", {
    subcommand: "set",
    strings: { team: "RED" },
  }) as any;
  interaction.fetchReply = async () => ({ id: "msg-1" });

  try {
    await cmd.execute(interaction as any);
    const reply = interaction.replies.find((r: any) => r.type === "reply");
    assert(!!reply, "Should reply with confirmation");
    const embed = reply.payload?.embeds?.[0]?.data;
    assert(!!embed, "Reply should include embed");
    assert(
      /Confirm Winner/i.test(embed.title ?? ""),
      "Embed should have confirm title"
    );
    const fields = embed.fields ?? [];
    const redField = fields.find((f: any) => /Red Players/i.test(f.name));
    const blueField = fields.find((f: any) => /Blue Players/i.test(f.name));
    assert(!!redField && !!blueField, "Embed should include team lists");
    assert(
      String(redField.value).includes("RedOne") &&
        String(redField.value).includes("RedTwo") &&
        String(redField.value).includes("RedThree"),
      "Red list should include first three players"
    );
    assert(
      !String(redField.value).includes("RedFour"),
      "Red list should not include 4th player"
    );
  } finally {
    (PermissionsUtil as any).isUserAuthorised = originalAuth;
    (CurrentGameManager as any).getCurrentGame = originalGet;
  }
});

test("WinnerCommand confirmation button sets winner", async () => {
  const cmd = new WinnerCommand();
  const originalAuth = PermissionsUtil.isUserAuthorised;
  const originalGet = CurrentGameManager.getCurrentGame;

  let setCalled = false;
  let setTeam: string | null = null;

  const game = {
    getCaptainOfTeam: (_team: string) => null,
    getPlayersOfTeam: (_team: string) => [],
    setGameWinner: async (team: string) => {
      setCalled = true;
      setTeam = team;
    },
  };

  (PermissionsUtil as any).isUserAuthorised = async () => true;
  (CurrentGameManager as any).getCurrentGame = () => game;

  const interaction = createChatInputInteraction("u7", {
    subcommand: "set",
    strings: { team: "RED" },
  }) as any;
  interaction.fetchReply = async () => ({ id: "msg-2" });

  const updates: any[] = [];
  const buttonInteraction: any = {
    customId: "winner_confirm_yes",
    message: { id: "msg-2" },
    user: { id: "u7" },
    update: async (payload: any) => {
      updates.push(payload);
    },
    reply: async (_payload: any) => {},
  };

  try {
    await cmd.execute(interaction as any);
    await cmd.handleButtonPress!(buttonInteraction as any);
    assert(setCalled, "Should set winner on confirm");
    assert(setTeam === "RED", "Should set RED as winner");
    assert(
      updates.some((u) => /set to \*\*RED\*\*/i.test(String(u.content))),
      "Should update confirmation message"
    );
  } finally {
    (PermissionsUtil as any).isUserAuthorised = originalAuth;
    (CurrentGameManager as any).getCurrentGame = originalGet;
  }
});
