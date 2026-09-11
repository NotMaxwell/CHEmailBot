import { expect, test } from "bun:test";
import { nameKey } from "../src/db.ts";

// The dedup key is the whole ballgame: if these don't collide, you send twice.
test("collapses legal suffixes and parentheticals", () => {
  expect(nameKey("A-P-T Research, Inc. (APT)")).toBe(nameKey("APT Research Inc"));
  expect(nameKey("Dynetics, LLC")).toBe(nameKey("Dynetics"));
  expect(nameKey("The Boeing Company")).toBe(nameKey("Boeing"));
});

test("keeps genuinely different companies apart", () => {
  expect(nameKey("Advanced Navigation")).not.toBe(nameKey("Advanced Information Technologies"));
});
