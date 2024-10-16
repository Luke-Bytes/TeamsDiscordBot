export class MojangAPI {
  //store in db
  public static async usernameToUUID(username: string) {
    //idk if u need this encodeURI

    const response = await fetch(
      encodeURI(`https://api.mojang.com/users/profiles/minecraft/${username}`)
    );

    const data = await response.json();

    if (!data.id) {
      return;
    }

    return data.id as string;
  }

  // display
  public static async uuidToUsername(uuid: string) {
    //idk if u need this encodeURI
    const response = await fetch(
      encodeURI(
        `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`
      )
    );

    const data = await response.json();

    if (!data.name) {
      return;
    }

    return data.name as string;
  }

  public static validateUsername(username: string) {
    //no length check because some people have og
    return /^[a-zA-Z0-9_]+$/.test(username) && username.length <= 16;
  }
}
