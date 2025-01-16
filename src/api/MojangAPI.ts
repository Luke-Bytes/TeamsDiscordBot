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
        return data?.id || null;
      } else if (response.status === 404) {
        console.warn(`Username ${username} not found in Mojang API.`);
        return null;
      } else {
        console.error(
          `Unexpected Mojang API error for username ${username}: ${response.status} ${response.statusText}`
        );
        return username;
      }
    } catch (error) {
      console.error("Error fetching UUID from Mojang API:", error);
      return username;
    }
  }

  public static async uuidToUsername(uuid: string): Promise<string | null> {
    if (!uuid || !/^[0-9a-f]{32}$/.test(uuid)) {
      console.error("Invalid UUID format.");
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
        return data?.name || null; // Return username if available
      } else {
        console.error(
          `Unexpected Mojang API error for UUID ${uuid}: ${response.status} ${response.statusText}`
        );
        return null;
      }
    } catch (error) {
      console.error("Error fetching username from Mojang API:", error);
      return null;
    }
  }

  public static validateUsername(username: string): boolean {
    return /^[a-zA-Z0-9_]{1,16}$/.test(username);
  }
}
