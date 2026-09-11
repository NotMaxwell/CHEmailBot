// Runs offline against tests/fixtures/ -- real HTML saved from the live Chamber
// site on 2026-09-11. No network needed. `bun test`
import { expect, test } from "bun:test";
import { memberSlugs, parseMember, harvestEmails, decode } from "../src/scrape/parse.ts";

const member = await Bun.file("tests/fixtures/member.html").text();
const category = await Bun.file("tests/fixtures/category.html").text();

test("memberSlugs extracts unique, well-formed slugs", () => {
  const slugs = memberSlugs(category);
  expect(slugs.length).toBeGreaterThan(50);           // 246 unique from 492 anchors
  expect(slugs).toContain("a-p-t-research-inc-apt-164");
  expect(slugs.every((s) => /^[a-z0-9][a-z0-9-]*$/.test(s))).toBe(true);
  expect(new Set(slugs).size).toBe(slugs.length);
});

test("parseMember pulls every itemprop field", () => {
  expect(parseMember(member)).toMatchObject({
    name: "A-P-T Research, Inc. (APT)",
    street: "4950 Research Dr NW",
    city: "Huntsville",
    state: "AL",
    postal_code: "35805-5906",
    phone: "(256) 327-3373",
    website: "https://www.apt-research.com/",
  });
});

// This is the assertion that documents WHY the project has a second scrape
// stage. If it ever fails, the Chamber started publishing addresses and
// discover.ts could be skipped for those listings.
test("Chamber publishes NO email address, only a relay label", () => {
  expect(parseMember(member).emailSlot).toBe("Send Email");
  expect(member).not.toMatch(/href="mailto:/i);
});

test("decode unwraps entities and collapses whitespace", () => {
  expect(decode("Smith &amp; Sons&nbsp;Inc.")).toBe("Smith & Sons Inc.");
});

test("harvestEmails ranks mailto above body text and drops junk", () => {
  const found = harvestEmails(`<a href="mailto:info@acme.com?subject=hi">Mail</a>
    <p>Reach sales@acme.com or see logo@2x.png</p>
    <script>Sentry.init("x@sentry.io")</script>`);
  expect(found[0]).toEqual({ address: "info@acme.com", source: "mailto", confidence: 1.0 });
  expect(found.some((f) => f.address === "sales@acme.com" && f.confidence === 0.8)).toBe(true);
  expect(found.some((f) => /sentry|\.png/.test(f.address))).toBe(false);
});
