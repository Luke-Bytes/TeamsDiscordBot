#!/usr/bin/env ts-node
import { prismaClient } from "../src/database/prismaClient";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// npx tsx scripts/normalize-host-organiser.ts --field organiser --target "Krackdown9" --aliases "KD, Krackdown, KD9"

type FieldKey = "organiser" | "host";

type Args = {
  field: "organiser" | "host" | "both";
  target: string;
  aliases: string[];
};

const rl = createInterface({ input, output });

const parseArgs = (): Args => {
  const raw = process.argv.slice(2);
  const get = (name: string) => {
    const idx = raw.findIndex((v) => v === `--${name}`);
    if (idx === -1) return undefined;
    return raw[idx + 1];
  };

  const field = (get("field") ?? "both") as Args["field"];
  const target = get("target");
  const aliasesRaw = get("aliases");

  if (!target || !aliasesRaw) {
    throw new Error(
      "Usage: --field organiser|host|both --target \"Name\" --aliases \"a,b,c\""
    );
  }

  const aliases = aliasesRaw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  return { field, target: target.trim(), aliases };
};

const ask = async (q: string) => (await rl.question(q)).trim();

const normalize = (value: string) => value.trim().toLowerCase();

async function run() {
  const args = parseArgs();
  const fields: FieldKey[] =
    args.field === "both" ? ["organiser", "host"] : [args.field];

  const aliasSet = new Set(args.aliases.map(normalize));
  const target = args.target.trim();

  const games = await prismaClient.game.findMany({
    select: { id: true, organiser: true, host: true },
  });

  const updates: Record<FieldKey, string[]> = {
    organiser: [],
    host: [],
  };
  const counts: Record<FieldKey, Map<string, number>> = {
    organiser: new Map(),
    host: new Map(),
  };

  for (const game of games) {
    for (const field of fields) {
      const value = game[field];
      if (!value) continue;
      const key = normalize(value);
      if (!aliasSet.has(key)) continue;
      updates[field].push(game.id);
      counts[field].set(value, (counts[field].get(value) ?? 0) + 1);
    }
  }

  for (const field of fields) {
    const total = updates[field].length;
    console.log(
      `[Normalize] ${field}: ${total} game(s) will be updated to "${target}".`
    );
    if (total) {
      const entries = Array.from(counts[field].entries()).sort(
        (a, b) => b[1] - a[1]
      );
      console.log(
        `[Normalize] ${field} matched values: ${entries
          .map(([val, count]) => `${val} (${count})`)
          .join(", ")}`
      );
    }
  }

  if (fields.every((field) => updates[field].length === 0)) {
    console.log("No matches found. Exiting.");
    return;
  }

  const confirm = (await ask("Apply these changes? (yes/no): ")).toLowerCase();
  if (confirm !== "yes") {
    console.log("Aborted.");
    return;
  }

  for (const field of fields) {
    const ids = updates[field];
    if (!ids.length) continue;
    const result = await prismaClient.game.updateMany({
      where: { id: { in: ids } },
      data: { [field]: target },
    });
    console.log(
      `[Normalize] ${field}: updated ${result.count} game(s) to "${target}".`
    );
  }
}

run()
  .catch((error) => {
    console.error("Failed to normalize host/organiser:", error);
  })
  .finally(async () => {
    await prismaClient.$disconnect();
    rl.close();
  });
