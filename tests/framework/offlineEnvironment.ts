import { recordTestFailure } from "./test";

// Import before any test modules construct Prisma clients or spawn workers.
// An incomplete test double must never fall through to a configured database.
const offlineDatabase =
  "mongodb://127.0.0.1:1/offline_tests?serverSelectionTimeoutMS=250";
process.env.DATABASE_URL = offlineDatabase;
process.env.DATABASE_BACKUP_URL = offlineDatabase;

// Install before suite imports, and flag accidental HTTP access even if a
// production fallback catches the rejection. Tests must inject their own fake.
globalThis.fetch = (async () => {
  const error = new Error("Unmocked network fetch in offline test suite");
  recordTestFailure(error);
  throw error;
}) as typeof fetch;
