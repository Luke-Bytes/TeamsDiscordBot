import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import SignCommand from "../../src/commands/SignCommand";
import { ConfigManager } from "../../src/ConfigManager";
import { eventService } from "../../src/logic/EventService";

test("sign-up publishes only the committed status and keeps form answers private", async () => {
  const config = ConfigManager.getConfig();
  const originalChannel = config.channels.eventSignUps;
  const originalRole = config.roles.eventParticipantRole;
  const originalGet = eventService.get;
  const originalSignup = eventService.signup;
  config.channels.eventSignUps = "event-channel";
  config.roles.eventParticipantRole = undefined;
  const event = {
    id: "event",
    title: "Tournament",
    state: "OPEN",
    formRevision: 1,
    questions: [],
    terms: "Tournament rules",
  };
  eventService.get = async () => event as any;
  let submitted = 0;
  eventService.signup = async () => {
    submitted++;
    return { status: "RESERVE" } as any;
  };
  try {
    const command = new SignCommand();
    const id = "private-session";
    (command as any).sessions.set(id, {
      id,
      guildId: "guild",
      channelId: "event-channel",
      userId: "user",
      event,
      questions: [
        { id: "q", label: "Private detail", type: "LONG_TEXT", required: true },
      ],
      answers: { q: "sensitive private answer" },
      username: "ExampleIGN",
      index: 1,
      reviewPage: 0,
      expires: Date.now() + 60_000,
      editing: false,
      reserveApplication: false,
    });
    const calls: Array<[string, any]> = [];
    const interaction: any = {
      customId: `sign_submit:${id}`,
      user: { id: "user" },
      guildId: "guild",
      channelId: "event-channel",
      client: {},
      deferUpdate: async () => calls.push(["deferUpdate", null]),
      editReply: async (payload: any) => calls.push(["editReply", payload]),
      followUp: async (payload: any) => calls.push(["followUp", payload]),
      reply: async (payload: any) => calls.push(["reply", payload]),
    };
    await command.handleButtonPress(interaction);
    assertEqual(submitted, 1, "form submits once");
    const saved = calls.find(([action]) => action === "editReply")?.[1];
    const publicResult = calls.find(([action]) => action === "followUp")?.[1];
    assert(saved?.content.includes("RESERVE"), "private form confirms result");
    assert(
      publicResult && !publicResult.flags,
      "successful signup is publicly visible"
    );
    assert(
      publicResult.content.includes("RESERVE"),
      "public message includes status"
    );
    assert(
      publicResult.content.includes("user"),
      "public message identifies applicant"
    );
    assert(
      !publicResult.content.includes("sensitive private answer"),
      "answers never appear in public"
    );
    assert(
      !publicResult.content.includes("ExampleIGN"),
      "public notice does not expose account details"
    );
  } finally {
    config.channels.eventSignUps = originalChannel;
    config.roles.eventParticipantRole = originalRole;
    eventService.get = originalGet;
    eventService.signup = originalSignup;
  }
});

test("/sign view replies publicly without exposing saved answers", async () => {
  const config = ConfigManager.getConfig();
  const originalChannel = config.channels.eventSignUps;
  const originalGet = eventService.get;
  const originalRoster = eventService.roster;
  config.channels.eventSignUps = "event-channel";
  eventService.get = async () =>
    ({
      id: "event",
      title: "Tournament",
      state: "OPEN",
      questions: [
        { id: "q", label: "Private detail", type: "LONG_TEXT", required: true },
      ],
    }) as any;
  eventService.roster = async () => [
    {
      id: "signup",
      eventId: "event",
      discordUserId: "user",
      status: "CONFIRMED",
      minecraftUsername: "ExampleIGN",
      answers: { q: "sensitive private answer" },
    } as any,
  ];
  try {
    const calls: Array<[string, any]> = [];
    const interaction: any = {
      guildId: "guild",
      channelId: "event-channel",
      user: { id: "user" },
      options: { getSubcommand: () => "view" },
      deferReply: async (payload?: any) => calls.push(["deferReply", payload]),
      editReply: async (payload: any) => calls.push(["editReply", payload]),
      followUp: async (payload: any) => calls.push(["followUp", payload]),
    };
    await new SignCommand().execute(interaction);
    const acknowledgement = calls.find(([action]) => action === "deferReply");
    const publicReply = calls.find(([action]) => action === "editReply")?.[1];
    const privateReply = calls.find(([action]) => action === "followUp")?.[1];
    assert(!acknowledgement?.[1]?.flags, "initial reply is public");
    assert(
      !publicReply.content.includes("sensitive private answer"),
      "answers are not public"
    );
    assert(
      privateReply.flags,
      "saved answers are shown only in ephemeral follow-up"
    );
    assert(
      privateReply.content.includes("sensitive private answer"),
      "applicant sees saved answers"
    );
  } finally {
    config.channels.eventSignUps = originalChannel;
    eventService.get = originalGet;
    eventService.roster = originalRoster;
  }
});
