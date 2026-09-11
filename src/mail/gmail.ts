// Gmail API adapter. Uses an OAuth desktop-app client so mail leaves your real
// mailbox and replies thread naturally.
//
// Scope needed: https://www.googleapis.com/auth/gmail.send  (send-only; it
// cannot read your inbox, which is the scope you want to grant).
//
// TODO: token bootstrap via /oauth/start + /oauth/callback in web/routes.ts,
//       persisted to config.gmail.tokenPath.

export interface SendResult { messageId: string; threadId: string }

/** TODO: RFC-2822 encode, base64url, POST users.messages.send. */
export async function sendMessage(
  _to: string, _subject: string, _body: string,
): Promise<SendResult> {
  throw new Error("not implemented");
}
