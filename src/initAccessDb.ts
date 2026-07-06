import dotenv from "dotenv";
import { ensureAccessDatabaseSchema, getAccessDatabaseStatus } from "./accessDb.js";

dotenv.config();

const status = await getAccessDatabaseStatus();

if (!status.configured) {
  console.log("DATABASE_URL is not configured. Add it to .env before running this.");
  process.exit(1);
}

if (!status.ok) {
  console.log(`Database connection failed: ${status.message}`);
  process.exit(1);
}

await ensureAccessDatabaseSchema();

console.log("OK access database schema is ready.");
