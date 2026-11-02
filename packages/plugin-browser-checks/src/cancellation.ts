import type { createAtlasClient } from "./atlas.js";

/**
 * A cancel acknowledgement is not proof of shutdown; read the known run back.
 */
export async function stopAtlasRun(
  client: ReturnType<typeof createAtlasClient>,
  runId: string,
): Promise<boolean> {
  const signal = AbortSignal.timeout(10000);
  try {
    await client.cancel(runId, signal);
    return (await client.status(runId, signal)).state !== "running";
  } catch {
    return false;
  }
}
