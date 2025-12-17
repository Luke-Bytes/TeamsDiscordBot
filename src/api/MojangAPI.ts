import { UUID } from "mongodb";

export class MojangAPI {
  public static async usernameToUUID(username: string): Promise<string | null> {
    if (!this.validateUsername(username)) {
      console.error("Invalid username format for " + username);
      return null;
    }

    try {
      const response = await fetch(
        encodeURI(`https://api.mojang.com/users/profiles/minecraft/${username}`)
      );

      if (response.status === 200) {
        const data = await response.json();
        return data?.id ?? null;
      } else if (response.status === 404) {
        console.warn(`Username ${username} not found by Mojang API.`);
        return null;
      } else {
        console.error(
          `Unexpected Mojang API error for username ${username}: ${response.status} ${response.statusText}`
        );
        return this.primaryFallbackUsernameToUUID(username);
      }
    } catch (error) {
      console.error("Error fetching UUID from Mojang API:", error);
      return this.primaryFallbackUsernameToUUID(username);
    }
  }

  private static async primaryFallbackUsernameToUUID(
    username: string
  ): Promise<string | null> {
    try {
      const response = await fetch(
        encodeURI(`https://api.gapple.pw/cors/username/${username}`)
      );

      if (response.status === 200) {
        console.info(
          `Successfully validated username ${username} with fallback API`
        );
        const data = await response.json();
        return data?.id ?? null;
      } else if (response.status === 404) {
        console.warn(`Username ${username} not found in fallback API.`);
        return null;
      } else {
        console.error(
          `Unexpected Gapple API error for username ${username}: ${response.status} ${response.statusText}`
        );
        return username;
      }
    } catch (error) {
      console.error(`Error fetching UUID '${UUID}' from Gapple API:`, error);
      return username;
    }
  }

  public static async uuidToUsername(uuid: string): Promise<string | null> {
    if (!uuid || !/^[0-9a-f]{32}$/.test(uuid)) {
      console.error(`Invalid UUID format passed: ${uuid}`);
      return null;
    }

    try {
      const response = await fetch(
        encodeURI(
          `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`
        )
      );

      if (response.ok) {
        const data = await response.json();
        return data?.name ?? null;
      } else {
        console.error(
          `Unexpected Mojang API error for UUID ${uuid}: ${response.status} ${response.statusText}`
        );
        return this.primaryFallbackUUIDToUsername(uuid);
      }
    } catch (error) {
      console.error("Error fetching username from Mojang API:", error);
      return this.primaryFallbackUUIDToUsername(uuid);
    }
  }

  private static async primaryFallbackUUIDToUsername(
    uuid: string
  ): Promise<string | null> {
    try {
      const response = await fetch(
        encodeURI(`https://api.gapple.pw/cors/profile/${uuid}`)
      );

      if (response.ok) {
        const data = await response.json();
        return data?.name ?? null;
      } else {
        console.error(
          `Unexpected Gapple API error for UUID ${uuid}: ${response.status} ${response.statusText}`
        );
        return null;
      }
    } catch (error) {
      console.error("Error fetching username from Gapple API:", error);
      return null;
    }
  }

  public static validateUsername(username: string): boolean {
    return /^[a-zA-Z0-9_]{1,16}$/.test(username);
  }
}
