import { describe, expect, test } from "vitest";
import { describeStoreContract } from "@picco-agent/identity/testing";
import { sqliteStore, type SqliteLike } from "./index.js";

import { DatabaseSync } from "node:sqlite";

function createDb(): SqliteLike {
  const db = new DatabaseSync(":memory:");
  return { run: (sql) => db.exec(sql), query: (sql) => db.prepare(sql) };
}

describe("sqliteStore on node:sqlite", () => {
  describeStoreContract("contract", () => sqliteStore(createDb()));

  test("a row whose envelope column is not valid JSON reads as not connected", async () => {
    const db = createDb();
    const store = sqliteStore(db);
    db.query(
      `INSERT INTO connections (user, connector, envelope, connected_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("telegram:1", "github", '{"v":1,"blob":"opaque', 1, null);

    expect(await store.get("telegram:1", "github")).toBeNull();
  });
});
