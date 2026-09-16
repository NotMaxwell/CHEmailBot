// Shared test helpers. Not a test file itself -- bun test only picks up *.test.ts.
import * as auth from "../src/auth.ts";

let cached: string | null = null;

/**
 * A Cookie header for a signed-in admin, created once per run.
 *
 * Every route except /login is behind the auth gate, so a request without this
 * gets a 302 to /login -- which is itself a 302 and will silently satisfy a
 * naive `expect(302)`. Tests that mean to reach a route must send it.
 */
export async function sessionCookie(): Promise<string> {
  if (cached) return cached;
  const username = "testrunner";
  if (!auth.listStudents().some((s) => s.username === username)) {
    await auth.createStudent("Test Runner", username, "test-password-1234", "admin");
  }
  const session = await auth.login(username, "test-password-1234");
  if (!session) throw new Error("test sign-in failed");
  return (cached = `${auth.SESSION_COOKIE}=${session.token}`);
}

/** Headers for an authenticated same-origin form POST. */
export const formPost = async () => ({
  "content-type": "application/x-www-form-urlencoded",
  origin: "http://localhost",
  cookie: await sessionCookie(),
});
