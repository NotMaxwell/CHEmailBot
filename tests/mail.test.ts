// buildRaw is the one part of the Gmail path testable without credentials.
import { expect, test } from "bun:test";
import { buildRaw } from "../src/mail/gmail.ts";

const headersOf = (raw: string) => raw.split("\r\n\r\n")[0]!;
const bodyOf = (raw: string) => raw.split("\r\n\r\n")[1]!;

test("headers are CRLF-delimited and carry the recipient", () => {
  const raw = buildRaw("them@example.com", "Hello", "Hi");
  expect(headersOf(raw)).toContain("To: them@example.com");
  expect(headersOf(raw)).toContain('Content-Type: text/plain; charset="UTF-8"');
  expect(raw.split("\r\n\r\n").length).toBe(2);      // exactly one header/body split
});

test("ASCII subjects pass through; non-ASCII is RFC 2047 encoded", () => {
  expect(headersOf(buildRaw("a@b.c", "Plain subject", "x"))).toContain("Subject: Plain subject");
  const enc = headersOf(buildRaw("a@b.c", "Café Ölsen", "x"));
  expect(enc).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
});

test("body is base64, wrapped at 76 chars, with no trailing blank line", () => {
  const body = "Hi there,\n\n" + "x".repeat(500);
  const encoded = bodyOf(buildRaw("a@b.c", "s", body));
  const lines = encoded.split("\r\n");
  expect(lines.every((l) => l.length <= 76)).toBe(true);
  expect(lines.at(-1)!.length).toBeGreaterThan(0);   // no trailing empty line
  expect(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(body);
});

test("round-trips UTF-8 bodies intact", () => {
  const body = "Grüße aus Huntsville — naïve café 🚀";
  const encoded = bodyOf(buildRaw("a@b.c", "s", body));
  expect(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(body);
});
