import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "@picco-agent/core";
import { notifications } from "@picco-agent/plugin-notifications";
import { bwrap } from "@picco-agent/runtime-bwrap";
import { createSmokeModel } from "./model.js";

await runNotificationSmoke();

/**
 * Exercise notification sends, shared deduplication and receipt lookup through the real bridge.
 */
async function runNotificationSmoke(): Promise<void> {
  const dataDir = mkdtempSync(path.join(os.homedir(), ".picco-notifications-smoke-"));
  const externalId = randomUUID();
  const messages: string[] = [];
  const notifier = notifications({
    destinations: {
      recording: {
        async send(text) {
          messages.push(text);
          return { status: "confirmed", externalId };
        },
      },
    },
  });
  const input = {
    destination: "recording",
    text: "Smoke notification",
    deduplicationKey: "smoke-model",
  };
  const agent = createAgent({
    name: "notifications-smoke",
    dataDir,
    runtime: bwrap({ env: ["OPENROUTER_API_KEY"] }),
    pi: { ...createSmokeModel(), allowedTools: ["notify"] },
    plugins: [notifier],
  });

  try {
    await agent.start({ handleSignals: false });
    const sendTurn = agent.sessions.run(
      "send",
      `Invoke notify with ${JSON.stringify({ action: "send", ...input })}. ` +
        "Make the tool call, wait for its result, then reply with its externalId.",
      { timeoutMs: 240_000 },
    );
    const sent = await sendTurn;
    let completedSend = false;
    for await (const event of sendTurn.events) {
      if (event.type === "tool_end" && event.tool === "notify" && !event.isError)
        completedSend = true;
    }
    assert.ok(completedSend, "model did not complete the notify send tool call");
    assert.ok(sent.text.includes(externalId), "model did not receive the adapter receipt");
    assert.deepEqual(messages, [input.text], "adapter must send the requested text once");

    const duplicate = await notifier.notify(input);
    assert.equal(duplicate.duplicate, true, "host and model must share deduplication");
    assert.equal(duplicate.status, "confirmed");
    assert.equal(duplicate.externalId, externalId);

    const statusTurn = agent.sessions.run(
      "status",
      `Invoke notify with ${JSON.stringify({ action: "status", deliveryId: duplicate.deliveryId })}. ` +
        "Make the tool call, wait for its result, then reply with its externalId.",
      { timeoutMs: 240_000 },
    );
    const status = await statusTurn;
    let completedLookup = false;
    for await (const event of statusTurn.events) {
      if (event.type === "tool_end" && event.tool === "notify" && !event.isError)
        completedLookup = true;
    }
    assert.ok(completedLookup, "model did not complete the notify status tool call");
    assert.ok(
      status.text.includes(externalId),
      "receipt lookup did not return the adapter receipt",
    );
    assert.deepEqual(messages, [input.text], "duplicates and status lookup must not send again");
    console.log("[notifications] PASS: model sends through the configured adapter");
    console.log("[notifications] PASS: host calls share the model’s delivery cache");
    console.log("[notifications] PASS: the same tool looks up receipts without sending");
  } finally {
    await agent.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
