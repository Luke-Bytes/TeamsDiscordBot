import type { Player, Prisma } from "@prisma/client";
import { MojangAPI } from "../api/MojangAPI";

/** Operation-local evidence, bound to the original profile and match. */
export class RegistrationIdentity {
  // Shared by the live bot's game, event and organiser identity writers.
  // Network verification stays outside this queue. This is process-local;
  // multiple bot processes still require a durable unique ownership constraint.
  private static mutationTail: Promise<unknown> = Promise.resolve();

  static serializeMutation<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(work);
    this.mutationTail = result.catch(() => undefined);
    return result;
  }

  static readonly ownershipConflict = "That Minecraft account is already linked to another member.";

  static ownershipConditions(uuid: string): Prisma.PlayerWhereInput[] {
    return [
      { primaryMinecraftAccount: { equals: uuid, mode: "insensitive" } },
      { minecraftAccounts: { hasSome: [uuid.toLowerCase(), uuid.toUpperCase()] } },
    ];
  }

  private constructor(
    readonly discordSnowflake: string,
    readonly gameToken: string,
    readonly uuid: string,
    readonly ign: string,
    readonly playerId: string | undefined,
    readonly expectedPrimary: string | undefined,
    readonly expectedIGN: string | undefined,
    readonly expectedAccounts: readonly string[]
  ) {}

  static async prepare(
    discordSnowflake: string,
    gameToken: string,
    player: Player | null,
    requested: string,
    preferStored = false
  ): Promise<{ identity: RegistrationIdentity } | { error: string }> {
    // Snapshot before any network awaits; callers must not substitute an
    // arbitrary UUID or change the stored identity beneath this evidence.
    const playerId = player?.id;
    const primary = player?.primaryMinecraftAccount ?? undefined;
    const latest = player?.latestIGN ?? undefined;
    const accounts = Object.freeze([...(player?.minecraftAccounts ?? [])]);
    const knownName = [latest, ...accounts].some(
      (name) => name?.toLowerCase() === requested.toLowerCase()
    );
    let uuid: string | null | undefined;
    if (!requested || (preferStored && primary && knownName)) {
      uuid = primary;
    } else {
      // Registration can claim a new account; a cached name mapping is not
      // fresh proof that the name still belongs to that UUID.
      uuid = await MojangAPI.usernameToUUID(requested, true);
      // Keep the existing outage fallback for already-associated names.
      if (!uuid && !preferStored && knownName && MojangAPI.validUUID(primary))
        uuid = primary;
    }
    if (!MojangAPI.validUUID(uuid)) {
      return {
        error: preferStored
          ? "Unable to verify this Minecraft account. Please retry when the identity service is available."
          : requested
            ? "Could not verify that Minecraft username. Check its spelling or retry when the identity service is available."
            : "Could not verify your Minecraft account. No registration was created.",
      };
    }
    if (primary && primary.toLowerCase() !== uuid.toLowerCase()) {
      return {
        error: `You are already registered with a different Minecraft account (\`${latest}\`). You cannot register with another account.`,
      };
    }

    // Preserve stored casing for existing profiles; compare UUIDs canonically.
    uuid = primary || uuid;
    // Explicit and mass registrations only need a forward lookup here. Resolve
    // the current profile under the roster lock, after membership verification.
    // Implicit registration retains its earlier lookup as an outage fallback.
    const resolved = !requested ? await MojangAPI.uuidToUsername(uuid, true) : null;
    const fallback = requested || latest;
    const ign = resolved ?? fallback;
    if (!ign || !MojangAPI.validateUsername(ign)) {
      return { error: "Unable to retrieve a verified Minecraft username. Please retry later." };
    }
    return {
      identity: Object.freeze(new RegistrationIdentity(
        discordSnowflake, gameToken, uuid, ign, playerId, primary, latest, accounts
      )),
    };
  }
}
