import { describe, expect, test } from "vitest";
import {
  readEnvironmentList,
  readRequiredEnvironmentVariable,
  readTelegramChatAllowlist,
} from "./environment.js";

describe("personal assistant environment", () => {
  test("reads and trims a required value", () => {
    expect(readRequiredEnvironmentVariable("TOKEN", { TOKEN: " secret " })).toBe("secret");
  });

  test.each([{}, { TOKEN: "" }, { TOKEN: "   " }])(
    "rejects a missing required value",
    (environment) => {
      expect(() => readRequiredEnvironmentVariable("TOKEN", environment)).toThrow(
        "Missing required environment variable TOKEN",
      );
    },
  );

  test("reads a trimmed comma-separated list", () => {
    expect(
      readEnvironmentList("ALLOWLIST", { ALLOWLIST: "one@example.com, @example.org" }),
    ).toEqual(["one@example.com", "@example.org"]);
  });

  test.each([",", "one@example.com,"])("rejects an empty list entry", (value) => {
    expect(() => readEnvironmentList("ALLOWLIST", { ALLOWLIST: value })).toThrow(
      "ALLOWLIST must contain comma-separated non-empty values",
    );
  });

  test("reads private and group Telegram chat IDs", () => {
    expect(
      readTelegramChatAllowlist({ TELEGRAM_BOT_ALLOWED_CHATS: "123456789, -1001234567890" }),
    ).toEqual([123456789, -1001234567890]);
  });

  test.each(["abc", "123.5", "0x10", "123, nope"])(
    "rejects an invalid Telegram chat ID",
    (value) => {
      expect(() => readTelegramChatAllowlist({ TELEGRAM_BOT_ALLOWED_CHATS: value })).toThrow(
        "TELEGRAM_BOT_ALLOWED_CHATS must contain comma-separated integer chat IDs",
      );
    },
  );
});
