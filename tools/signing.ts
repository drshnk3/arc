// Optional signing with your own Apple Developer certificate and provisioning profile instead of ad hoc, so the
// normal ArcMod can keep passkeys on this Mac (Touch ID) and, if Apple grants your team the browser passkey
// entitlement, use iCloud Keychain passkeys. Configured in ~/.arcmod/signing.json (see README → Passkeys):
//   { "identity": "Developer ID Application: Your Name (TEAMID)", "profile": "/path/to/ArcMod.provisionprofile" }
// Keychain items belong to a team: Arc's engine and app name Arc's team in their keychain access groups, so the
// build swaps in your team ID (the same length) and entitles those groups.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const ARC_TEAM = "S6N382Y83G";
const GROUP_PREFIX = ".company.thebrowser.browser.";
// Chromium's on-device credential stores: passkeys, their user-verification keys, device-bound session keys and
// secure payment confirmation.
export const KEYCHAIN_GROUPS = ["webauthn", "webauthn-uvk", "unexportable-keys", "secure-payment-confirmation"] as const;
export const BROWSER_PASSKEYS = "com.apple.developer.web-browser.public-key-credential";

export const signingConfigPath = (): string => join(homedir(), ".arcmod", "signing.json");

export interface SigningConfig {
  readonly identity: string;
  readonly profile: string;
}

export interface Profile {
  readonly name: string;
  readonly team: string;
  readonly platforms: readonly string[];
  readonly expires: Date;
  readonly certificates: readonly string[]; // SHA-1 of each allowed certificate, upper-case hex
  readonly entitlements: Readonly<Record<string, unknown>>;
}

export interface Signing {
  readonly identity: string; // SHA-1 of the signing certificate, as codesign takes it
  readonly profilePath: string;
  readonly profile: Profile;
  readonly entitlements: Readonly<Record<string, unknown>>;
}

const run = (command: readonly string[]): string => {
  const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`${command.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
};

export const readSigningConfig = (path = signingConfigPath()): SigningConfig | undefined => {
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const { identity, profile } = (value ?? {}) as { identity?: unknown; profile?: unknown };
  if (typeof identity !== "string" || !identity || typeof profile !== "string" || !profile) {
    throw new Error(`${path} needs "identity" (a codesigning certificate) and "profile" (a .provisionprofile path)`);
  }
  return { identity, profile: profile.replace(/^~(?=\/)/, homedir()) };
};

export const readProfile = (path: string): Profile => {
  if (!existsSync(path)) throw new Error(`provisioning profile not found: ${path}`);
  const dir = mkdtempSync(join(tmpdir(), "arcmod-profile-"));
  try {
    const plist = join(dir, "profile.plist");
    writeFileSync(plist, run(["security", "cms", "-D", "-i", path]));
    const extract = (key: string, format: "raw" | "json"): string => run(["plutil", "-extract", key, format, "-o", "-", plist]).trim();
    const count = Number(run(["plutil", "-extract", "DeveloperCertificates", "raw", "-o", "-", plist]).trim());
    const certificates = Array.from({ length: count }, (_, index) =>
      createHash("sha1").update(Buffer.from(extract(`DeveloperCertificates.${index}`, "raw"), "base64")).digest("hex").toUpperCase());
    return {
      name: extract("Name", "raw"),
      team: extract("TeamIdentifier.0", "raw"),
      platforms: JSON.parse(extract("Platform", "json")) as string[],
      expires: new Date(extract("ExpirationDate", "raw")),
      certificates,
      entitlements: JSON.parse(extract("Entitlements", "json")) as Record<string, unknown>,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// `security find-identity` lines: `  1) <SHA-1> "Developer ID Application: Name (TEAMID)"`.
export const findIdentity = (identity: string, listing: string): string | undefined => {
  const matches = [...listing.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"$/gm)]
    .filter(([, hash, name]) => hash === identity.toUpperCase() || name === identity)
    .map(([, hash]) => hash!);
  if (new Set(matches).size > 1) throw new Error(`more than one certificate is named "${identity}"; use its SHA-1 instead`);
  return matches[0];
};

// Profile entitlement values may end in a wildcard ("TEAMID.*").
const permits = (granted: unknown, value: string): boolean =>
  (Array.isArray(granted) ? granted : [granted]).some((pattern) =>
    typeof pattern === "string" && (pattern === value || (pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1)))));

export const entitlementsFor = (profile: Profile, bundleId: string): Record<string, unknown> => {
  const granted = profile.entitlements;
  const groups = KEYCHAIN_GROUPS.map((group) => `${profile.team}${GROUP_PREFIX}${group}`);
  const denied = groups.filter((group) => !permits(granted["keychain-access-groups"], group));
  if (denied.length > 0) throw new Error(`the profile doesn't allow keychain groups ${denied.join(", ")}`);
  return {
    "com.apple.application-identifier": `${profile.team}.${bundleId}`,
    "com.apple.developer.team-identifier": profile.team,
    "keychain-access-groups": groups,
    // Only when Apple has granted it to the team: macOS refuses to launch an app claiming it otherwise.
    ...(granted[BROWSER_PASSKEYS] === true ? { [BROWSER_PASSKEYS]: true } : {}),
  };
};

export const validateProfile = (profile: Profile, bundleId: string, identity: string, now = new Date()): void => {
  const appId = profile.entitlements["com.apple.application-identifier"];
  if (!/^[A-Z0-9]{10}$/.test(profile.team)) throw new Error(`unexpected team identifier in the profile: ${profile.team}`);
  if (!profile.platforms.includes("OSX")) throw new Error(`"${profile.name}" is a ${profile.platforms.join("/")} profile; create a macOS one`);
  if (appId !== `${profile.team}.${bundleId}`) throw new Error(`"${profile.name}" is for ${String(appId)}, not ${profile.team}.${bundleId}`);
  if (profile.expires <= now) throw new Error(`"${profile.name}" expired on ${profile.expires.toISOString().slice(0, 10)}`);
  if (!profile.certificates.includes(identity)) throw new Error(`"${profile.name}" doesn't include the signing certificate ${identity}`);
};

// Returns how the build signs `bundleId`: undefined (ad hoc) unless signing is configured.
export const signingFor = (bundleId: string, config = readSigningConfig()): Signing | undefined => {
  if (config === undefined) return undefined;
  const identity = findIdentity(config.identity, run(["security", "find-identity", "-v", "-p", "codesigning"]));
  if (identity === undefined) throw new Error(`no valid codesigning certificate "${config.identity}" in your keychain`);
  const profile = readProfile(config.profile);
  validateProfile(profile, bundleId, identity);
  return { identity, profilePath: config.profile, profile, entitlements: entitlementsFor(profile, bundleId) };
};

// Rewrites Arc's team in its keychain access group names; the team IDs have the same length, so nothing moves.
export const retargetKeychainGroups = (binary: Buffer, team: string): { readonly binary: Buffer; readonly count: number } => {
  if (team.length !== ARC_TEAM.length) throw new Error(`team ${team} isn't ${ARC_TEAM.length} characters`);
  const from = Buffer.from(`${ARC_TEAM}${GROUP_PREFIX}`);
  const to = Buffer.from(`${team}${GROUP_PREFIX}`);
  const out = Buffer.from(binary);
  let count = 0;
  for (let at = out.indexOf(from); at !== -1; at = out.indexOf(from, at + from.length)) {
    to.copy(out, at);
    count++;
  }
  return { binary: out, count };
};
