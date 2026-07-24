import { Cron as Croner } from "croner";

/**
 * Validate a 6-field cron expression ("0 0 9 * * 1" — seconds first). The field-count check keeps
 * job files uniform; Croner itself would also accept 5-field and @-shorthand patterns.
 */
export function validateCronExpression(
  expr: string,
): { valid: true } | { valid: false; error: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 6) {
    return {
      valid: false,
      error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}.`,
    };
  }
  try {
    // Constructing parses the pattern and throws on failure; with no callback nothing is scheduled.
    new Croner(expr);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Invalid cron expression",
    };
  }
}

/**
 * Throwing form of validateCronExpression, for write paths (save/update).
 */
export function assertValidSchedule(schedule: string): void {
  const check = validateCronExpression(schedule);
  if (!check.valid) {
    throw new Error(
      `Invalid schedule "${schedule}": ${check.error} Use a 6-field cron expression (e.g. "0 */5 * * * *").`,
    );
  }
}
