export type MinecraftNameLookup =
  | { status: "found"; uuid: string }
  | { status: "notFound" }
  | { status: "unavailable" }
  | { status: "invalid" };

/**
 * Mojang UUIDs are stored as 32 lowercase hexadecimal characters (without dashes).
 * A username, failed HTTP request or malformed third-party response is never a UUID.
 */
export class MojangAPI {
  private static readonly timeoutMs = 4500;
  private static readonly successfulNames = new Map<string, { id: string; until: number }>();
  private static readonly pendingNames = new Map<string, Promise<MinecraftNameLookup>>();
  private static readonly pendingProfiles = new Map<string, Promise<string | null>>();

  private static async discard(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // A closed/aborted response needs no further cleanup.
    }
  }

  public static validUUID(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
  }

  private static async request(url: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if ((response.status === 429 || response.status >= 500) && attempt === 0) {
          const retryAfter = response.headers?.get("retry-after");
          const seconds = retryAfter ? Number(retryAfter) : NaN;
          const until = retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
          const wait = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(until) ? until : 300;
          await this.discard(response);
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(2000, wait))));
          continue;
        }
        return response;
      } catch (error) {
        if (attempt === 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("Unreachable external API retry state");
  }

  private static async lookupUUID(url: string, source: string): Promise<{ id: string | null; unavailable: boolean }> {
    try {
      const response = await this.request(url);
      if (response.status === 404) {
        await this.discard(response);
        return { id: null, unavailable: false };
      }
      if (!response.ok) {
        await this.discard(response);
        console.warn(`${source} UUID lookup unavailable: HTTP ${response.status}`);
        return { id: null, unavailable: true };
      }
      const data: unknown = await response.json();
      const id = (data as { id?: unknown } | null)?.id;
      if (!this.validUUID(id)) {
        console.error(`${source} returned a malformed UUID response`);
        return { id: null, unavailable: true };
      }
      return { id: id.toLowerCase(), unavailable: false };
    } catch (error) {
      console.warn(`${source} UUID lookup failed:`, error);
      return { id: null, unavailable: true };
    }
  }

  /**
   * Use for diagnostic verification: a 404 from Mojang means not found;
   * transport failures/429/5xx stay "unavailable", even if a third-party
   * fallback also returns no UUID. Do not infer absence from an outage.
   */
  public static async lookupUsername(username: string, fresh = false): Promise<MinecraftNameLookup> {
    if (!this.validateUsername(username)) return { status: "invalid" };
    const key = username.toLowerCase();
    const cached = this.successfulNames.get(key);
    if (!fresh && cached && cached.until > Date.now()) return { status: "found", uuid: cached.id };
    if (cached || fresh) this.successfulNames.delete(key);
    const pending = this.pendingNames.get(key);
    if (!fresh && pending) return pending;

    // Fresh lookups always start new work. Older requests must not repopulate
    // the cache after a fresh lookup has superseded them.
    const work = this.lookupUsernameUncached(username).then((result) => {
      if (this.pendingNames.get(key) === work && result.status === "found") {
        this.cache(key, result.uuid);
      }
      return result;
    }).finally(() => {
      if (this.pendingNames.get(key) === work) this.pendingNames.delete(key);
    });
    this.pendingNames.set(key, work);
    return work;
  }

  private static async lookupUsernameUncached(username: string): Promise<MinecraftNameLookup> {
    const primary = await this.lookupUUID(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`,
      "Mojang"
    );
    if (primary.id) {
      return { status: "found", uuid: primary.id };
    }
    if (!primary.unavailable) return { status: "notFound" };

    const fallback = await this.lookupUUID(
      `https://api.gapple.pw/cors/username/${encodeURIComponent(username)}`,
      "Gapple"
    );
    if (fallback.id) {
      return { status: "found", uuid: fallback.id };
    }
    return { status: "unavailable" };
  }

  /** Backwards-compatible registration API: never return unverified UUIDs. */
  public static async usernameToUUID(username: string, fresh = false): Promise<string | null> {
    const result = await this.lookupUsername(username, fresh);
    return result.status === "found" ? result.uuid : null;
  }

  private static cache(key: string, id: string): void {
    const now = Date.now();
    this.successfulNames.delete(key);
    if (this.successfulNames.size >= 500) {
      for (const [name, entry] of this.successfulNames) {
        if (entry.until <= now) this.successfulNames.delete(name);
      }
      if (this.successfulNames.size >= 500) {
        const oldest = this.successfulNames.keys().next().value;
        if (oldest !== undefined) this.successfulNames.delete(oldest);
      }
    }
    this.successfulNames.set(key, { id, until: Date.now() + 5 * 60_000 });
  }

  public static async uuidToUsername(uuid: string, verifyUUID = false): Promise<string | null> {
    if (!this.validUUID(uuid)) return null;
    // Strict identity verification (including name history) never joins an
    // ordinary in-flight profile lookup.
    if (verifyUUID) return this.lookupProfile(uuid, true);
    const key = uuid.toLowerCase();
    const pending = this.pendingProfiles.get(key);
    if (pending) return pending;
    const work = this.lookupProfile(uuid, false).finally(() => this.pendingProfiles.delete(key));
    this.pendingProfiles.set(key, work);
    return work;
  }

  private static async lookupProfile(uuid: string, verifyUUID: boolean): Promise<string | null> {
    for (const [source, url] of [
      ["Mojang", `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`],
      ["Gapple", `https://api.gapple.pw/cors/profile/${uuid}`],
    ]) {
      try {
        const response = await this.request(url);
        if (response.status === 404 && source === "Mojang") {
          await this.discard(response);
          continue;
        }
        if (!response.ok) {
          await this.discard(response);
          console.warn(`${source} username lookup unavailable: HTTP ${response.status}`);
          continue;
        }
        const data: unknown = await response.json();
        const profile = data as { name?: unknown; id?: unknown } | null;
        const name = profile?.name;
        if (verifyUUID && (!this.validUUID(profile?.id) || profile.id.toLowerCase() !== uuid.toLowerCase())) continue;
        if (typeof name === "string" && this.validateUsername(name)) return name;
        console.error(`${source} returned an invalid username`);
      } catch (error) {
        console.warn(`${source} username lookup failed:`, error);
      }
    }
    return null;
  }

  public static validateUsername(username: string): boolean {
    return /^[a-zA-Z0-9_]{1,16}$/.test(username);
  }
}
