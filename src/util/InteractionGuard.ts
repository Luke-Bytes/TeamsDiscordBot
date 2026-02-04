import {
  Interaction,
  ApplicationCommandOptionType,
} from "discord.js";
import { PermissionsUtil } from "./PermissionsUtil";
import { MessageSafetyUtil } from "./MessageSafetyUtil";

type RateState = {
  lastAction: number;
  recentHistory: Array<{ key: string; time: number }>;
  cooldownUntil: number;
  cooldownLevel: number;
  lastViolationAt: number;
};

export class InteractionGuard {
  private readonly rateState = new Map<string, RateState>();

  private static readonly repeatedCommandWindowMs = 10_000;
  private static readonly repeatedCommandLimit = 3;
  private static readonly uniqueCommandWindowMs = 15_000;
  private static readonly uniqueCommandLimit = 5;
  private static readonly baseCooldownMs = 15_000;
  private static readonly cooldownEscalationWindowMs = 120_000;

  public async checkRateLimit(interaction: Interaction): Promise<boolean> {
    if (!("user" in interaction)) return true;
    const userId = interaction.user.id;
    if (interaction.inGuild() && interaction.member) {
      const member = interaction.member;
      if (PermissionsUtil.hasRole(member as any, "organiserRole")) {
        return true;
      }
    }

    const now = Date.now();
    const state: RateState = this.rateState.get(userId) ?? {
      lastAction: 0,
      recentHistory: [],
      cooldownUntil: 0,
      cooldownLevel: 0,
      lastViolationAt: 0,
    };

    if (state.cooldownUntil > now) {
      this.rateState.set(userId, state);
      console.log(
        `[RateLimit] Cooldown hit user=${userId} remaining=${Math.ceil(
          (state.cooldownUntil - now) / 1000
        )}s`
      );
      await this.replyRateLimit(
        interaction,
        `You're on cooldown. Please wait ${Math.ceil(
          (state.cooldownUntil - now) / 1000
        )}s.`
      );
      return false;
    }

    const key = this.getInteractionKey(interaction);
    if (key) {
      state.recentHistory = state.recentHistory.filter(
        (entry) => now - entry.time <= InteractionGuard.uniqueCommandWindowMs
      );
      const recentSame = state.recentHistory.filter(
        (entry) =>
          entry.key === key &&
          now - entry.time <= InteractionGuard.repeatedCommandWindowMs
      );
      const uniqueKeys = new Set(state.recentHistory.map((entry) => entry.key));
      const repeatedViolation =
        recentSame.length >= InteractionGuard.repeatedCommandLimit;
      const uniqueViolation =
        uniqueKeys.size >= InteractionGuard.uniqueCommandLimit &&
        !uniqueKeys.has(key);
      if (repeatedViolation || uniqueViolation) {
        if (
          now - state.lastViolationAt >
          InteractionGuard.cooldownEscalationWindowMs
        ) {
          state.cooldownLevel = 1;
        } else {
          state.cooldownLevel += 1;
        }
        state.lastViolationAt = now;
        state.cooldownUntil =
          now + InteractionGuard.baseCooldownMs * state.cooldownLevel;
        this.rateState.set(userId, state);
        console.log(
          `[RateLimit] Cooldown applied user=${userId} level=${state.cooldownLevel} duration=${Math.ceil(
            (state.cooldownUntil - now) / 1000
          )}s`
        );
        await this.replyRateLimit(
          interaction,
          `You're on cooldown. Please wait ${Math.ceil(
            (state.cooldownUntil - now) / 1000
          )}s.`
        );
        return false;
      }
      state.recentHistory.push({ key, time: now });
    }

    state.lastAction = now;
    this.rateState.set(userId, state);
    return true;
  }

  public async checkInputSafety(interaction: Interaction): Promise<boolean> {
    if (!interaction.isChatInputCommand()) return true;
    const unsafeInputs: string[] = [];
    const collectStrings = (opts: ReadonlyArray<any>) => {
      for (const opt of opts) {
        if (
          opt.type === ApplicationCommandOptionType.Subcommand ||
          opt.type === ApplicationCommandOptionType.SubcommandGroup
        ) {
          if (opt.options?.length) collectStrings(opt.options);
          continue;
        }
        if (
          opt.type === ApplicationCommandOptionType.String &&
          typeof opt.value === "string"
        ) {
          unsafeInputs.push(opt.value);
        }
      }
    };
    collectStrings(interaction.options.data);
    for (const input of unsafeInputs) {
      const validation = MessageSafetyUtil.validateUserInput(input);
      if (!validation.valid) {
        console.log(
          `[Filter] Blocked unsafe input user=${interaction.user.id} value="${input}"`
        );
        await interaction.reply({
          content:
            validation.feedback ??
            "Please remove slurs or mass mentions and try again.",
          ephemeral: true,
        });
        return false;
      }
    }
    return true;
  }

  private async replyRateLimit(
    interaction: Interaction,
    message: string
  ): Promise<void> {
    if (interaction.isAutocomplete()) {
      try {
        await interaction.respond([]);
      } catch {
        // ignore autocomplete rate-limit response failures
      }
      return;
    }
    if (!interaction.isRepliable()) return;
    if (interaction.replied || interaction.deferred) return;
    try {
      await interaction.reply({ content: message, ephemeral: true });
    } catch {
      // ignore rate-limit reply failures
    }
  }

  private getInteractionKey(interaction: Interaction): string | null {
    if (interaction.isChatInputCommand()) return interaction.commandName;
    if (interaction.isMessageContextMenuCommand())
      return interaction.commandName;
    if (interaction.isUserContextMenuCommand()) return interaction.commandName;
    if (interaction.isAutocomplete()) return interaction.commandName;
    if (interaction.isButton()) return `button:${interaction.customId}`;
    if (interaction.isStringSelectMenu())
      return `select:${interaction.customId}`;
    if (interaction.isModalSubmit()) return `modal:${interaction.customId}`;
    return null;
  }
}
