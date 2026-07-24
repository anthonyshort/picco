import { describe, expect, test } from "vitest";
import { markdownTable } from "./format.js";

describe("markdownTable", () => {
  test("renders a header row, a separator row, and one row per record", () => {
    expect(
      markdownTable(
        ["Name", "Age"],
        [
          ["Alice", "30"],
          ["Bob", "25"],
        ],
      ),
    ).toBe("| Name | Age |\n|------|------|\n| Alice | 30 |\n| Bob | 25 |");
  });

  test("emits one separator segment per header", () => {
    expect(markdownTable(["A", "B", "C"], [])).toBe("| A | B | C |\n|------|------|------|");
  });

  test("renders just the header and separator when there are no rows", () => {
    expect(markdownTable(["Only"], [])).toBe("| Only |\n|------|");
  });

  test("pads a short row with empty cells so the table stays rectangular", () => {
    expect(markdownTable(["A", "B"], [["x"]])).toBe("| A | B |\n|------|------|\n| x |  |");
  });

  test("truncates a row that has more cells than there are headers", () => {
    expect(markdownTable(["A"], [["x", "y"]])).toBe("| A |\n|------|\n| x |");
  });

  test("escapes pipe characters so a value cannot break the table", () => {
    expect(markdownTable(["H"], [["a|b"]])).toBe("| H |\n|------|\n| a\\|b |");
  });

  test("collapses a newline and its surrounding whitespace into a single space", () => {
    expect(markdownTable(["H"], [["line 1 \n line 2"]])).toBe("| H |\n|------|\n| line 1 line 2 |");
  });

  test("renders an undefined cell as empty", () => {
    expect(markdownTable(["H"], [[undefined]])).toBe("| H |\n|------|\n|  |");
  });

  test("trims surrounding whitespace from a cell", () => {
    expect(markdownTable(["H"], [["  hi  "]])).toBe("| H |\n|------|\n| hi |");
  });
});
