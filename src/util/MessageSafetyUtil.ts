const MIN_PLAN_LENGTH = 10;
const MIN_WORD_COUNT = 3;
const REPEATED_CHAR_PATTERN = /(.)\1{7,}/i;
const MASS_MENTION_PATTERN = /@(everyone|here)/i;
const PROHIBITED_PATTERNS: RegExp[] = [
  /\bnigg(?:er|a)s?\b/i,
  /\bfagg?(?:ot|ots)\b/i,
  /\bkike\b/i,
  /\bspic\b/i,
  /\bchink\b/i,
  /\bcoon\b/i,
  /\bretard(?:ed)?\b/i,
  /\bcunt\b/i,
];

type ValidationResult = {
  valid: boolean;
  feedback?: string;
};

export class MessageSafetyUtil {
  public static validateCaptainPlanMessage(
    content: string,
    hasAttachment: boolean
  ): ValidationResult {
    const trimmed = content.trim();

    if (!hasAttachment) {
      if (trimmed.length < MIN_PLAN_LENGTH) {
        return {
          valid: false,
          feedback:
            "I need a little more detail before I can share your plan. Please resend it with at least a sentence describing your strategy (10+ characters).",
        };
      }

      if (this.getWordCount(trimmed) < MIN_WORD_COUNT) {
        return {
          valid: false,
          feedback:
            "Could you expand on that plan a bit more? A short sentence (3+ words) helps your team understand it.",
        };
      }

      if (this.isLikelySpam(trimmed)) {
        return {
          valid: false,
          feedback:
            "That message looks accidental (lots of repeated characters). Please resend the actual plan when you're ready.",
        };
      }
    }

    if (trimmed && this.containsUnsafeLanguage(trimmed)) {
      return {
        valid: false,
        feedback:
          "I spotted wording I can't forward. Please rephrase the plan without slurs or mass mentions.",
      };
    }

    return { valid: true };
  }

  private static getWordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
  }

  private static isLikelySpam(text: string): boolean {
    return REPEATED_CHAR_PATTERN.test(text);
  }

  private static containsUnsafeLanguage(text: string): boolean {
    if (MASS_MENTION_PATTERN.test(text)) {
      return true;
    }

    return PROHIBITED_PATTERNS.some((pattern) => pattern.test(text));
  }
}
