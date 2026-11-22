import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { EventService, eventService } from "../../src/logic/EventService";
import EventCommand from "../../src/commands/EventCommand";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";

type Draft = {
  id: string;
  guildId: string;
  title: string;
  state: string;
  openedAt: Date | null;
  revision: number;
};

function mockDatabase(draft: Draft, signups = 0, currentEventId?: string) {
  let removed = false;
  let race = false;
  const db: any = {
    standaloneEvent: {
      findFirst: async ({ where }: any) =>
        !removed && draft.id === where.id && draft.guildId === where.guildId
          ? { ...draft }
          : null,
      updateMany: async ({ where }: any) => {
        if (removed || draft.revision !== where.revision) return { count: 0 };
        draft.revision++;
        return { count: 1 };
      },
      deleteMany: async ({ where }: any) => {
        if (
          race ||
          removed ||
          draft.id !== where.id ||
          draft.guildId !== where.guildId ||
          draft.state !== where.state ||
          draft.openedAt !== where.openedAt ||
          draft.revision !== where.revision
        )
          return { count: 0 };
        removed = true;
        return { count: 1 };
      },
    },
    eventGuildState: {
      findUnique: async () => ({ currentEventId }),
    },
    eventSignup: { count: async () => signups },
    $transaction: async (run: any) => run(db),
  };
  return {
    db,
    wasRemoved: () => removed,
    simulateRace: () => {
      race = true;
    },
  };
}

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  id: "draft-id",
  guildId: "guild",
  title: "Test cup",
  state: "DRAFT",
  openedAt: null,
  revision: 0,
  ...overrides,
});

async function rejectDelete(
  event: Draft,
  signups = 0,
  currentEventId?: string,
  guildId = "guild"
): Promise<void> {
  const db = mockDatabase(event, signups, currentEventId);
  let blocked = false;
  try {
    await new EventService(db.db).deleteDraft(guildId, event.id);
  } catch {
    blocked = true;
  }
  assert(blocked, "invalid deletion must be rejected");
  assert(!db.wasRemoved(), "blocked event must remain stored");
}

test("event deletion permanently removes only an unopened same-guild draft", async () => {
  const db = mockDatabase(draft());
  const result = await new EventService(db.db).deleteDraft("guild", "draft-id");
  assertEqual(result.id, "draft-id", "correct draft deleted");
  assert(db.wasRemoved(), "draft record removed");
  await rejectDelete(draft({ state: "OPEN", openedAt: new Date() }));
  await rejectDelete(draft({ state: "CLOSED", openedAt: new Date() }));
  await rejectDelete(draft({ state: "FINISHED", openedAt: new Date() }));
  await rejectDelete(draft({ state: "DRAFT", openedAt: new Date() }));
  await rejectDelete(draft(), 1);
  await rejectDelete(draft(), 0, "draft-id");
  await rejectDelete(draft(), 0, undefined, "other-guild");

  const raced = mockDatabase(draft());
  raced.simulateRace();
  let rejected = false;
  try {
    await new EventService(raced.db).deleteDraft("guild", "draft-id");
  } catch {
    rejected = true;
  }
  assert(rejected && !raced.wasRemoved(), "changed drafts cannot be deleted");
});

test("event delete requires a selected event and a user-bound confirmation", async () => {
  const originalGet = eventService.get;
  const originalDelete = eventService.deleteDraft;
  const originalAuth = PermissionsUtil.isUserAuthorised;
  const originalHasRole = PermissionsUtil.hasRole;
  let deleted = 0;
  let canManage = true;
  const event = draft();
  eventService.get = async () => event as any;
  eventService.deleteDraft = async () => {
    deleted++;
    return event as any;
  };
  PermissionsUtil.isUserAuthorised = async () => true;
  PermissionsUtil.hasRole = () => canManage;

  const command = new EventCommand();
  function slash() {
    const calls: any[] = [];
    return {
      guildId: "guild",
      user: { id: "organiser" },
      options: {
        getSubcommand: () => "delete",
        getString: () => "draft-id",
      },
      deferReply: async (options: any) => calls.push(["deferReply", options]),
      editReply: async (options: any) => calls.push(["editReply", options]),
      calls,
    } as any;
  }
  function button(id: string, user = "organiser", guildId = "guild") {
    const calls: any[] = [];
    return {
      customId: id,
      user: { id: user },
      guildId,
      guild: {
        members: {
          fetch: async () => ({ roles: { cache: new Map() } }),
        },
      },
      reply: async (payload: any) => calls.push(["reply", payload]),
      update: async (payload: any) => calls.push(["update", payload]),
      deferUpdate: async () => calls.push(["deferUpdate", null]),
      editReply: async (payload: any) => calls.push(["editReply", payload]),
      calls,
    } as any;
  }

  try {
    const deleteSub = (command.data.toJSON() as any).options.find(
      (option: any) => option.name === "delete"
    );
    assert(
      deleteSub.options.some(
        (option: any) => option.name === "event" && option.required
      ),
      "draft event ID is required"
    );
    assert(
      command.buttonIds.includes("event_delete_confirm:"),
      "buttons are dispatched to the event command"
    );

    const first = slash();
    await command.execute(first);
    assert(first.calls[0][1].flags, "prompt is ephemeral");
    const prompt = first.calls[1][1];
    assert(
      prompt.content.includes("Test cup") &&
        prompt.content.includes("draft-id"),
      "prompt identifies the draft"
    );
    const buttons = prompt.components[0].toJSON().components;
    const confirmId = buttons[0].custom_id;
    const cancelId = buttons[1].custom_id;

    await command.handleButtonPress(button(confirmId, "intruder"));
    await command.handleButtonPress(
      button(confirmId, "organiser", "other-guild")
    );
    assertEqual(deleted, 0, "foreign users and guilds cannot delete");

    const cancel = button(cancelId);
    await command.handleButtonPress(cancel);
    assertEqual(deleted, 0, "cancelling does not delete");
    await command.handleButtonPress(button(confirmId));
    assertEqual(deleted, 0, "cancelled confirmation cannot be reused");

    const second = slash();
    await command.execute(second);
    const id =
      second.calls[1][1].components[0].toJSON().components[0].custom_id;
    canManage = false;
    const revoked = button(id);
    await command.handleButtonPress(revoked);
    assertEqual(deleted, 0, "organiser permission is rechecked on click");

    canManage = true;
    const third = slash();
    await command.execute(third);
    const thirdId =
      third.calls[1][1].components[0].toJSON().components[0].custom_id;
    const accepted = button(thirdId);
    await command.handleButtonPress(accepted);
    assertEqual(deleted, 1, "confirmed organiser can delete the draft");
    assert(
      accepted.calls.some(
        ([action, payload]: any) =>
          action === "editReply" &&
          payload.content.includes("deleted permanently")
      ),
      "result confirms deletion"
    );
    await command.handleButtonPress(button(thirdId));
    assertEqual(deleted, 1, "confirm is single-use");

    event.state = "OPEN";
    const opened = slash();
    await command.execute(opened);
    assert(
      opened.calls[1][1].content.includes("Only unopened draft"),
      "opened events never receive delete buttons"
    );
  } finally {
    eventService.get = originalGet;
    eventService.deleteDraft = originalDelete;
    PermissionsUtil.isUserAuthorised = originalAuth;
    PermissionsUtil.hasRole = originalHasRole;
  }
});
