import { describe, expect, it } from "vitest";
import * as z from "zod";
import { tool } from "../tools/tool.js";
import type { TurnEvent } from "../session/turn.js";
import { createFakePluginContext } from "./fake-plugin-context.js";

function replyTool(name = "reply") {
  return tool({
    name,
    description: "d",
    input: z.object({ text: z.string() }),
    execute: ({ text }) => `sent: ${text}`,
  });
}

describe("createFakePluginContext", () => {
  describe("session-scoped tools", () => {
    it("records tools bound at session creation, not on later turns", async () => {
      const ctx = createFakePluginContext({ source: "telegram" });
      const bound = replyTool();

      await ctx.sessions.run("42", "hi", { session: { tools: [bound] } });
      // Session already live — these options (and tools) are ignored, like the runtime.
      await ctx.sessions.run("42", "again", { session: { tools: [replyTool("other")] } });

      expect(ctx.sessionTools).toEqual([{ key: "42", tools: [bound] }]);
    });

    it("records one-shot run tools under a null key", async () => {
      const ctx = createFakePluginContext();
      const bound = replyTool();

      await ctx.run("hi", { tools: [bound] });

      expect(ctx.sessionTools).toEqual([{ key: null, tools: [bound] }]);
    });
  });

  describe("runtime.exec", () => {
    it("records every exec call and returns the scripted output", async () => {
      const ctx = createFakePluginContext({
        exec: ({ command }) => `out: ${command}`,
      });

      const output = await ctx.runtime.exec("df -h", { timeoutMs: 5_000 });

      expect(output).toBe("out: df -h");
      expect(ctx.execs).toEqual([{ command: "df -h", timeoutMs: 5_000 }]);
    });
  });

  describe("filePath", () => {
    it("resolves under the plugin's private directory", () => {
      const ctx = createFakePluginContext({ source: "cron" });

      const resolved = ctx.filePath("db", "state.json");

      expect(resolved).toMatch(/plugins[/\\]cron[/\\]db[/\\]state\.json$/);
    });
  });

  describe("scripted turns", () => {
    it("replays scripted events between turn_start and turn_end and resolves the result", async () => {
      const ctx = createFakePluginContext({
        reply: ({ prompt }) => ({
          text: `done: ${prompt}`,
          events: [{ type: "tool_start", tool: "search", toolCallId: "c1" }],
          durationMs: 42,
        }),
      });

      const turn = ctx.sessions.run("k", "go");
      const events: TurnEvent[] = [];
      for await (const event of turn.events) events.push(event);

      expect(events).toEqual([
        { type: "turn_start" },
        { type: "tool_start", tool: "search", toolCallId: "c1" },
        { type: "turn_end" },
      ]);
      expect(await turn).toEqual({ text: "done: go", durationMs: 42 });
    });

    it("brackets a bare string reply with turn_start/turn_end and defaults durationMs to 1", async () => {
      const ctx = createFakePluginContext({ reply: () => "hi" });

      const turn = ctx.sessions.run("k", "go");
      const events: TurnEvent[] = [];
      for await (const event of turn.events) events.push(event);

      expect(events).toEqual([{ type: "turn_start" }, { type: "turn_end" }]);
      expect(await turn).toEqual({ text: "hi", durationMs: 1 });
    });
  });

  describe("commands", () => {
    it("lists and dispatches contributed commands", async () => {
      const calls: string[] = [];
      const ctx = createFakePluginContext({
        commands: [
          {
            name: "hello",
            description: "Say hello",
            handler: async ({ args }) => void calls.push(args),
          },
        ],
      });

      expect(ctx.commands.list()).toEqual([{ name: "hello", description: "Say hello" }]);
      expect(await ctx.commands.dispatch("hello", { args: "world", reply: async () => {} })).toBe(
        true,
      );
      expect(await ctx.commands.dispatch("missing", { args: "", reply: async () => {} })).toBe(
        false,
      );
      expect(calls).toEqual(["world"]);
    });
  });
});
