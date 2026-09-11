// The contact-form confidence rule. Pure -- no browser, no network.
import { expect, test } from "bun:test";
import { isConfident } from "../src/forms/assist.ts";

const NAMED = "textarea[name*=message i]";
const BARE = "textarea";

test("no message field is never confident", () => {
  expect(isConfident(null, "input[name*=name i]", "input[type=email]")).toBe(false);
});

test("a named message field is confident on its own", () => {
  expect(isConfident(NAMED, null, null)).toBe(true);
  expect(isConfident("textarea[name*=comment i]", null, null)).toBe(true);
});

test("a bare textarea needs both a name and an email field beside it", () => {
  expect(isConfident(BARE, "input[name*=name i]", "input[type=email]")).toBe(true);
  expect(isConfident(BARE, null, "input[type=email]")).toBe(false);  // newsletter signup
  expect(isConfident(BARE, "input[name*=name i]", null)).toBe(false);
  expect(isConfident(BARE, null, null)).toBe(false);                 // search box
});
