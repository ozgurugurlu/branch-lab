import nextEnv from "@next/env";
import { databaseError } from "../src/server/database-errors.ts";

process.env.NODE_ENV ??= "development";
let closeDatabase;
let failure;

try {
  let environmentFailed = false;
  nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV === "development", {
    info() {},
    // Next's default logger may include file contents or parser errors.
    error() {
      environmentFailed = true;
    },
  });
  if (environmentFailed) {
    failure = {
      code: "ENVIRONMENT_CONFIGURATION",
      message:
        "An environment file could not be loaded. Check the project's .env files and their permissions, then retry.",
    };
  } else {
    // The server and this command share one schema initializer; no copied DDL.
    const databaseModule = await import("../src/server/db.ts");
    closeDatabase = databaseModule.closeDatabase;
    console.info("Preparing the Branchlab database...");
    await databaseModule.database();
  }
} catch (error) {
  failure = databaseError(error);
} finally {
  if (closeDatabase) {
    try {
      await closeDatabase();
    } catch (error) {
      failure ??= databaseError(error);
    }
  }
}

if (failure) {
  console.error(`[${failure.code}] ${failure.message}`);
  process.exitCode = 1;
} else {
  console.info(
    "Database ready. Connection closed; no workspace data was reset.",
  );
}
