import "../../config.js";
import fs from "node:fs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import AquaEnv from "../models/aquaEnv.js";
import {
  ENCRYPTION_KEY_NAME,
  createAquaEnvStore,
  isReservedKey,
} from "../services/aquaEnv.js";

// Copies variables from a .env file into the "aqua-env" collection
// (encrypted). Dry run by default; prints key names only, never values.
//   npm run env:import                         # dry run of ./.env
//   npm run env:import -- --file .env.prod     # dry run of another file
//   npm run env:import -- --apply              # write missing keys
//   npm run env:import -- --apply --overwrite  # also replace stored keys
// Needs DB_URL and AQUA_ENV_ENCRYPTION_KEY in the environment. After a
// successful import, remove the copied keys from .env/Doppler, keeping only
// DB_URL and AQUA_ENV_ENCRYPTION_KEY.

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const overwrite = args.includes("--overwrite");
const fileIndex = args.indexOf("--file");
const file = fileIndex >= 0 ? args[fileIndex + 1] : ".env";

if (!file || !fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}
if (!process.env.DB_URL) {
  console.error("DB_URL is required.");
  process.exit(1);
}

// Names that look like secrets are always masked; obvious settings (flags,
// hours, sizes, models, public URLs) are stored as plain so staff can read
// them in the CRM. Either can be changed later.
const SECRET_HINT = /KEY|SECRET|PASSWORD|TOKEN|PRIVATE|PIN|AUTH|CREDENTIAL/;
const PLAIN_HINT =
  /(_ENABLED|_MODE|_IST|_MINUTE|_HOURS|_DAYS|_SIZE|_PER_RUN|_MS|_MODEL|_ORIGIN|_URL|_NAME|_EMAIL|_HOST|_PORT|_SECURE|_ROUTE|_CONCURRENT|_FOLLOWUPS|_EXPIRY|_EXPIRY_MINUTES|_RETENTION_DAYS)$/;
const looksSecret = (name) => SECRET_HINT.test(name) || !PLAIN_HINT.test(name);

const parsed = dotenv.parse(fs.readFileSync(file));
const store = createAquaEnvStore({ model: AquaEnv });

await mongoose.connect(process.env.DB_URL);
try {
  const stored = new Set(
    (await AquaEnv.find({}).select("key").lean()).map((d) => d.key),
  );
  const plan = { add: [], replace: [], keep: [], reserved: [], invalid: [] };
  for (const [name, value] of Object.entries(parsed)) {
    if (isReservedKey(name)) plan.reserved.push(name);
    else if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name) || value === "")
      plan.invalid.push(name);
    else if (!stored.has(name)) plan.add.push(name);
    else if (overwrite) plan.replace.push(name);
    else plan.keep.push(name);
  }
  const show = (label, names) =>
    console.log(`${label} (${names.length}): ${names.join(", ") || "-"}`);
  show("Add", plan.add);
  show("Replace", plan.replace);
  show("Already stored, kept", plan.keep);
  show("Server-only, not copied", plan.reserved);
  show("Empty or invalid name, skipped", plan.invalid);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write.");
  } else {
    if (!process.env[ENCRYPTION_KEY_NAME]) {
      console.error(`${ENCRYPTION_KEY_NAME} is required to write values.`);
      process.exitCode = 1;
    } else {
      for (const name of [...plan.add, ...plan.replace]) {
        await store.set(name, {
          value: parsed[name],
          ...(plan.add.includes(name) ? { secret: looksSecret(name) } : {}),
        });
      }
      const check = createAquaEnvStore({
        model: AquaEnv,
        env: {
          [ENCRYPTION_KEY_NAME]: process.env[ENCRYPTION_KEY_NAME],
        },
      });
      const summary = await check.load();
      console.log(
        `\nWrote ${plan.add.length + plan.replace.length}. Read-back: ${summary.loaded.length} decrypt, ${summary.failed.length} fail${summary.failed.length ? ` (${summary.failed.join(", ")})` : ""}.`,
      );
      if (summary.failed.length) process.exitCode = 1;
    }
  }
} finally {
  await mongoose.disconnect();
}
