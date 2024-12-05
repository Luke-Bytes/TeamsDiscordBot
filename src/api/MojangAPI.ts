export class MojangAPI {
  // Store in DB
  public static async usernameToUUID(username: string): Promise<string | null> {
    if (!this.validateUsername(username)) {
      console.error("Invalid username format for " + username);
    }

    try {
      const response = await fetch(
        encodeURI(`https://api.mojang.com/users/profiles/minecraft/${username}`)
      );

      if (!response.ok) {
        console.error(`Mojang API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (!data?.id) {
        return null;
      }

      return data.id as string;
    } catch (error) {
      console.error("Error fetching UUID from username:", error);
      return null;
    }
  }

  // Display
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

      if (!response.ok) {
        console.error(`Mojang API error: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = await response.json();

      if (!data?.name) {
        return null; // UUID not found
      }

      return data.name as string;
    } catch (error) {
      console.error("Error fetching username from UUID:", error);
      return null;
    }
  }

  public static validateUsername(username: string): boolean {
    return /^[a-zA-Z0-9_]{1,16}$/.test(username);
  }
}

