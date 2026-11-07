import { Collection } from "discord.js";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { prismaClient } from "../../src/database/prismaClient";
import { SeasonService } from "../../src/database/SeasonService";
import { Channels } from "../../src/Channels";

async function withAnnouncements(run: (fixture: any) => Promise<void>) {
  const announcements = prismaClient.seasonAnnouncement as any;
  const originals = ["findMany", "findFirst", "upsert", "update"].map((key) => {
    const original = announcements[key];
    return () => {
      announcements[key] = original;
    };
  });
  const originalSeasons = prismaClient.season.findMany;
  const originalChannel = Channels.announcements;
  const blocks: any[] = [];
  const messages = new Collection<string, any>();
  const sent: any[] = [];
  let failDeliveryRecord = false;
  try {
    announcements.findMany = async () =>
      blocks.filter((block) => block.state === "PENDING");
    announcements.findFirst = async ({ where }: any) =>
      blocks.find(
        (block) =>
          block.discordMessageId === where.discordMessageId &&
          block.id !== where.id.not
      ) ?? null;
    announcements.upsert = async ({ create }: any) => {
      const block = {
        id: `block-${blocks.length}`,
        state: "PENDING",
        createdAt: new Date("2026-01-01"),
        ...create,
      };
      blocks.push(block);
      return block;
    };
    announcements.update = async ({ where, data }: any) => {
      if (data.state === "DELIVERED" && failDeliveryRecord) {
        failDeliveryRecord = false;
        throw new Error(
          "simulated database failure after Discord accepted the message"
        );
      }
      const block = blocks.find((entry) => entry.id === where.id);
      Object.assign(block, data);
      return block;
    };
    (prismaClient.season as any).findMany = async () => [];
    Channels.announcements = {
      client: { user: { id: "bot" } },
      messages: {
        fetch: async (query: any) =>
          typeof query === "string" ? messages.get(query) : messages,
      },
      send: async (payload: any) => {
        sent.push(payload);
        const message = {
          id: `message-${sent.length}`,
          content: payload.content,
          author: { id: "bot" },
          createdTimestamp: Date.now(),
        };
        messages.set(message.id, message);
        return message;
      },
    } as any;
    await run({
      blocks,
      messages,
      sent,
      failNextDeliveryRecord: () => {
        failDeliveryRecord = true;
      },
    });
  } finally {
    originals.forEach((restore) => restore());
    prismaClient.season.findMany = originalSeasons;
    Channels.announcements = originalChannel;
  }
}

test("season announcements keep tracking out of visible content, including legacy queued blocks", async () => {
  await withAnnouncements(async ({ blocks, sent }) => {
    await (SeasonService as any).queueBlocks("season-6", "RECAP", [
      "## Season 6 Recap\n\n12 games",
    ]);
    assert(
      !blocks[0].content.includes("〔season:"),
      "New queued content has no marker prefix"
    );
    blocks[0].content = `${blocks[0].marker}\n${blocks[0].content}`;
    await SeasonService.deliverPendingAnnouncements();
    assert(
      sent.length === 1 && sent[0].content === "## Season 6 Recap\n\n12 games",
      "Legacy queued prefixes are stripped before sending"
    );
    assert(
      sent[0].nonce.length <= 25 && sent[0].enforceNonce,
      "Retries use an internal Discord nonce"
    );
    assert(
      blocks[0].discordMessageId === "message-1" &&
        blocks[0].state === "DELIVERED",
      "Delivery remains recorded"
    );
  });
});

test("season announcement retry recognises a clean message after its database acknowledgement fails", async () => {
  await withAnnouncements(async ({ blocks, sent, failNextDeliveryRecord }) => {
    await (SeasonService as any).queueBlocks("season-6", "RECAP", [
      "## Season 6 Recap",
    ]);
    failNextDeliveryRecord();
    await SeasonService.deliverPendingAnnouncements();
    assert(
      blocks[0].state === "PENDING",
      "Failed acknowledgement leaves a retry pending"
    );
    await SeasonService.deliverPendingAnnouncements();
    assert(
      sent.length === 1 && blocks[0].state === "DELIVERED",
      "Retry recovers the original message without posting twice"
    );
  });
});

test("season announcement recovery accepts old markers and ignores other authors or older identical content", async () => {
  await withAnnouncements(async ({ blocks, messages, sent }) => {
    await (SeasonService as any).queueBlocks("season-6", "RECAP", ["Recap"]);
    messages.set("old", {
      id: "old",
      author: { id: "bot" },
      content: `${blocks[0].marker}\nRecap`,
      createdTimestamp: Date.now(),
    });
    await SeasonService.deliverPendingAnnouncements();
    assert(
      sent.length === 0 && blocks[0].discordMessageId === "old",
      "Already published legacy message is recognised"
    );
    await (SeasonService as any).queueBlocks("season-7", "RECAP", [
      "New recap",
    ]);
    messages.set("user", {
      id: "user",
      author: { id: "user" },
      content: "New recap",
      createdTimestamp: Date.now(),
    });
    messages.set("earlier", {
      id: "earlier",
      author: { id: "bot" },
      content: "New recap",
      createdTimestamp: 0,
    });
    await SeasonService.deliverPendingAnnouncements();
    assert(
      sent.length === 1 && blocks[1].discordMessageId === "message-1",
      "Unrelated messages do not suppress delivery"
    );
  });
});

test("identical season announcement blocks each get their own message", async () => {
  await withAnnouncements(async ({ blocks, sent }) => {
    await (SeasonService as any).queueBlocks("season-6", "TITLES", [
      "No new titles",
    ]);
    await (SeasonService as any).queueBlocks("season-7", "TITLES", [
      "No new titles",
    ]);
    await SeasonService.deliverPendingAnnouncements();
    assert(
      sent.length === 2 && sent[0].nonce !== sent[1].nonce,
      "Identical content from different seasons is not mistaken for a retry"
    );
    assert(
      blocks.every((block: any) => block.state === "DELIVERED"),
      "Both announcements are delivered"
    );
  });
});
