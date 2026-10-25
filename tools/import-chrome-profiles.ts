// Imports Google Chrome profiles into the everyday ArcMod. Each Chrome profile becomes its own ArcMod profile
// (cookies, site storage, extensions, history, passwords, bookmarks) with a Space of the same name, so its sites stay
// signed in. Its bookmarks are pinned in that Space as a "Bookmarks" folder that mirrors Chrome's folders.
//   bun tools/import-chrome-profiles.ts [--list [--json]] [--choose] [--profile <Chrome profile folder>]...
//                                       [--quit-arcmod] [--relaunch [--app <ArcMod.app>]]
//   bun tools/import-chrome-profiles.ts --repair [--quit-arcmod] [--relaunch [--app <ArcMod.app>]]
// Without --profile it imports every Chrome profile that isn't imported yet; --choose first asks which of them, in a
// macOS list dialog (what ArcMod → Import from Chrome… runs). Each new Space gets an Arc icon no other Space uses.
// --quit-arcmod and --relaunch work as in tools/import-arc-data.ts. Chrome has to be closed. Chrome is only read;
// ArcMod's sidebar and profile list are backed up next to themselves before they change.
// Chrome encrypts secrets with its Keychain item "Chrome Safe Storage", the everyday ArcMod with "Arc Safe Storage"
// (tools/oscrypt.ts); every database in the profile is re-encrypted, Network/Cookies included. Test builds keep
// their data under Chromium's test key, so real sessions are never imported into them. --repair re-encrypts the
// Chrome values still left in profiles imported before 2026-10-25, when Network/ was skipped.
// A Space names its profile by folder and machine: {"custom": {"_0": {"directoryBasename", "machineID"}}}, with
// machineID from ArcMod's defaults (checked against Arc 1.168.0: tabs in that Space use that Chromium profile).
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionIdentity } from "./agent-session";
import { flagValue } from "./build-paths";
import { arcSafeStoragePassword, databases } from "./keychain-profile";
import { betweenKeys, recryptDatabase, recryptJsonText, type Recrypter } from "./oscrypt";

const support = join(process.env.HOME ?? "", "Library/Application Support");
export const CHROME_ROOT = join(support, "Google/Chrome");
const CHROME_PROCESS = "Google Chrome[.]app/Contents/MacOS/Google Chrome( |$)";
// Tab sessions, caches and Google sync/push identities that belong to Chrome; ArcMod rebuilds the caches.
const skip = new Set([
  "LOCK", "LOG", "LOG.old", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Code Cache", "DawnCache", "GrShaderCache",
  "ShaderCache", "Sessions", "Session Storage", "Sync Data", "trusted_vault.pb", "passkey_enclave_state", "GCM Store",
]);

const run = (command: string, args: readonly string[]): string => {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
};

const isRunning = (pattern: string): boolean => Bun.spawnSync(["pgrep", "-f", pattern]).exitCode === 0;

const waitUntilClosed = async (pattern: string, message: string): Promise<void> => {
  if (!isRunning(pattern)) return;
  console.log(message);
  while (isRunning(pattern)) await Bun.sleep(500);
};

// Chrome's Keychain password, only held in memory: choose "Allow", not "Always Allow".
const chromeSafeStoragePassword = (): string => run("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"]).trim();

// Re-encrypts every database and preference file under `folder`; returns how many values moved.
export const recryptProfile = (folder: string, crypto: Recrypter): number => {
  let moved = 0;
  for (const path of databases(folder)) {
    for (const [column, tally] of recryptDatabase(path, crypto)) {
      if (tally.converted > 0) console.log(`  ${path.slice(folder.length + 1)}: ${column} ${tally.converted}`);
      moved += tally.converted;
    }
  }
  for (const path of ["Preferences", "Secure Preferences"].map((file) => join(folder, file))) {
    if (!existsSync(path)) continue;
    const preferences = recryptJsonText(readFileSync(path, "utf8"), crypto);
    if (preferences.converted > 0) writeFileSync(path, preferences.text, { mode: 0o600 });
    moved += preferences.converted;
  }
  return moved;
};

