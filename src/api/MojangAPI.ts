import { log } from "console";

export class MojangAPI {
  //store in db
  public static async usernameToUUID(username: string) {
    //idk if u need this encodeURI
    const response = await fetch(
      encodeURI(`https://api.mojang.com/users/profiles/minecraft/${username}`)
    );

    const data = await response.json();

    return data.id;
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

    return data.name;
  }
}