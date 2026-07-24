/**
 * Read a required environment variable and trim surrounding whitespace.
 */
export function readRequiredEnvironmentVariable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name} — add it to .env`);
  return value;
}

/**
 * Read a required comma-separated environment variable.
 */
export function readEnvironmentList(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = readRequiredEnvironmentVariable(name, environment)
    .split(",")
    .map((value) => value.trim());
  if (values.some((value) => !value)) {
    throw new Error(`${name} must contain comma-separated non-empty values`);
  }
  return values;
}

/**
 * Read Telegram's comma-separated numeric chat allowlist.
 */
export function readTelegramChatAllowlist(environment: NodeJS.ProcessEnv = process.env): number[] {
  const values = readEnvironmentList("TELEGRAM_BOT_ALLOWED_CHATS", environment);
  const chatIds = values.map(Number);
  if (
    values.some((value) => !/^-?\d+$/.test(value)) ||
    chatIds.some((chatId) => !Number.isSafeInteger(chatId))
  ) {
    throw new Error("TELEGRAM_BOT_ALLOWED_CHATS must contain comma-separated integer chat IDs");
  }
  return chatIds;
}