// Copies a closed Chrome profile into the new folder `staging` and moves its secrets to ArcMod's key.
const copyProfile = (source: string, staging: string, crypto: Recrypter): void => {
  run("mkdir", ["-m", "700", staging]);
  for (const entry of readdirSync(source).filter((name) => !skip.has(name))) run("cp", ["-cRp", join(source, entry), join(staging, entry)]);
  console.log(`  ${recryptProfile(staging, crypto)} values re-encrypted for ArcMod`);
};

export interface ChromeProfile {
  readonly directory: string;
  readonly name: string;
  readonly avatar: string | undefined;
}

interface BookmarkNode {
  readonly type?: string;
  readonly name?: string;
  readonly url?: string;
  readonly children?: readonly BookmarkNode[];
}

export interface SidebarItem {
  readonly id: string;
  readonly parentID: string | null;
  readonly data: unknown;
  readonly childrenIds: string[];
  readonly title: string | null;
  readonly createdAt: number;
  readonly isUnread: false;
  readonly originatingDevice: string;
}

type Json = Record<string, unknown>;

const readJson = (path: string): Json => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      throw new Error(`macOS didn't let this app read ${path}. Give Terminal Full Disk Access (System Settings → Privacy & Security), then try again.`);
    }
    throw error;
  }
};

// Chrome's profiles in its own order, from its Local State. Profiles that share a name are told apart by their
// account, as Chrome's own profile menu does ("Darshan (name@example.com)").
export const chromeProfiles = (localState: Json): readonly ChromeProfile[] => {
  type Entry = { name?: unknown; avatar_icon?: unknown; user_name?: unknown };
  const profile = (localState.profile ?? {}) as { info_cache?: Record<string, Entry>; profiles_order?: unknown };
  const cache = profile.info_cache ?? {};
  const order = Array.isArray(profile.profiles_order) ? profile.profiles_order.filter((dir): dir is string => typeof dir === "string") : [];
  const profiles = [...new Set([...order, ...Object.keys(cache)])].filter((dir) => cache[dir] !== undefined).map((directory) => {
    const entry = cache[directory]!;
    return {
      directory,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : directory,
      account: typeof entry.user_name === "string" && entry.user_name.trim() ? entry.user_name.trim() : undefined,
      avatar: typeof entry.avatar_icon === "string" ? entry.avatar_icon : undefined,
    };
  });
  const shared = (name: string): boolean => profiles.filter((other) => other.name === name).length > 1;
  return profiles.map(({ directory, name, account, avatar }) => ({
    directory,
    name: shared(name) ? `${name} (${account ?? directory})` : name,
    avatar,
  }));
};

