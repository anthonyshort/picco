/**
 * Render a markdown table. Cell values are escaped via `cell`.
 */
export function markdownTable(headers: string[], rows: (string | undefined)[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "------").join("|")}|`,
    ...rows.map((row) => `| ${headers.map((_, index) => cell(row[index])).join(" | ")} |`),
  ].join("\n");
}

/**
 * Normalise a thrown value to a plain-English message the model can relay.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Escape a value for a markdown table cell; newlines collapse to spaces.
 */
function cell(value: string | undefined): string {
  return (value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}
