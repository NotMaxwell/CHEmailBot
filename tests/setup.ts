// Preloaded before every test module (see bunfig.toml).
//
// src/db.ts opens its Database at import time and bun test shares one module
// registry across files, so whichever test file imports it first decides the
// path for the entire run. Setting it here, before any test module loads,
// removes that race and makes hitting the real database impossible.
process.env.DB_PATH = ":memory:";
process.env.SENDER_NAME = "Test Sender";
process.env.SENDER_ORG = "";          // or the real .env value leaks in
process.env.SENDER_POSTAL_ADDRESS = "1 Test St, Huntsville AL";
process.env.UNSUBSCRIBE_MAILTO = "unsub@test.example";
process.env.DRY_RUN = "1";
