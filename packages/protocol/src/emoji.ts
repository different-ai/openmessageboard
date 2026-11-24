/**
 * Reaction emoji. A reaction is stored as one short name, so `eyes`, `:eyes:` and 👀 are the same reaction.
 * This module has no dependencies, so browser clients can import it on its own
 * (`@openmessageboard/protocol/emoji`).
 */

/** Short name → emoji, for the common reactions. Other short names are accepted as written. */
export const EMOJI: Readonly<Record<string, string>> = {
  thumbs_up: "👍",
  thumbs_down: "👎",
  heart: "❤️",
  eyes: "👀",
  tada: "🎉",
  rocket: "🚀",
  fire: "🔥",
  white_check_mark: "✅",
  check: "✔️",
  x: "❌",
  warning: "⚠️",
  question: "❓",
  exclamation: "❗",
  pray: "🙏",
  clap: "👏",
  raised_hands: "🙌",
  wave: "👋",
  ok_hand: "👌",
  muscle: "💪",
  thinking: "🤔",
  joy: "😂",
  smile: "😄",
  slightly_smiling_face: "🙂",
  sweat_smile: "😅",
  cry: "😢",
  confused: "😕",
  rotating_light: "🚨",
  bug: "🐛",
  hourglass: "⏳",
  zap: "⚡",
  star: "⭐",
  sparkles: "✨",
  bulb: "💡",
  memo: "📝",
  pushpin: "📌",
  lock: "🔒",
  wrench: "🔧",
  hammer: "🔨",
  package: "📦",
  link: "🔗",
  rewind: "⏪",
  stop_sign: "🛑",
  construction: "🚧",
  green_circle: "🟢",
  red_circle: "🔴",
  hundred: "💯",
};

/** Alternative names that mean the same reaction. */
export const EMOJI_ALIASES: Readonly<Record<string, string>> = {
  "+1": "thumbs_up",
  thumbsup: "thumbs_up",
  plus_one: "thumbs_up",
  "-1": "thumbs_down",
  thumbsdown: "thumbs_down",
  red_heart: "heart",
  check_mark: "check",
  heavy_check_mark: "check",
  checkmark: "white_check_mark",
  "100": "hundred",
  party: "tada",
  party_popper: "tada",
  lightning: "zap",
  light_bulb: "bulb",
  thinking_face: "thinking",
  laughing: "joy",
};

/** Emoji shown first in pickers. */
export const COMMON_REACTIONS = ["thumbs_up", "heart", "eyes", "tada", "rocket", "white_check_mark", "thinking", "pray"] as const;

/** Short names: lowercase letters, digits, `_`, `+` and `-`, up to 32. */
export const EMOJI_NAME_PATTERN = /^[a-z0-9+][a-z0-9_+-]{0,31}$/;

const BY_CHARACTER = new Map<string, string>();
for (const [name, char] of Object.entries(EMOJI)) {
  const key = char.replace(/\uFE0F/g, "");
  if (!BY_CHARACTER.has(key)) BY_CHARACTER.set(key, name);
}

/**
 * The stored short name for an emoji given as a short name (`eyes`), a short name in colons (`:eyes:`)
 * or the emoji itself (👀). Returns null when the input is none of these.
 */
export function normalizeEmoji(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const byChar = BY_CHARACTER.get(raw.replace(/\uFE0F/g, "").replace(/[\u{1F3FB}-\u{1F3FF}]/gu, ""));
  if (byChar) return byChar;
  const bare = raw.replace(/^:(.+):$/, "$1").toLowerCase();
  const direct = EMOJI_ALIASES[bare];
  if (direct) return direct;
  const name = bare.replace(/-/g, "_");
  const canonical = EMOJI_ALIASES[name] ?? name;
  return EMOJI_NAME_PATTERN.test(canonical) ? canonical : null;
}

/** The emoji character for a stored short name, or null when it isn't one of the common ones. */
export function emojiChar(name: string): string | null {
  return EMOJI[name] ?? null;
}
