# ArcMod

ArcMod is a modified copy of the [Arc browser](https://arc.net) for macOS that you can use
without an Arc account. Arc's own services are blocked, it's a little lighter, and coding
agents (Codex, Claude Code) get browser tools of their own.

> **Work in progress.** This is an experimental mod I use day to day. Expect rough edges.
> Known problems are tracked in the pinned [status issue](https://github.com/CryogenicPlanet/arc/issues/1).

ArcMod builds a **separate app** next to your normal Arc. Your installed Arc and its data are
never modified.

ArcMod runs on Arc's own engine by default. Its sister repo,
[**Arc Engine**](https://github.com/CryogenicPlanet/arc-engine), rebuilds that engine
(Arc's `ArcCore.framework`) from Chromium source, so ArcMod can keep getting Chromium security
updates after Arc shuts down on 2026-12-22. See [Arc Engine](#arc-engine-experimental).

Not affiliated with The Browser Company.

## Quick start

You need an Apple Silicon Mac with Xcode Command Line Tools (`xcode-select --install`),
[Bun](https://bun.sh) and [Git LFS](https://git-lfs.com).

```sh
git lfs install
git clone https://github.com/CryogenicPlanet/arc.git
cd arc
bun install
bun tools/build-mod.ts   # builds and installs /Applications/ArcMod.app
open -a ArcMod
```

That's it. The build takes about a minute the first time and a few seconds after that.

What just happened? ArcMod only builds from Arc **1.168.0**, and the repo includes a copy of it
in `bin/`. The builder uses `/Applications/Arc.app` while it's still 1.168.0; otherwise it
unpacks the included copy into `build/source/` once. Then it patches a copy of that app, signs it
on your Mac and installs it as `/Applications/ArcMod.app`.

- Open ArcMod like any app: from Applications, Launchpad, Spotlight or the Dock, or make it your
  default browser. It applies the service blocking that Chromium needs however it's opened.
  `tools/run-mod.sh` still works too. To install somewhere else, set `ARCMOD_INSTALL_DIR`
  (for example `~/Applications`) for the build, updates and `tools/run-mod.sh`.
- Quit ArcMod before you rebuild.
- The clone downloads about 730 MB through Git LFS: about 380 MB of Arc in `bin/` and about
  350 MB of reverse-engineering files. To skip the latter, clone with
  `GIT_LFS_SKIP_SMUDGE=1`, then run `git lfs pull --include="bin/*"`.

## Staying up to date

ArcMod checks this repo's GitHub releases once a day and adds **Update to vX.Y.Z…** to the
**ArcMod** menu when there's a new one. Choosing it opens Terminal, which updates your checkout
to the release and builds the new ArcMod with the same engine while you keep browsing. Then it
asks ArcMod to quit, swaps in the new build and reopens it. If anything goes wrong, your
current ArcMod stays as it is.

You can also check by hand with **ArcMod → Check for Updates…**. The daily check is the one
request ArcMod makes on its own, to `api.github.com`; turn it off with **ArcMod → Check for
Updates Automatically**.

From a terminal, the same update is:

```sh
bun tools/update.ts           # update to the newest release and rebuild
bun tools/update.ts --check   # only report
```

If ArcMod is open, the update builds first and then waits for you to quit it. It needs a
checkout without local changes. Arc itself never updates: ArcMod stays on
Arc 1.168.0's app.

## Which branch?

| Branch | What you get |
| --- | --- |
| `master` | Everything below: no sign-in, service blocking, one Little Arc, performance tweaks, agent browser tools, app icons and the ArcMod menu. |
| `no-login` | Only what's needed to use Arc without an account, plus service blocking. |

Releases are tagged `vX.Y.Z` on `master` and `vX.Y.Z-no-login` on `no-login`.

## What it does

- **No sign-in.** The account onboarding screen never opens. Windows, tabs, links, keyboard
  shortcuts and Settings work without an account. No fake account or token is created; Arc's
  own account checks are left in place.
- **Blocks The Browser Company's services.** Requests from Arc's native code to its backend,
  sync, LaunchDarkly, Sentry, Segment and Datadog fail locally. Websites that use Firebase or
  similar services keep working.
- **One Little Arc.** Links reuse the open Little Arc window instead of opening a new one each
  time.
- **Lighter.** State files are written as compact JSON, LaunchDarkly starts offline and some
  background telemetry is turned off.
- **Arc's app icons.** All seven icons in **Settings → Icon** are available, not just the
  Original. Each one gets a small **MOD** badge so you can tell ArcMod from Arc.
- **Agent browser tools.** A local MCP server gives each coding agent its own isolated
  background browser. See [Agent browser tools](#agent-browser-tools).
- **Separate data.** ArcMod keeps everything in `~/Library/Application Support/ArcMod`.

## Make it look like Arc

The **ArcMod** menu in the menu bar has a few switches:

- **Show ARC MOD in Sidebar** turns the `ARC MOD` marker at the bottom of the sidebar on or
  off.
- **Show MOD Badge on App Icon** turns the badge on the Dock and Finder icon on or off.
- **Rename App…** changes the name in the menu bar, Dock and Finder, for example back to
  "Arc". It takes effect the next time ArcMod starts, and rebuilds keep it. ArcMod's data stays
  in `~/Library/Application Support/ArcMod` whatever you call it.

## What you give up

- Arc account features: sync across devices, Arc Max AI features, and calendar and email
  previews.
- iCloud and push notifications. The copy is re-signed on your Mac, and Apple ties those
  features to Arc's original signature. Passkeys on this Mac work if you sign ArcMod with your own
  Apple Developer certificate (see [Passkeys](#passkeys)).
- Arc's own updates. ArcMod stays on Arc 1.168.0 and updates only from this repo.

## Bring your logins over

ArcMod starts with an empty profile. To keep your sites signed in, copy your normal Arc
profile into it: choose **ArcMod → Import from Arc…**. Terminal asks ArcMod to quit, waits for
you to quit Arc, copies your data and reopens ArcMod.

This copies cookies, site storage, extensions, history and permissions. Sidebar spaces and Arc
account data aren't copied. To run it from a terminal instead, quit both browsers, then run
`bun tools/import-arc-data.ts`.

- macOS asks to read "Arc Safe Storage". Choose **Allow**, not "Always Allow".
- Your Arc data is only read. ArcMod's previous profile is kept as
  `Default.pre-import-<timestamp>`.
- ArcMod uses Chromium's mock keychain, so imported logins are protected only by a public key.
  Don't import on a shared Mac.

### From Chrome

**ArcMod → Import from Chrome…** turns each Google Chrome profile into an ArcMod profile with a
Space of the same name. Each one gets that profile's cookies, site storage, extensions, history
and passwords, and its bookmarks are pinned in the Space as a **Bookmarks** folder that mirrors
Chrome's folders (Bookmarks Bar, Other Bookmarks, Mobile Bookmarks). Terminal asks ArcMod to quit,
waits for you to quit Chrome, imports and reopens ArcMod.

From a terminal, with both browsers closed:

```sh
bun tools/import-chrome-profiles.ts --list                  # Chrome's profile folders and names
bun tools/import-chrome-profiles.ts                         # import every profile not imported yet
bun tools/import-chrome-profiles.ts --profile "Profile 2"   # or only some
```

- macOS asks to read "Chrome Safe Storage". Choose **Allow**, not "Always Allow".
- If Terminal can't read Chrome's folder, give it Full Disk Access in **System Settings →
  Privacy & Security**.
- Chrome is only read. Profiles imported before are skipped; delete the Space in ArcMod to import
  one again. ArcMod's sidebar and profile list are backed up as
  `*.pre-chrome-import-<timestamp>`.

## Agent browser tools

`tools/agent-mcp.ts` is a local stdio MCP server. Register it with your client, for example
Codex:

```sh
codex mcp add arcmod -- /absolute/path/to/bun /absolute/path/to/arc/tools/agent-mcp.ts
```

Call `open_session` to get a fresh background browser with its own profile, then use
`open_tab`, `read_page`, `click`, `type`, `navigate`, `screenshot` and `wait_for`. Agent
browsers don't take focus or touch your own ArcMod windows.
[computer-use-tools.md](notes/computer-use-tools.md) covers every tool and its limits.

## Passkeys

| Passkey | Ad hoc build (default) | Signed with your certificate |
| --- | --- | --- |
| Saved on this Mac with Touch ID (in ArcMod's profile) | **Doesn't work** | Works |
| Saved in iCloud Keychain / Apple Passwords | **Doesn't work** | Only if Apple grants your team the browser passkey entitlement |
| On your phone ("Use a phone or tablet", scan the QR code) | Should work; not tested yet | Should work |
| Hardware security key (YubiKey and similar) | Should work; not tested yet | Should work |
| Password-manager extension that handles passkeys (1Password, Bitwarden) | Should work; not tested yet | Should work |

Passkeys on this Mac live in the Keychain, and macOS gives a Keychain group only to apps signed by
the team that owns it. Arc used its own team's groups; an ad hoc copy has none. With a paid Apple
Developer account you can sign ArcMod yourself, and the builder moves those groups to your team.

1. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list),
   register a **macOS App ID** for ArcMod's bundle ID, `dev.drshnk.arcmod` (`tools/agent-session.ts`).
   It needs no capabilities.
2. Create a **Developer ID** provisioning profile (macOS → Developer ID) for that App ID and your
   Developer ID Application certificate, and download it.
3. Write `~/.arcmod/signing.json`:

   ```json
   {
     "identity": "Developer ID Application: Your Name (TEAMID)",
     "profile": "~/.arcmod/ArcMod.provisionprofile"
   }
   ```

   `security find-identity -v -p codesigning` lists your certificates; the SHA-1 works too.
4. Quit ArcMod and run `bun tools/build-mod.ts`. The build checks that the profile is for macOS,
   for `<TEAMID>.dev.drshnk.arcmod`, unexpired and made for that certificate, then signs with it.
   The first time, macOS asks to let `codesign` use your key: choose **Always Allow**.

Updates and rebuilds keep signing while `~/.arcmod/signing.json` exists; delete it to go back to
ad hoc. Only the normal ArcMod is signed; test and agent builds stay ad hoc. A stable signature
also means macOS stops asking for Bluetooth and Keychain permission again after each rebuild.

**iCloud Keychain passkeys** need one more entitlement,
`com.apple.developer.web-browser.public-key-credential`, which Apple grants only on request. The
request form is linked from
[the entitlement's documentation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential)
and has to come from the team's Account Holder. Developers who have applied report that Apple
grants it to Organization accounts (not individual memberships) and asks for the browser's bundle
ID, a download link and whether it supports WebAuthn. Once it's granted, enable it on the App ID,
download the profile again and rebuild: the builder adds the entitlement whenever the profile has it.

## Status

Known problems are listed in the pinned [status issue](https://github.com/CryogenicPlanet/arc/issues/1), which is kept up to date.
[runtime-status.md](notes/runtime-status.md) records what has been checked and how.

## How it works

`bun tools/build-mod.ts` makes an APFS clone of Arc 1.168.0, which takes no extra disk space.
Then it:

1. Gives the copy its own bundle ID and name, so its data folder and settings are separate
   from Arc's.
2. Applies small, fingerprinted patches to Arc's Swift app layer. The patcher refuses to run if
   the bytes don't match Arc 1.168.0 exactly.
3. Injects `ArcMod.dylib`, an Objective-C module that filters service requests, enables local
   menu actions, adds the ArcMod menu and adds ArcMod's Chromium switches when it's opened
   without `tools/run-mod.sh`.
4. Re-signs the copy ad hoc, or with your certificate (see [Passkeys](#passkeys)), and installs it
   in `/Applications`.

Arc's engine is left as it is unless you build with `--engine`.
[local-mode.md](notes/local-mode.md) and the
[account-guard audit](notes/local-guard-audit.md) describe every patch.

## Arc Engine (experimental)

Arc is two pieces: the Swift app that this repo patches, and `ArcCore.framework`, its engine.
ArcCore is The Browser Company's build of Chromium plus an Objective-C API that the app calls.
Arc shuts down on 2026-12-22, and its engine stops at Chromium 156 with no security updates
after that.

[**Arc Engine**](https://github.com/CryogenicPlanet/arc-engine) is our replacement ArcCore,
built from Google's Chromium source. It isn't a fork of Chromium: the repo holds our own
implementation of Arc's engine API and a few small Chromium patches, and its scripts build them
into an unmodified Chromium. Its behavior is checked against Arc's own engine, call by call.
It's included here as the `engine/` submodule.

> **Not ready for your daily profile yet.** Most of Arc behaves like it does on Arc's own
> engine in tests, but a few gaps remain. [Arc Engine's status issue](https://github.com/CryogenicPlanet/arc-engine/issues/1) has the list.

To try it, build a separate test copy of ArcMod on the prebuilt engine:

```sh
bun tools/build-mod.ts --validation --engine release   # downloads about 160 MB once
tools/run-mod.sh --validation
```

`--engine release` downloads the engine release this commit pins
(`resources/engine-release.json`), checks its SHA-256 and swaps it in for Arc's engine. The
test copy, ArcModValidation, keeps its own data. Keep it that way for now: Arc's engine for
1.168.0 is Chromium 155, and opening a profile with Chromium 156 upgrades it for good.

To build the engine yourself, see
[Arc Engine's README](https://github.com/CryogenicPlanet/arc-engine#build-it), then pass its
framework: `--engine engine/chromium/src/out/Release/Chromium.app/Contents/Frameworks/ArcCore.framework`.

## Development

```sh
bun run typecheck
bun run lint
bun run test
```

Binary tests run against `bin/Arc.arm64`, the original Arc 1.168.0 executable, stored in Git
LFS because Arc's auto-update replaces the installed copy. They skip when the file is missing.

- `mods/`: the injected module and the service and shortcut policies
- `tools/`: build, patch, launch, update, import, agent and test scripts
- `resources/`: Arc metadata, policy definitions and the pinned engine release
- `bin/`: Arc 1.168.0's executable (for tests) and app bundle (for builds), in Git LFS
- `engine/`: the [Arc Engine](https://github.com/CryogenicPlanet/arc-engine) submodule
- `ghidra/`, `dump/`: Arc 1.168.0 decompile and symbol dumps (Git LFS); the analyzed Ghidra
  project stays local
- `notes/`: findings and runtime evidence; start with [HANDOFF.md](notes/HANDOFF.md)

Coding agents working on this repo should read [AGENTS.md](AGENTS.md) first.
