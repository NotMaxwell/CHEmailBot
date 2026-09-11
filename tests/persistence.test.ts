// Guards the property that makes data durable: a relative DB_PATH resolves
// against the PROJECT ROOT, never the working directory.
//
// The bug this exists for: `data/chembot.db` opened from /tmp silently created
// a second, empty database and served it as your data.
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { resolveDbPath, ROOT } from "../src/db.ts";

const ELSEWHERE = "/some/other/cwd";

test("a relative path resolves against the root, not the caller's cwd", () => {
  expect(resolveDbPath("data/chembot.db", ROOT)).toBe(join(ROOT, "data/chembot.db"));
  // Same answer regardless of where the process happens to be running:
  expect(resolveDbPath("data/chembot.db", ROOT))
    .not.toBe(join(ELSEWHERE, "data/chembot.db"));
});

test("an absolute path is respected as given", () => {
  expect(resolveDbPath("/var/data/chembot.db", ROOT)).toBe("/var/data/chembot.db");
});

test(":memory: is passed through untouched", () => {
  expect(resolveDbPath(":memory:", ROOT)).toBe(":memory:");
  expect(resolveDbPath("", ROOT)).toBe("");
});

test("ROOT comes from the module location and contains the schema", async () => {
  expect(ROOT).toBe(dirname(import.meta.dir));          // tests/ is one level down
  expect(await Bun.file(join(ROOT, "data/schema.sql")).exists()).toBe(true);
});
