import { afterEach, describe, expect, test } from "vitest";
import { silentLogger } from "@picco-agent/core";
import { OAuthCallbackListener } from "./callback.js";

const listeners: OAuthCallbackListener[] = [];

afterEach(async () => {
  for (const listener of listeners) await listener.stop();
  listeners.length = 0;
});

describe("OAuthCallbackListener", () => {
  test("completes a valid callback and renders the success page", async () => {
    const completions: string[] = [];
    const listener = await startListener(async (state, code) => {
      completions.push(`${state}/${code}`);
      return true;
    });

    const response = await fetch(
      `http://127.0.0.1:${listener.port}/oauth/callback?state=state&code=code`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You can close this tab");
    expect(completions).toEqual(["state/code"]);
  });

  test("renders provider refusals without attempting completion", async () => {
    let completions = 0;
    const listener = await startListener(async () => {
      completions++;
      return true;
    });

    const response = await fetch(
      `http://127.0.0.1:${listener.port}/oauth/callback?error=access_denied`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("access_denied");
    expect(completions).toBe(0);
  });

  test("escapes a hostile provider error so it cannot inject markup", async () => {
    const listener = await startListener(async () => true);

    const response = await fetch(
      `http://127.0.0.1:${listener.port}/oauth/callback?error=${encodeURIComponent("<script>alert(1)</script>")}`,
    );

    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  test("rejects unknown routes and incomplete or expired callbacks", async () => {
    const listener = await startListener(async () => false);

    expect((await fetch(`http://127.0.0.1:${listener.port}/wrong`)).status).toBe(404);
    const expired = await fetch(
      `http://127.0.0.1:${listener.port}/oauth/callback?state=unknown&code=code`,
    );
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain("no longer valid");
  });
});

/**
 * Start a callback listener on an ephemeral port.
 */
async function startListener(
  complete: (state: string, code: string) => Promise<boolean>,
): Promise<OAuthCallbackListener> {
  const listener = new OAuthCallbackListener({
    callbackUrl: "https://agent.test/oauth/callback",
    port: 0,
    complete,
    logger: silentLogger(),
  });
  await listener.start();
  listeners.push(listener);
  return listener;
}
