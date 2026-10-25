// Import stock Arc's Chromium profile (logins, site storage, extensions, history,
// permissions) into an ArcMod session so sites stay signed in.
//   bun tools/import-arc-data.ts [--validation] [--staging-only] [--quit-arcmod] [--relaunch]
// --quit-arcmod asks ArcMod to quit after the checks pass and waits for you to quit Arc, instead of failing
// while either runs; --relaunch reopens ArcMod afterwards, even if the import failed. ArcMod's
// "Import from Arc…" menu item runs it with both in Terminal.
// Arc encrypts secrets with its "Arc Safe Storage" Keychain password; tools/chromium-profile.ts re-encrypts
// them for ArcMod's mock keychain. The source profile is only read. The previous mod profile is kept as a backup.
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { sessionIdentity } from "./agent-session";
import { copyProfile, isRunning, keychainPassword, MOCK_KEYCHAIN_PASSWORD, recrypter, waitUntilClosed } from "./chromium-profile";

const main = async (args: readonly string[]): Promise<void> => {
  const flags = new Set(["--validation", "--staging-only", "--quit-arcmod", "--relaunch"]);
  const unknown = args.filter((arg) => !flags.has(arg));
  if (unknown.length > 0) throw new Error(`unrecognized argument: ${unknown.join(" ")}`);
  const session = sessionIdentity(args.includes("--validation"));
  const support = join(process.env.HOME ?? "", "Library/Application Support");
  const source = join(support, "Arc/User Data/Default");
  const targetRoot = join(support, session.appName, "User Data");
  const target = join(targetRoot, "Default");
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const staging = join(targetRoot, `Default.import-${stamp}`);

  if (!existsSync(source)) throw new Error(`missing Arc profile: ${source}`);
  if (!existsSync(targetRoot)) throw new Error(`launch ${session.appName} once before importing: ${targetRoot}`);
  const arc = "^/Applications/Arc[.]app/Contents/MacOS/Arc( |$)";
  const mod = `(^|/)${session.appName}[.]app/Contents/MacOS/Arc( |$)`;
  if (args.includes("--quit-arcmod")) {
    if (isRunning(mod)) Bun.spawnSync(["osascript", "-e", `tell application id "${session.bundleId}" to quit`]);
    await waitUntilClosed(mod, `Waiting for ${session.appName} to quit (confirm in ${session.appName} if it asks)…`);
    await waitUntilClosed(arc, "Quit Arc to continue: its profile has to be closed while it's copied.");
  }
  if (isRunning(arc)) throw new Error("quit Arc first so its profile is consistent");
  if (isRunning(mod)) throw new Error(`quit ${session.appName} first`);

  copyProfile(source, staging, recrypter(keychainPassword("Arc Safe Storage", "Arc"), MOCK_KEYCHAIN_PASSWORD));

  if (args.includes("--staging-only")) {
    console.log(`staged ${staging}`);
    return;
  }
  const backup = join(targetRoot, `Default.pre-import-${stamp}`);
  if (existsSync(target)) renameSync(target, backup);
  renameSync(staging, target);
  console.log(`imported Arc profile into ${target}${existsSync(backup) ? `\nprevious profile kept at ${backup}` : ""}`);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    await main(args);
  } catch (error) {
    console.error(`\nImport stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    // From the ArcMod menu: reopen ArcMod whether or not the import worked.
    const validation = args.includes("--validation");
    const session = sessionIdentity(validation);
    if (args.includes("--relaunch") && !isRunning(`(^|/)${session.appName}[.]app/Contents/MacOS/Arc( |$)`)) {
      Bun.spawnSync([join(import.meta.dir, "run-mod.sh"), ...(validation ? ["--validation"] : [])], { stdout: "inherit", stderr: "inherit" });
    }
  }
}
