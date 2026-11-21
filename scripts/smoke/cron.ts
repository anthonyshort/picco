import { bwrap } from "@picco-agent/runtime-bwrap";
import { runCronSmoke } from "./cron-smoke.js";
import { createSmokeModel } from "./model.js";

await runCronSmoke({
  runtime: bwrap({ env: ["OPENROUTER_API_KEY"] }),
  pi: createSmokeModel(),
});
