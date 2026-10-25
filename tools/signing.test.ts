import { describe, expect, test } from "bun:test";
import { ARC_TEAM, BROWSER_PASSKEYS, entitlementsFor, findIdentity, retargetKeychainGroups, validateProfile, type Profile } from "./signing";

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  name: "ArcMod Developer ID",
  team: "XR7L4K435B",
  platforms: ["OSX"],
  expires: new Date("2030-01-01"),
  certificates: ["10AD61896782570C2B8E70571E50A995C121A3D2"],
  entitlements: {
    "com.apple.application-identifier": "XR7L4K435B.dev.drshnk.arcmod",
    "com.apple.developer.team-identifier": "XR7L4K435B",
    "keychain-access-groups": ["XR7L4K435B.*"],
  },
  ...overrides,
});

describe("signing identity", () => {
  const listing = `  1) EA56E25F5D6A8C85B5573C6A1AD336B837D82D9E "Apple Development: Someone (7KMB4QGJJ6)"
  2) 10AD61896782570C2B8E70571E50A995C121A3D2 "Developer ID Application: Someone (XR7L4K435B)"
     2 valid identities found`;

  test("finds a certificate by name or SHA-1", () => {
    expect(findIdentity("Developer ID Application: Someone (XR7L4K435B)", listing)).toBe("10AD61896782570C2B8E70571E50A995C121A3D2");
    expect(findIdentity("ea56e25f5d6a8c85b5573c6a1ad336b837d82d9e", listing)).toBe("EA56E25F5D6A8C85B5573C6A1AD336B837D82D9E");
    expect(findIdentity("Developer ID Application: Someone Else (AAAAAAAAAA)", listing)).toBeUndefined();
  });

  test("refuses an ambiguous name", () => {
    const twice = `${listing}\n  3) FF941F07F6FED1006F61F1A2B56C6D2012308BD0 "Developer ID Application: Someone (XR7L4K435B)"`;
    expect(() => findIdentity("Developer ID Application: Someone (XR7L4K435B)", twice)).toThrow("more than one");
  });
});

describe("provisioning profile", () => {
  const certificate = "10AD61896782570C2B8E70571E50A995C121A3D2";

  test("accepts a macOS profile for the bundle, signed by the certificate", () => {
    expect(() => validateProfile(profile(), "dev.drshnk.arcmod", certificate, new Date("2026-10-25"))).not.toThrow();
  });

  test("rejects profiles that macOS would refuse at launch", () => {
    const cases: readonly [Partial<Profile>, string][] = [
      [{ platforms: ["iOS"] }, "macOS"],
      [{ entitlements: { ...profile().entitlements, "com.apple.application-identifier": "XR7L4K435B.other.app" } }, "not XR7L4K435B.dev.drshnk.arcmod"],
      [{ expires: new Date("2026-01-01") }, "expired"],
      [{ certificates: ["EA56E25F5D6A8C85B5573C6A1AD336B837D82D9E"] }, "signing certificate"],
    ];
    for (const [overrides, message] of cases) {
      expect(() => validateProfile(profile(overrides), "dev.drshnk.arcmod", certificate, new Date("2026-10-25"))).toThrow(message);
    }
  });

  test("entitles the team's passkey keychain groups, and browser passkeys only when granted", () => {
    const plain = entitlementsFor(profile(), "dev.drshnk.arcmod");
    expect(plain).toEqual({
      "com.apple.application-identifier": "XR7L4K435B.dev.drshnk.arcmod",
      "com.apple.developer.team-identifier": "XR7L4K435B",
      "keychain-access-groups": [
        "XR7L4K435B.company.thebrowser.browser.webauthn",
        "XR7L4K435B.company.thebrowser.browser.webauthn-uvk",
        "XR7L4K435B.company.thebrowser.browser.unexportable-keys",
        "XR7L4K435B.company.thebrowser.browser.secure-payment-confirmation",
      ],
    });
    const granted = entitlementsFor(profile({ entitlements: { ...profile().entitlements, [BROWSER_PASSKEYS]: true } }), "dev.drshnk.arcmod");
    expect(granted[BROWSER_PASSKEYS]).toBe(true);
  });

  test("rejects a profile that doesn't allow the keychain groups", () => {
    const narrow = profile({ entitlements: { ...profile().entitlements, "keychain-access-groups": ["XR7L4K435B.dev.drshnk.arcmod"] } });
    expect(() => entitlementsFor(narrow, "dev.drshnk.arcmod")).toThrow("keychain groups");
  });
});

describe("keychain group retargeting", () => {
  test("rewrites only Arc's browser groups, in place", () => {
    const input = Buffer.from(`\0${ARC_TEAM}.company.thebrowser.browser.webauthn\0${ARC_TEAM}.com.google.common.folsom\0${ARC_TEAM}\0${ARC_TEAM}.company.thebrowser.browser.webauthn-uvk\0`);
    const { binary, count } = retargetKeychainGroups(input, "XR7L4K435B");
    expect(count).toBe(2);
    expect(binary.length).toBe(input.length);
    expect(binary.toString()).toBe(`\0XR7L4K435B.company.thebrowser.browser.webauthn\0${ARC_TEAM}.com.google.common.folsom\0${ARC_TEAM}\0XR7L4K435B.company.thebrowser.browser.webauthn-uvk\0`);
  });

  test("refuses a team ID of another length", () => {
    expect(() => retargetKeychainGroups(Buffer.from(""), "SHORT")).toThrow();
  });
});
