import { test } from "../framework/test";
import { assert } from "../framework/assert";
import CaptainPlanDMManager from "../../src/logic/CaptainPlanDMManager";
import { MessageSafetyUtil } from "../../src/util/MessageSafetyUtil";
import { ButtonInteraction, Client, Message, User } from "discord.js";

function createFakeUser(id: string, dmLog: any[]): User {
  return {
    id,
    bot: false,
    send: async (payload: any) => {
      dmLog.push(payload);
      const message = {
        edit: async (next: any) => {
          dmLog.push({ edit: next });
          return message;
        },
      };
      return message as any;
    },
  } as unknown as User;
}

function createFakeClient(user: User): Client {
  return {
    users: {
      fetch: async () => user,
    },
  } as unknown as Client;
}

function createDM(author: User, content: string, attachmentCount = 0): Message {
  return {
    author: author as User & { bot: boolean },
    guild: null,
    content,
    attachments: { size: attachmentCount },
  } as unknown as Message;
}

function createLoggingUser(
  id: string,
  dmLog: Record<string, { sent: string[]; edits: string[] }>
): User {
  return {
    id,
    bot: false,
    send: async (payload: any) => {
      if (!dmLog[id]) {
        dmLog[id] = { sent: [], edits: [] };
      }
      const content =
        typeof payload === "string" ? payload : (payload?.content as string);
      dmLog[id].sent.push(content);
      const message = {
        edit: async (next: any) => {
          const nextContent =
            typeof next === "string" ? next : (next?.content as string);
          dmLog[id].edits.push(nextContent);
          return message;
        },
      };
      return message as any;
    },
  } as unknown as User;
}

function createDirectoryClient(
  directory: Record<string, User>,
  dmLog: Record<string, { sent: string[]; edits: string[] }>
): Client {
  return {
    users: {
      fetch: async (id: string) => {
        if (!directory[id]) {
          directory[id] = createLoggingUser(id, dmLog);
        }
        return directory[id];
      },
    },
  } as unknown as Client;
}

function createTransport(
  deliveries: Record<string, string[]>
): (memberId: string, content: string) => boolean {
  return (memberId: string, content: string) => {
    if (!deliveries[memberId]) deliveries[memberId] = [];
    deliveries[memberId].push(content);
    return true;
  };
}

test("CaptainPlanDMManager rejects empty or low-effort plans", async () => {
  const dmLog: any[] = [];
  const fakeUser = createFakeUser("cap-1", dmLog);
  const manager = new CaptainPlanDMManager();
  await manager.startForCaptain({
    client: createFakeClient(fakeUser),
    captainId: fakeUser.id,
    team: "RED",
    teamList: "Alice\nBob",
    members: [
      { id: "cap-1", ign: "Alice" },
      { id: "p2", ign: "Bob" },
    ],
  });

  const handled = await manager.handleDM(createDM(fakeUser, "hi"));
  assert(handled, "Manager should handle short message");
  assert(
    manager.hasPendingSession(fakeUser.id),
    "Session should stay in awaitMessage after rejection"
  );
  const feedback = dmLog[dmLog.length - 1];
  assert(
    typeof feedback === "object" &&
      feedback.content.includes("little more detail"),
    "Captain should receive guidance for short plans"
  );
});

test("CaptainPlanDMManager accepts valid plans and sends preview buttons", async () => {
  const dmLog: any[] = [];
  const fakeUser = createFakeUser("cap-2", dmLog);
  const manager = new CaptainPlanDMManager();
  await manager.startForCaptain({
    client: createFakeClient(fakeUser),
    captainId: fakeUser.id,
    team: "BLUE",
    teamList: "Charlie\nDana",
    members: [
      { id: "cap-2", ign: "Charlie" },
      { id: "p3", ign: "Dana" },
    ],
  });

  const message = createDM(
    fakeUser,
    "Push mid, defend nexus, rotate invis on call."
  );
  const handled = await manager.handleDM(message);
  assert(handled, "Manager should handle valid plan");
  assert(
    !manager.hasPendingSession(fakeUser.id),
    "Session should move to confirmation stage"
  );
  assert(
    manager.buttonIds.includes(`plan-confirm:${fakeUser.id}`),
    "Confirm button should be registered"
  );
  const preview = dmLog[dmLog.length - 1];
  assert(
    preview.components?.length === 1,
    "Preview response should include action row"
  );
});

test("MessageSafetyUtil blocks mass mentions and slurs", () => {
  const mentionResult = MessageSafetyUtil.validateCaptainPlanMessage(
    "Focus mid @everyone bring invis pots",
    false
  );
  assert(!mentionResult.valid, "Mass mentions should be blocked");
  const slurResult = MessageSafetyUtil.validateCaptainPlanMessage(
    "our plan insults with slur retard",
    false
  );
  assert(!slurResult.valid, "Slurs should be blocked");
  const attachmentResult = MessageSafetyUtil.validateCaptainPlanMessage(
    "",
    true
  );
  assert(
    attachmentResult.valid,
    "Attachments should bypass length requirement"
  );
});

test("CaptainPlanDMManager confirms once and forwards plan to teammates", async () => {
  const dmLog: Record<string, { sent: string[]; edits: string[] }> = {};
  const deliveries: Record<string, string[]> = {};
  const directory: Record<string, User> = {
    "cap-3": createLoggingUser("cap-3", dmLog),
    p4: createLoggingUser("p4", dmLog),
    p5: createLoggingUser("p5", dmLog),
  };

  const client = createDirectoryClient(directory, dmLog);

  const manager = new CaptainPlanDMManager();
  manager.setTransport(createTransport(deliveries));
  await manager.startForCaptain({
    client,
    captainId: "cap-3",
    team: "RED",
    teamList: "One\nTwo",
    members: [
      { id: "cap-3", ign: "One" },
      { id: "p4", ign: "Two" },
      { id: "p5", ign: "Three" },
    ],
  });

  await manager.handleDM(
    createDM(directory["cap-3"], "Hold mid and rotate invis together.", 1)
  );

  await manager.__testSendAll("cap-3");
  const firstSendCount = deliveries["p4"]?.length ?? 0;
  assert(
    firstSendCount === 1,
    `Further clicks should not resend the plan (p4 got ${firstSendCount}, log: ${JSON.stringify(deliveries["p4"])})`
  );
});

