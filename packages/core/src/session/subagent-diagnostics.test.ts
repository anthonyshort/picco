import { describe, expect, test } from "vitest";
import { readSubagentDiagnostic } from "./subagent-diagnostics.js";
import type { JsonObject } from "./jsonl.js";

function entry(event: string, data: JsonObject = {}, identity: JsonObject = {}) {
  return {
    type: "entry_appended",
    entry: {
      type: "custom",
      customType: "headless-subagents:event",
      data: {
        version: 1,
        at: "2026-10-24T14:20:00.000Z",
        rootSessionId: "root",
        executionId: "execution1",
        agentId: "grandchild",
        parentAgentId: "child",
        event,
        data,
        ...identity,
      },
    },
  };
}

describe("readSubagentDiagnostic", () => {
  test("selects nested auth failure identity and transcript reference without raw details", () => {
    const result = readSubagentDiagnostic(
      entry("agent.failed", {
        category: "authentication",
        phase: "model",
        statusCode: 401,
        reason: "authentication_rejected",
        transcriptPath: "/data/My  Project/child.jsonl",
        error: "private raw message",
        details: { token: "private-token" },
        label: "private task label",
      }),
    );
    expect(result).toEqual({
      event: "agent.failed",
      isError: true,
      terminal: true,
      data: {
        version: 1,
        at: "2026-10-24T14:20:00.000Z",
        rootSessionId: "root",
        executionId: "execution1",
        agentId: "grandchild",
        parentAgentId: "child",
        category: "authentication",
        phase: "model",
        statusCode: 401,
        reason: "authentication_rejected",
        transcriptPath: "/data/My  Project/child.jsonl",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test.each([
    "agent.failed",
    "agent.timed_out",
    "agent.limit_reached",
    "cleanup.failed",
    "persistence.failed",
  ])("%s is observable without an arbitrary error message", (event) => {
    expect(readSubagentDiagnostic(entry(event))?.isError).toBe(true);
  });

  test("cancellation intent remains distinct from terminal settlement", () => {
    expect(
      readSubagentDiagnostic(
        entry("agent.cancellation_requested", { status: "running", reason: "timed_out" }),
      ),
    ).toMatchObject({
      isError: false,
      terminal: false,
      data: { status: "running", reason: "timed_out" },
    });
    expect(readSubagentDiagnostic(entry("agent.cancelled", { status: "cancelled" }))).toMatchObject(
      { isError: false, terminal: true },
    );
  });

  test("retains bounded progress/usage metadata", () => {
    expect(
      readSubagentDiagnostic(
        entry("agent.progress", {
          durationMs: 30000,
          quietForMs: 10000,
          activeTools: 1,
          input: 100,
          output: 20,
          cost: 0.001,
          prompt: "private task",
        }),
      )?.data,
    ).toMatchObject({
      durationMs: 30000,
      quietForMs: 10000,
      activeTools: 1,
      input: 100,
      output: 20,
      cost: 0.001,
    });
  });

  test("ignores unrelated, unversioned and malformed events", () => {
    expect(readSubagentDiagnostic({ type: "message_end" })).toBeUndefined();
    expect(readSubagentDiagnostic(entry("agent.running", {}, { version: 2 }))).toBeUndefined();
    expect(readSubagentDiagnostic(entry("agent.running", {}, { executionId: "" }))).toBeUndefined();
    expect(readSubagentDiagnostic(entry("agent.running", { toolUses: -1 }))).toBeUndefined();
    expect(
      readSubagentDiagnostic(entry("agent.failed", { code: "arbitrary-secret" })),
    ).toBeUndefined();
  });
});