export const importedSpaceID = (chromeDirectory: string): string =>
  `arcmod.chrome-import.${chromeDirectory.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;

// The first "Profile N" folder name that neither ArcMod's profile list nor its data folder uses.
export const nextProfileDirectory = (taken: (name: string) => boolean): string => {
  for (let index = 1; ; index++) if (!taken(`Profile ${index}`)) return `Profile ${index}`;
};

// Arc's timestamps are seconds since 2001-01-01 (Foundation's reference date).
const arcNow = (): number => Date.now() / 1000 - 978307200;

const ROOT_TITLES: readonly (readonly [string, string])[] = [["bookmark_bar", "Bookmarks Bar"], ["other", "Other Bookmarks"], ["synced", "Mobile Bookmarks"]];

// Chrome's "Bookmarks" (and, with account bookmarks, "AccountBookmarks") as one tree per root folder.
export const bookmarkRoots = (files: readonly Json[]): readonly { readonly title: string; readonly children: readonly BookmarkNode[] }[] =>
  ROOT_TITLES.map(([key, title]) => ({
    title,
    children: files.flatMap((file) => ((file.roots as Record<string, BookmarkNode> | undefined)?.[key]?.children ?? [])),
  })).filter((root) => root.children.length > 0);

// Sidebar items for a pinned "Bookmarks" folder under `parentID`: folders as Arc folders, links as pinned tabs.
// Bookmarklets (javascript: links) can't be tabs and are left out. Returns the folder's ID, or undefined if empty.
export const bookmarkItems = (
  roots: ReturnType<typeof bookmarkRoots>, parentID: string, device: string, now = arcNow(), newID: () => string = randomUUID,
): { readonly folderID: string | undefined; readonly items: readonly SidebarItem[]; readonly links: number } => {
  const items: SidebarItem[] = [];
  let links = 0;
  const item = (parent: string, title: string, data: unknown): SidebarItem => {
    const created = { id: newID(), parentID: parent, data, childrenIds: [], title, createdAt: now, isUnread: false as const, originatingDevice: device };
    items.push(created);
    return created;
  };
  const add = (parent: SidebarItem, node: BookmarkNode): void => {
    if (node.type === "folder") {
      const folder = item(parent.id, node.name || "Folder", { list: {} });
      (node.children ?? []).forEach((child) => add(folder, child));
      if (folder.childrenIds.length === 0) items.splice(items.indexOf(folder), 1);
      else parent.childrenIds.push(folder.id);
    } else if (node.type === "url" && node.url && !node.url.toLowerCase().startsWith("javascript:")) {
      parent.childrenIds.push(item(parent.id, node.name || node.url, { tab: { savedURL: node.url, savedTitle: node.name || node.url } }).id);
      links++;
    }
  };
  const top = item(parentID, "Bookmarks", { list: {} });
  roots.forEach((root) => add(top, { type: "folder", name: root.title, children: root.children }));
  if (top.childrenIds.length === 0) return { folderID: undefined, items: [], links };
  return { folderID: top.id, items, links };
};

// The sidebar container that holds Spaces and their items.
const spacesContainer = (sidebar: Json): Json => {
  const main = ((sidebar.sidebar as { containers?: Json[] } | undefined)?.containers ?? []).find((container) => Array.isArray(container.spaces));
  if (!main || !Array.isArray(main.items)) throw new Error("ArcMod's sidebar has an unexpected format");
  return main;
};

// Replaces `path` in one step, so a crash leaves either the old or the new file.
const writeAtomically = (path: string, value: unknown): void => {
  writeFileSync(`${path}.arcmod-tmp`, JSON.stringify(value));
  renameSync(`${path}.arcmod-tmp`, path);
};

// Arc's built-in Space icons (Arc 1.168.0), in the order imported Spaces get them; Arc's own first Space uses planet.
export const SPACE_ICONS = [
  "people", "terminal", "layers", "albums", "calendar", "shapes", "airplane", "musicalNote", "bonfire", "cloudOutline",
  "construction", "restaurant", "barbell", "baseball", "colorPallete", "fileTrayFull", "chatBubbleEllipses",
  "notifications", "receipt", "thumbsUp", "medical", "bandage", "triangle", "square", "ellipse", "checkbox", "search",
  "planet",
] as const;

// The first icon no Space uses yet; once all are taken, they repeat.
export const nextSpaceIcon = (used: readonly string[]): string =>
  SPACE_ICONS.find((icon) => !used.includes(icon)) ?? SPACE_ICONS[used.length % SPACE_ICONS.length]!;

const usedSpaceIcons = (main: Json): string[] => (main.spaces as unknown[])
  .map((space) => ((space as { customInfo?: { iconType?: { icon?: unknown } } } | null)?.customInfo?.iconType?.icon))
  .filter((icon): icon is string => typeof icon === "string");

// Adds a Space bound to ArcMod profile `directory`, with `bookmarks` pinned, to Arc's StorableSidebar.json data.
export const addSpace = (
  sidebar: Json, space: { readonly id: string; readonly title: string; readonly directory: string; readonly machineID: string },
  bookmarks: (pinnedID: string) => ReturnType<typeof bookmarkItems>, now = arcNow(), newID: () => string = randomUUID,
): void => {
  const main = spacesContainer(sidebar);
  const pinnedID = newID();
  const unpinnedID = newID();
  const pinned = bookmarks(pinnedID);
  const container = (id: string, childrenIds: string[]): SidebarItem => ({
    id, parentID: null, data: { itemContainer: { containerType: { spaceItems: { _0: space.id } } } }, childrenIds,
    title: null, createdAt: now, isUnread: false, originatingDevice: space.machineID,
  });
  (main.items as unknown[]).push(
    pinnedID, container(pinnedID, pinned.folderID ? [pinned.folderID] : []),
    unpinnedID, container(unpinnedID, []),
    ...pinned.items.flatMap((item) => [item.id, item]),
  );
  (main.spaces as unknown[]).push(space.id, {
    id: space.id,
    title: space.title,
    profile: { custom: { _0: { directoryBasename: space.directory, machineID: space.machineID } } },
    customInfo: { iconType: { icon: nextSpaceIcon(usedSpaceIcons(main)) } },
    newContainerIDs: [{ unpinned: { _0: { shared: {} } } }, unpinnedID, { pinned: {} }, pinnedID],
    containerIDs: ["pinned", pinnedID, "unpinned", unpinnedID],
  });
};

const spaceIDs = (sidebar: Json): ReadonlySet<string> => new Set(
  ((sidebar.sidebar as { containers?: Json[] } | undefined)?.containers ?? [])
    .flatMap((container) => (Array.isArray(container.spaces) ? container.spaces : []))
    .filter((entry): entry is string => typeof entry === "string"),
);

const parseArgs = (args: readonly string[]): { readonly flags: ReadonlySet<string>; readonly profiles: readonly string[] } => {
  const flags = new Set<string>();
  const profiles: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--profile" || arg === "--app") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      if (arg === "--profile") profiles.push(value);
    } else if (arg === "--validation") {
      throw new Error("test builds keep their data under Chromium's fixed test key; import only into the everyday ArcMod");
    } else if (["--list", "--json", "--choose", "--repair", "--quit-arcmod", "--relaunch"].includes(arg)) flags.add(arg);
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return { flags, profiles };
};

// ArcMod profile folders that Spaces made by this import use.
const importedProfileFolders = (sidebar: Json): readonly string[] =>
  ((spacesContainer(sidebar).spaces as unknown[])
    .filter((space): space is { id: string; profile?: { custom?: { _0?: { directoryBasename?: unknown } } } } =>
      typeof space === "object" && space !== null && String((space as { id?: unknown }).id).startsWith("arcmod.chrome-import."))
    .map((space) => space.profile?.custom?._0?.directoryBasename)
    .filter((folder): folder is string => typeof folder === "string"));

// Shows macOS's list dialog with every label selected; returns the labels left selected (none when cancelled).
export type ChooseFromList = (labels: readonly string[], prompt: string) => readonly string[];

const chooseFromList: ChooseFromList = (labels, prompt) => {
  const script = `function run(argv) {
    const app = Application.currentApplication();
    app.includeStandardAdditions = true;
    app.activate();
    const labels = JSON.parse(argv[0]);
    return JSON.stringify(app.chooseFromList(labels, {
      withTitle: "Import from Chrome", withPrompt: argv[1], defaultItems: labels,
      multipleSelectionsAllowed: true, okButtonName: "Import", cancelButtonName: "Cancel",
    }));
  }`;
  const result = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", script, JSON.stringify(labels), prompt], { stdout: "pipe", stderr: "pipe" });
  const chosen: unknown = result.success ? JSON.parse(result.stdout.toString().trim() || "false") : false;
  return Array.isArray(chosen) ? chosen.filter((label): label is string => typeof label === "string") : [];
};

// Asks which of the profiles not imported yet to import, all of them selected to begin with.
export const chooseProfiles = (pending: readonly ChromeProfile[], imported: number, ask: ChooseFromList = chooseFromList): readonly ChromeProfile[] => {
  const labels = pending.map((profile, index) =>
    pending.findIndex((other) => other.name === profile.name) === index ? profile.name : `${profile.name} (${profile.directory})`);
  const prompt = `Each profile you pick becomes an ArcMod profile with its own Space.${imported > 0 ? ` ${imported} imported before aren't listed.` : ""}`;
  const chosen = new Set(ask(labels, prompt));
  return pending.filter((_, index) => chosen.has(labels[index]!));
};

const main = async (args: readonly string[]): Promise<void> => {
  const { flags, profiles: listed } = parseArgs(args);
  let requested = listed;
  const session = sessionIdentity();
  const mod = `(^|/)${session.appName}[.]app/Contents/MacOS/Arc( |$)`;
  const sidebarPath = join(support, session.appName, "StorableSidebar.json");
  if (flags.has("--repair")) {
    if (flags.has("--quit-arcmod")) {
      if (isRunning(mod)) Bun.spawnSync(["osascript", "-e", `tell application id "${session.bundleId}" to quit`]);
      await waitUntilClosed(mod, `Waiting for ${session.appName} to quit (confirm in ${session.appName} if it asks)…`);
    }
    if (isRunning(mod)) throw new Error(`quit ${session.appName} first`);
    const crypto = betweenKeys(chromeSafeStoragePassword(), arcSafeStoragePassword());
    for (const folder of importedProfileFolders(readJson(sidebarPath))) {
      console.log(`• ${folder}`);
      console.log(`  ${recryptProfile(join(support, session.appName, "User Data", folder), crypto)} values re-encrypted for ArcMod`);
    }
    return;
  }
  const all = chromeProfiles(readJson(join(CHROME_ROOT, "Local State")));
  const imported = (): ReadonlySet<string> => (existsSync(sidebarPath) ? spaceIDs(readJson(sidebarPath)) : new Set<string>());
  if (flags.has("--list")) {
    const existing = imported();
    const rows = all.map(({ directory, name }) => ({ directory, name, imported: existing.has(importedSpaceID(directory)) }));
    if (flags.has("--json")) console.log(JSON.stringify(rows));
    else rows.forEach((row) => console.log(`${row.directory}\t${row.name}${row.imported ? "\t(imported)" : ""}`));
    return;
  }
  const unknown = requested.filter((dir) => !all.some((profile) => profile.directory === dir));
  if (unknown.length > 0) throw new Error(`no Chrome profile folder ${unknown.join(", ")} (see --list)`);
  // Before ArcMod is asked to quit, so cancelling leaves it open.
  if (flags.has("--choose")) {
    const existing = imported();
    const pending = all.filter((profile) => (requested.length === 0 || requested.includes(profile.directory)) && !existing.has(importedSpaceID(profile.directory)));
    if (pending.length === 0) {
      console.log("Every Chrome profile is in ArcMod already; delete a Space in ArcMod to import its profile again.");
      return;
    }
    requested = chooseProfiles(pending, all.length - pending.length).map((profile) => profile.directory);
    if (requested.length === 0) {
      console.log("No profiles chosen.");
      return;
    }
    console.log(`chosen: ${requested.join(", ")}`);
  }

  const modRoot = join(support, session.appName);
  if (!existsSync(join(modRoot, "StorableSidebar.json")) || !existsSync(join(modRoot, "User Data/Local State"))) {
    throw new Error(`launch ${session.appName} once before importing`);
  }

  if (flags.has("--quit-arcmod")) {
    if (isRunning(mod)) Bun.spawnSync(["osascript", "-e", `tell application id "${session.bundleId}" to quit`]);
    await waitUntilClosed(mod, `Waiting for ${session.appName} to quit (confirm in ${session.appName} if it asks)…`);
    await waitUntilClosed(CHROME_PROCESS, "Quit Chrome to continue: its profiles have to be closed while they're copied.");
  }
  if (isRunning(CHROME_PROCESS)) throw new Error("quit Chrome first so its profiles are consistent");
  if (isRunning(mod)) throw new Error(`quit ${session.appName} first`);

  importChromeProfiles({
    chromeRoot: CHROME_ROOT,
    profiles: all.filter((profile) => requested.length === 0 || requested.includes(profile.directory)),
    modRoot,
    session,
    crypto: () => betweenKeys(chromeSafeStoragePassword(), arcSafeStoragePassword()),
  });
};

export interface ImportOptions {
  readonly chromeRoot: string;
  readonly profiles: readonly ChromeProfile[];
  readonly modRoot: string; // ~/Library/Application Support/<ArcMod's app name>
  readonly session: { readonly appName: string; readonly bundleId: string };
  readonly crypto: () => Recrypter; // Chrome's key to ArcMod's; asked for only when there is something to import
}

// Imports `profiles` from closed Chrome data into a closed ArcMod.
export const importChromeProfiles = ({ chromeRoot, profiles, modRoot, session, crypto: makeCrypto }: ImportOptions): void => {
  const userData = join(modRoot, "User Data");
  const sidebarPath = join(modRoot, "StorableSidebar.json");
  const localStatePath = join(userData, "Local State");
  const sidebar = readJson(sidebarPath);
  const localState = readJson(localStatePath);
  spacesContainer(sidebar); // fails before anything is copied
  const existing = spaceIDs(sidebar);
  const pending = profiles.filter((profile) => !existing.has(importedSpaceID(profile.directory)));
  profiles.filter((profile) => !pending.includes(profile)).forEach((profile) =>
    console.log(`skipping ${profile.name} (${profile.directory}): already imported; delete its Space in ${session.appName} to import it again`));
  if (pending.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  const machineID = Bun.spawnSync(["defaults", "read", session.bundleId, "machineID"]).stdout.toString().trim();
  if (!machineID) throw new Error(`no machineID in ${session.bundleId}'s defaults; launch ${session.appName} once first`);
  const crypto = makeCrypto();
  const profileState = localState.profile as { info_cache: Record<string, Json>; profiles_order?: string[] };
  const template = profileState.info_cache.Default ?? {};
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const imported: string[] = [];
  for (const path of [sidebarPath, localStatePath]) copyFileSync(path, `${path}.pre-chrome-import-${stamp}`);

  // Saved after each profile, so one that fails leaves the ones before it imported.
  for (const profile of pending) {
    const source = join(chromeRoot, profile.directory);
    const directory = nextProfileDirectory((name) => name in profileState.info_cache || existsSync(join(userData, name)));
    console.log(`\n• ${profile.name} (${profile.directory}) → ${directory}`);
    const staging = join(userData, `${directory}.import-${stamp}`);
    copyProfile(source, staging, crypto);
    renameSync(staging, join(userData, directory));

    profileState.info_cache[directory] = {
      ...template, name: profile.name, is_using_default_name: false, ...(profile.avatar ? { avatar_icon: profile.avatar } : {}),
      gaia_id: "", user_name: "", is_consented_primary_account: false, active_time: Date.now() / 1000,
    };
    profileState.profiles_order = [...new Set([...(profileState.profiles_order ?? []), directory])];

    const bookmarkFiles = ["Bookmarks", "AccountBookmarks"].map((file) => join(source, file)).filter(existsSync).map(readJson);
    let links = 0;
    addSpace(sidebar, { id: importedSpaceID(profile.directory), title: profile.name, directory, machineID }, (pinnedID) => {
      const result = bookmarkItems(bookmarkRoots(bookmarkFiles), pinnedID, machineID);
      links = result.links;
      return result;
    });
    // The Space first: if the second write fails, a rerun sees the Space and doesn't copy the profile again.
    writeAtomically(sidebarPath, sidebar);
    writeAtomically(localStatePath, localState);
    console.log(`Space "${profile.name}" with ${links} pinned bookmarks`);
    imported.push(profile.name);
  }
  console.log(`\nimported ${imported.join(", ")} into ${session.appName}; previous sidebar and profile list kept as *.pre-chrome-import-${stamp}`);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    await main(args);
  } catch (error) {
    console.error(`\nImport stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    // From the ArcMod menu: reopen ArcMod (the copy that ran the import, --app) whether or not the import worked.
    const session = sessionIdentity();
    if (args.includes("--relaunch") && !isRunning(`(^|/)${session.appName}[.]app/Contents/MacOS/Arc( |$)`)) {
      const app = flagValue(args, "--app");
      Bun.spawnSync([join(import.meta.dir, "run-mod.sh"), ...(app ? ["--app", app] : [])], { stdout: "inherit", stderr: "inherit" });
    }
  }
}
