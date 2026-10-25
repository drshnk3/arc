// Where builds go. tools/build-mod.ts builds into a staging bundle and swaps it in only when the build has
// succeeded, so a failed build leaves the previous app in place. tools/update.ts builds with --stage-only
// while ArcMod keeps running, then swaps once ArcMod has quit.
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sessionIdentity } from "./agent-session";

const root = join(import.meta.dir, "..");

// The normal ArcMod is installed in /Applications (ARCMOD_INSTALL_DIR overrides it, as tools/run-mod.sh does) so
// Finder, Launchpad, Spotlight and the Dock find it; test and agent builds stay in build/.
export const installDir = (): string => process.env.ARCMOD_INSTALL_DIR || "/Applications";
export const finalApp = (appName: string): string =>
  appName === sessionIdentity().appName ? join(installDir(), `${appName}.app`) : join(root, `build/${appName}.app`);
export const stagedApp = (appName: string): string => join(root, `build/.${appName}.staging.app`);

// Processes running the app's main executable, compared as strings (paths may contain regex characters).
export const runningApp = (appName: string): readonly string[] => {
  const executables = [finalApp(appName), join(root, `build/${appName}.app`)].map((app) => join(app, "Contents/MacOS/Arc"));
  const processes = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString();
  return processes.split("\n").filter((line) => {
    const command = line.trim().replace(/^\d+\s+/, "");
    return executables.some((executable) => command === executable || command.startsWith(`${executable} `));
  });
};

export const swapInStagedApp = (appName: string): void => {
  const staged = stagedApp(appName);
  const final = finalApp(appName);
  if (!existsSync(staged)) throw new Error(`no staged build at ${staged}`);
  // Only a complete build is swapped in: it must carry a valid signature.
  if (!Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", staged]).success) throw new Error(`the staged build at ${staged} isn't complete`);
  if (runningApp(appName).length > 0) throw new Error(`refusing to replace running ${appName}`);
  const previous = `${stagedApp(appName)}.previous`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(final)) move(final, previous);
  try {
    move(staged, final);
  } catch (error) {
    // Put the previous app back, so a failed install never leaves no ArcMod at all.
    rmSync(final, { recursive: true, force: true });
    if (existsSync(previous)) move(previous, final);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
  // Builds from before ArcMod moved to the install folder: one copy, so LaunchServices has one app to open.
  const legacy = join(root, `build/${appName}.app`);
  if (legacy !== final) rmSync(legacy, { recursive: true, force: true });
};

// The install folder can be on another volume than the checkout; rename(2) can't cross volumes.
const move = (from: string, to: string): void => {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    if (!Bun.spawnSync(["ditto", from, to]).success) throw new Error(`couldn't copy ${from} to ${to}`);
    rmSync(from, { recursive: true, force: true });
  }
};
