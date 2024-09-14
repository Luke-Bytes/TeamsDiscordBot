import { Message, TextChannel, BaseMessageOptions, User, AttachmentBuilder } from 'discord.js';
import { Client } from 'discord.js';

export class MessageHandler {
  constructor(private client: Client) {}

  async isBotMentioned(message: Message): Promise<boolean> {
    return message.mentions.has(this.client.user?.id || '');
  }

  async sendMessage(channel: TextChannel, content: string, options?: BaseMessageOptions): Promise<void> {
    await channel.send({ content, ...options });
  }

async deleteMessageAfterTimeout(message: Message, timeout: number): Promise<void> {
  setTimeout(() => {
    message.delete().catch(console.error);
  }, timeout);
}

async sendDM(user: User, content: string): Promise<void> {
  try {
    await user.send(content);
    console.log(`DM sent to ${user.tag}`);
  } catch (error) {
    console.error(`Failed to send DM to ${user.tag}:`, error);
  }
}

async postImage(channel: TextChannel, imageUrl: string, caption: string = ''): Promise<void> {
  try {
    const attachment = new AttachmentBuilder(imageUrl);
    await channel.send({ content: caption, files: [attachment] });
    console.log('Image posted successfully');
  } catch (error) {
    console.error('Failed to post image:', error);
  }
}
}
