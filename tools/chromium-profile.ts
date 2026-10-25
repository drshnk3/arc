// Copies a Chromium profile directory into ArcMod, re-encrypting its secrets for ArcMod's key. Used by
// tools/import-arc-data.ts (stock Arc) and tools/import-chrome-profiles.ts (Google Chrome).
// Chromium on macOS encrypts secrets (OSCrypt v10) with a key derived from a Keychain password ("Arc Safe Storage",
// "Chrome Safe Storage"); ArcMod launches with --use-mock-keychain, so every value is re-encrypted for the mock key.
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const v10 = Buffer.from("v10");
const iv = Buffer.alloc(16, 0x20);
const deriveKey = (password: string): Buffer => pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");

export const MOCK_KEYCHAIN_PASSWORD = "mock_password";

// Transient caches, tab sessions, and Google sync/push identities that belong to the source browser.
export const excluded = new Set([
  "LOCK", "LOG", "LOG.old", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "Sessions", "Session Storage", "Sync Data", "trusted_vault.pb", "passkey_enclave_state", "GCM Store",
]);

export interface Recrypter {
  readonly recrypt: (value: Uint8Array) => Buffer | undefined;
}

export const recrypter = (sourcePassword: string, targetPassword: string): Recrypter => {
  const sourceKey = deriveKey(sourcePassword);
  const targetKey = deriveKey(targetPassword);
  return {
    recrypt: (value) => {
      const body = Buffer.from(value);
      if (body.length < 19 || (body.length - 3) % 16 !== 0 || !body.subarray(0, 3).equals(v10)) return undefined;
      try {
        const decipher = createDecipheriv("aes-128-cbc", sourceKey, iv);
        const plain = Buffer.concat([decipher.update(body.subarray(3)), decipher.final()]);
        const cipher = createCipheriv("aes-128-cbc", targetKey, iv);
        return Buffer.concat([v10, cipher.update(plain), cipher.final()]);
      } catch {
        return undefined;
      }
    },
  };
};

export const run = (command: string, args: readonly string[]): string => {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
};

export const isRunning = (pattern: string): boolean => Bun.spawnSync(["pgrep", "-f", pattern]).exitCode === 0;

export const waitUntilClosed = async (pattern: string, message: string): Promise<void> => {
  if (!isRunning(pattern)) return;
  console.log(message);
  while (isRunning(pattern)) await Bun.sleep(500);
};

// A Keychain password the source browser keeps its key in. It is only held in memory: choose "Allow", not
// "Always Allow".
export const keychainPassword = (service: string, account: string): string =>
  run("security", ["find-generic-password", "-w", "-s", service, "-a", account]).trim();

const isSqlite = (path: string): boolean => {
  if (!statSync(path).isFile()) return false;
  const header = Buffer.alloc(16);
  const fd = openSync(path, "r");
  try {
    return readSync(fd, header, 0, 16, 0) === 16 && header.toString("latin1") === "SQLite format 3\0";
  } finally {
    closeSync(fd);
  }
};

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const encryptedRows = (db: Database, table: string, column: string): { id: number; value: Uint8Array }[] => {
  try {
    return db.query(`select rowid as id, ${quote(column)} as value from ${quote(table)}
      where typeof(${quote(column)}) = 'blob' and substr(${quote(column)}, 1, 3) = x'763130'`).all() as { id: number; value: Uint8Array }[];
  } catch {
    return []; // WITHOUT ROWID tables do not hold OSCrypt values.
  }
};

// Re-encrypts every v10 BLOB in a database; returns counts keyed by table.column.
const recryptDatabase = (path: string, crypto: Recrypter): Map<string, { converted: number; failed: number }> => {
  const counts = new Map<string, { converted: number; failed: number }>();
  const db = new Database(path);
  try {
    const tables = db.query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all() as { name: string }[];
    db.transaction(() => {
      for (const { name: table } of tables) {
        const columns = db.query(`pragma table_info(${quote(table)})`).all() as { name: string }[];
        for (const { name: column } of columns) {
          const rows = encryptedRows(db, table, column);
          if (rows.length === 0) continue;
          const update = db.query(`update ${quote(table)} set ${quote(column)} = ? where rowid = ?`);
          const tally = { converted: 0, failed: 0 };
          for (const row of rows) {
            const next = crypto.recrypt(row.value);
            if (next === undefined) tally.failed++;
            else {
              update.run(next, row.id);
              tally.converted++;
            }
          }
          counts.set(`${table}.${column}`, tally);
        }
      }
    })();
  } finally {
    db.close();
  }
  return counts;
};

// Preference files store OSCrypt values as base64 strings: password reuse hashes and
// the encrypted tracked-pref hashes Chromium checks before trusting Secure Preferences.
const recryptJson = (value: unknown, crypto: Recrypter): { readonly value: unknown; readonly converted: number } => {
  if (typeof value === "string" && value.startsWith("djEw")) {
    const next = crypto.recrypt(Buffer.from(value, "base64"));
    return next === undefined ? { value, converted: 0 } : { value: next.toString("base64"), converted: 1 };
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => recryptJson(item, crypto));
    return { value: items.map((item) => item.value), converted: items.reduce((sum, item) => sum + item.converted, 0) };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [key, recryptJson(item, crypto)] as const);
    return {
      value: Object.fromEntries(entries.map(([key, item]) => [key, item.value])),
      converted: entries.reduce((sum, [, item]) => sum + item.converted, 0),
    };
  }
  return { value, converted: 0 };
};

// Copies `source` (a closed profile) into the new directory `staging` and re-encrypts it; returns the
// table.column names with values that didn't decrypt, which are left unchanged.
export const copyProfile = (source: string, staging: string, crypto: Recrypter, skip: ReadonlySet<string> = excluded): readonly string[] => {
  run("mkdir", ["-m", "700", staging]);
  const entries = readdirSync(source).filter((entry) => !skip.has(entry));
  for (const entry of entries) run("cp", ["-cRp", join(source, entry), join(staging, entry)]);

  const failures = readdirSync(staging)
    .map((entry) => join(staging, entry))
    .filter((path) => !path.endsWith("-journal") && !path.endsWith("-wal") && isSqlite(path))
    .flatMap((path) => [...recryptDatabase(path, crypto)].map(([column, tally]) => {
      const name = `${path.slice(staging.length + 1)}: ${column}`;
      console.log(`${name} converted=${tally.converted}${tally.failed ? ` failed=${tally.failed}` : ""}`);
      return tally.failed > 0 ? name : undefined;
    }))
    .filter((name) => name !== undefined);

  for (const file of ["Preferences", "Secure Preferences"]) {
    const path = join(staging, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // Absent in a profile that was never opened.
    }
    const preferences = recryptJson(parsed, crypto);
    if (preferences.converted > 0) writeFileSync(path, JSON.stringify(preferences.value));
    console.log(`${file}: converted=${preferences.converted}`);
  }
  if (failures.length > 0) console.warn(`values that did not decrypt were left unchanged: ${failures.join(", ")}`);
  return failures;
};
