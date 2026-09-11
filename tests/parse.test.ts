// Runs offline against tests/fixtures/ -- real HTML saved from the live Chamber
// site on 2026-09-11. No network needed. `bun test`
import { expect, test } from "bun:test";
import { memberSlugs, parseMember, harvestEmails, decode, sameOrg } from "../src/scrape/parse.ts";

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

// --- email discovery: cases found by debugging against real company sites ---

test("recovers addresses embedded in <script> JSON at reduced confidence", () => {
  // federal.octave.com renders client-side: its only contact address lives in a
  // Next.js JSON blob, never in the markup. Skipping scripts lost it entirely.
  const found = harvestEmails(
    `<html><body><p>No contact here</p>
     <script>{"footer":{"email":"info@octavefederal.com"}}</script></body></html>`,
    "federal.octave.com");
  expect(found[0]).toEqual({
    address: "info@octavefederal.com", source: "contact_page", confidence: 0.6,
  });
});

test("telemetry keys and form placeholders are never harvested", () => {
  const found = harvestEmails(
    `<script>Sentry.init("3b2b139c2976b8f87d1e317a332e55e0@o451.ingest.de.sentry.io")</script>
     <input placeholder="user@domain.com"><p>you@example.com</p>
     <a href="mailto:real@acme.com">Mail</a>`, "acme.com");
  expect(found.map((f) => f.address)).toEqual(["real@acme.com"]);
});

test("a third-party address is demoted below the company's own", () => {
  const found = harvestEmails(
    `<a href="mailto:bob@biz-bob.com">Bob</a>
     <a href="mailto:accountant@intuit.com">Our accountant</a>`, "biz-bob.com");
  expect(found[0]!.address).toBe("bob@biz-bob.com");
  expect(found[0]!.confidence).toBe(1.0);
  expect(found[1]!.confidence).toBe(0.5);            // halved: unrelated domain
});

test("short domain labels are not mistaken for third parties", () => {
  // biz-bob.com splits to biz/bob/com -- all below the word-length filter, which
  // left nothing to compare and wrongly halved the company's own address.
  expect(sameOrg("biz-bob.com", "biz-bob.com")).toBe(true);
  expect(sameOrg("www.biz-bob.com", "biz-bob.com")).toBe(true);
  expect(harvestEmails(`<a href="mailto:info@biz-bob.com">x</a>`, "biz-bob.com")[0]!.confidence)
    .toBe(1.0);
});

test("related domains that are not identical still count as the same org", () => {
  expect(sameOrg("federal.octave.com", "octavefederal.com")).toBe(true);
  expect(sameOrg("ingentis.com", "ingentis.de")).toBe(true);
  expect(sameOrg("teamfdi.com", "gmail.com")).toBe(false);
});

test("results are ordered by confidence, best first", () => {
  const found = harvestEmails(
    `<a href="mailto:a@acme.com">a</a><p>b@acme.com</p>
     <script>{"e":"c@acme.com"}</script>`, "acme.com");
  expect(found.map((f) => f.confidence)).toEqual([1.0, 0.8, 0.6]);
});