test("CaptainPlanDMManager prompts for late joiners and can send only to them", async () => {
  const dmLog: Record<string, { sent: string[]; edits: string[] }> = {};
  const deliveries: Record<string, string[]> = {};
  const directory: Record<string, User> = {
    "cap-late": createLoggingUser("cap-late", dmLog),
    p10: createLoggingUser("p10", dmLog),
    "p-late": createLoggingUser("p-late", dmLog),
  };
  const client = createDirectoryClient(directory, dmLog);

  const manager = new CaptainPlanDMManager();
  manager.setTransport(createTransport(deliveries));
  await manager.startForCaptain({
    client,
    captainId: "cap-late",
    team: "BLUE",
    teamList: "Alpha\nBeta",
    members: [
      { id: "cap-late", ign: "Alpha" },
      { id: "p10", ign: "Beta" },
    ],
  });

  await manager.handleDM(
    createDM(directory["cap-late"], "Initial coordinated push plan.", 1)
  );
  const initialConfirm = {
    customId: "plan-confirm:cap-late",
    client,
    deferUpdate: async () => {},
    editReply: async () => {},
  } as unknown as ButtonInteraction;
  await manager.handleButtonPress(initialConfirm);

  await manager.handleRosterUpdate({
    captainId: "cap-late",
    team: "BLUE",
    members: [
      { id: "cap-late", ign: "Alpha" },
      { id: "p10", ign: "Beta" },
      { id: "p-late", ign: "Gamma" },
    ],
    newJoiners: [{ id: "p-late", ign: "Gamma" }],
    client,
  });

  assert(
    manager.hasPendingSession("cap-late"),
    "Captain should be prompted for a late joiner plan"
  );
  const latePrompt = dmLog["cap-late"]?.sent.find((m) =>
    m.includes("New teammate")
  );
  assert(
    !!latePrompt,
    `Captain should receive late joiner prompt (log: ${JSON.stringify(dmLog["cap-late"])})`
  );

  await manager.handleDM(
    createDM(directory["cap-late"], "Updated plan for new member", 1)
  );
  await manager.__testSendLate("cap-late");

  const lateCount = deliveries["p-late"]?.length ?? 0;
  const existingCount = deliveries["p10"]?.length ?? 0;
  assert(
    lateCount === 1,
    `Late joiner should receive the plan once (got ${lateCount}, log: ${JSON.stringify(deliveries["p-late"])})`
  );
  assert(
    existingCount === 1,
    `Existing teammate should keep original send only (got ${existingCount}, log: ${JSON.stringify(deliveries["p10"])})`
  );
});

test("CaptainPlanDMManager coalesces multiple late joiners into one prompt", async () => {
  const dmLog: Record<string, { sent: string[]; edits: string[] }> = {};
  const deliveries: Record<string, string[]> = {};
  const directory: Record<string, User> = {
    "cap-multi": createLoggingUser("cap-multi", dmLog),
    p20: createLoggingUser("p20", dmLog),
    "p-late-a": createLoggingUser("p-late-a", dmLog),
    "p-late-b": createLoggingUser("p-late-b", dmLog),
  };
  const client = createDirectoryClient(directory, dmLog);

  const manager = new CaptainPlanDMManager();
  manager.setTransport(createTransport(deliveries));
  await manager.startForCaptain({
    client,
    captainId: "cap-multi",
    team: "RED",
    teamList: "Alpha\nBeta",
    members: [
      { id: "cap-multi", ign: "Alpha" },
      { id: "p20", ign: "Beta" },
    ],
  });
  await manager.handleDM(
    createDM(
      directory["cap-multi"],
      "Initial coordinated plan for everyone.",
      1
    )
  );
  await manager.__testSendAll("cap-multi");

  await manager.handleRosterUpdate({
    captainId: "cap-multi",
    team: "RED",
    members: [
      { id: "cap-multi", ign: "Alpha" },
      { id: "p20", ign: "Beta" },
      { id: "p-late-a", ign: "Gamma" },
    ],
    newJoiners: [{ id: "p-late-a", ign: "Gamma" }],
    client,
  });

  await manager.handleRosterUpdate({
    captainId: "cap-multi",
    team: "RED",
    members: [
      { id: "cap-multi", ign: "Alpha" },
      { id: "p20", ign: "Beta" },
      { id: "p-late-a", ign: "Gamma" },
      { id: "p-late-b", ign: "Delta" },
    ],
    newJoiners: [{ id: "p-late-b", ign: "Delta" }],
    client,
  });

  await manager.handleDM(createDM(directory["cap-multi"], "Late plan.", 1));
  await manager.__testSendLate("cap-multi");

  assert(
    (deliveries["p-late-a"]?.length ?? 0) === 1 &&
      (deliveries["p-late-b"]?.length ?? 0) === 1,
    `Both late joiners should receive the plan once (logs A:${JSON.stringify(deliveries["p-late-a"])} B:${JSON.stringify(deliveries["p-late-b"])})`
  );
  assert(
    (deliveries["p20"]?.length ?? 0) === 1,
    "Existing teammates should only have the initial send"
  );
});
