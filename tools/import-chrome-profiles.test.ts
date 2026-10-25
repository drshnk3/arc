import { describe, expect, test } from "bun:test";
import { addSpace, bookmarkItems, bookmarkRoots, chooseProfiles, chromeProfiles, importedSpaceID, nextProfileDirectory, nextSpaceIcon, SPACE_ICONS } from "./import-chrome-profiles";

const ids = (): (() => string) => {
  let next = 0;
  return () => `id-${++next}`;
};

describe("Chrome profiles", () => {
  test("lists profiles in Chrome's order, named as in Chrome", () => {
    const localState = {
      profile: {
        profiles_order: ["Profile 2", "Default"],
        info_cache: { Default: { name: "Personal", avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_26" }, "Profile 2": { name: " Work " }, "Profile 3": { name: "" } },
      },
    };
    expect(chromeProfiles(localState)).toEqual([
      { directory: "Profile 2", name: "Work", avatar: undefined },
      { directory: "Default", name: "Personal", avatar: "chrome://theme/IDR_PROFILE_AVATAR_26" },
      { directory: "Profile 3", name: "Profile 3", avatar: undefined },
    ]);
  });

  test("tells profiles with the same name apart by account, or by folder without one", () => {
    const localState = {
      profile: {
        info_cache: {
          "Profile 1": { name: "Darshan", user_name: "one@example.com" },
          "Profile 2": { name: "Darshan", user_name: "two@example.com" },
          "Profile 4": { name: "Darshan" },
          "Profile 3": { name: "Nanatsu", user_name: "n@example.com" },
        },
      },
    };
    expect(chromeProfiles(localState).map((profile) => profile.name)).toEqual([
      "Darshan (one@example.com)", "Darshan (two@example.com)", "Darshan (Profile 4)", "Nanatsu",
    ]);
  });

  test("asks which profiles to import, all selected, and keeps the ones left selected", () => {
    const pending = [
      { directory: "Profile 6", name: "Fake", avatar: undefined },
      { directory: "Profile 8", name: "vijay", avatar: undefined },
      { directory: "Profile 9", name: "vijay", avatar: undefined },
    ];
    let asked: { labels: readonly string[]; prompt: string } | undefined;
    const chosen = chooseProfiles(pending, 2, (labels, prompt) => {
      asked = { labels, prompt };
      return ["Fake", "vijay (Profile 9)"];
    });
    expect(asked?.labels).toEqual(["Fake", "vijay", "vijay (Profile 9)"]);
    expect(asked?.prompt).toContain("2 imported before");
    expect(chosen.map((profile) => profile.directory)).toEqual(["Profile 6", "Profile 9"]);
    expect(chooseProfiles(pending, 0, () => [])).toEqual([]);
  });

  test("gives each Chrome profile a stable Space ID and a free ArcMod profile folder", () => {
    expect(importedSpaceID("Profile 1")).toBe("arcmod.chrome-import.profile-1");
    expect(importedSpaceID("Default")).toBe("arcmod.chrome-import.default");
    const taken = new Set(["Profile 1", "Profile 2"]);
    expect(nextProfileDirectory((name) => taken.has(name))).toBe("Profile 3");
  });
});

describe("bookmarks", () => {
  const bookmarks = {
    roots: {
      bookmark_bar: {
        children: [
          { type: "url", name: "Example", url: "https://example.com/" },
          { type: "url", name: "Bookmarklet", url: "javascript:alert(1)" },
          { type: "folder", name: "Docs", children: [{ type: "url", name: "", url: "https://docs.example.com/" }] },
          { type: "folder", name: "Empty", children: [] },
        ],
      },
      other: { children: [] },
      synced: { children: [{ type: "url", name: "Phone", url: "https://m.example.com/" }] },
    },
  };

  test("keeps Chrome's root folders that have bookmarks, merging account bookmarks", () => {
    const account = { roots: { other: { children: [{ type: "url", name: "Account", url: "https://account.example.com/" }] } } };
    expect(bookmarkRoots([bookmarks, account]).map((root) => [root.title, root.children.length])).toEqual([
      ["Bookmarks Bar", 4], ["Other Bookmarks", 1], ["Mobile Bookmarks", 1],
    ]);
  });

  test("pins a Bookmarks folder that mirrors Chrome's folders, without bookmarklets or empty folders", () => {
    const { folderID, items, links } = bookmarkItems(bookmarkRoots([bookmarks]), "pinned", "device", 1, ids());
    expect(links).toBe(3);
    const byID = new Map(items.map((item) => [item.id, item]));
    const tree = (id: string): unknown => {
      const item = byID.get(id)!;
      return item.childrenIds.length ? { [item.title ?? ""]: item.childrenIds.map(tree) } : item.title;
    };
    expect(tree(folderID!)).toEqual({
      Bookmarks: [{ "Bookmarks Bar": ["Example", { Docs: ["https://docs.example.com/"] }] }, { "Mobile Bookmarks": ["Phone"] }],
    });
    expect(byID.get(folderID!)).toMatchObject({ parentID: "pinned", data: { list: {} }, originatingDevice: "device", createdAt: 1 });
    expect(items.find((item) => item.title === "Example")?.data).toEqual({ tab: { savedURL: "https://example.com/", savedTitle: "Example" } });
    for (const item of items) for (const child of item.childrenIds) expect(byID.get(child)?.parentID).toBe(item.id);
  });

  test("adds no folder when there are no bookmarks", () => {
    expect(bookmarkItems([], "pinned", "device", 1, ids())).toEqual({ folderID: undefined, items: [], links: 0 });
  });
});

describe("Spaces", () => {
  test("adds a Space bound to the profile, with its pinned and unpinned containers", () => {
    const main = { spaces: ["default", { id: "default" }] as unknown[], items: [] as unknown[] };
    const sidebar = { sidebar: { containers: [{ global: {} }, main] } };
    const newID = ids();
    addSpace(sidebar, { id: "arcmod.chrome-import.default", title: "Personal", directory: "Profile 1", machineID: "machine" },
      (pinnedID) => bookmarkItems(bookmarkRoots([{ roots: { bookmark_bar: { children: [{ type: "url", name: "A", url: "https://a.example/" }] } } }]), pinnedID, "machine", 1, newID),
      1, newID);
    const space = main.spaces[3] as Record<string, unknown>;
    expect(main.spaces[2]).toBe("arcmod.chrome-import.default");
    expect(space).toMatchObject({
      id: "arcmod.chrome-import.default",
      title: "Personal",
      profile: { custom: { _0: { directoryBasename: "Profile 1", machineID: "machine" } } },
      containerIDs: ["pinned", "id-1", "unpinned", "id-2"],
      newContainerIDs: [{ unpinned: { _0: { shared: {} } } }, "id-2", { pinned: {} }, "id-1"],
    });
    const items = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < main.items.length; index += 2) items.set(main.items[index] as string, main.items[index + 1] as Record<string, unknown>);
    expect(items.get("id-1")).toMatchObject({ parentID: null, childrenIds: ["id-3"], data: { itemContainer: { containerType: { spaceItems: { _0: "arcmod.chrome-import.default" } } } } });
    expect(items.get("id-2")).toMatchObject({ childrenIds: [] });
    expect(items.get("id-3")).toMatchObject({ title: "Bookmarks", parentID: "id-1" });
  });

  test("gives each new Space an icon no other Space uses", () => {
    const main = { spaces: ["default", { id: "default", customInfo: { iconType: { icon: "planet" } } }] as unknown[], items: [] as unknown[] };
    const sidebar = { sidebar: { containers: [{ global: {} }, main] } };
    const empty = (): ReturnType<typeof bookmarkItems> => ({ folderID: undefined, items: [], links: 0 });
    for (const id of ["a", "b", "c"]) addSpace(sidebar, { id, title: id, directory: id, machineID: "machine" }, empty, 1, ids());
    const icons = main.spaces.filter((space) => typeof space === "object").map((space) => (space as { customInfo: { iconType: { icon: string } } }).customInfo.iconType.icon);
    expect(icons).toEqual(["planet", "people", "terminal", "layers"]);
  });

  test("picks unused icons first, then repeats them", () => {
    expect(nextSpaceIcon(["people", "terminal"])).toBe("layers");
    expect(nextSpaceIcon([...SPACE_ICONS])).toBe(SPACE_ICONS[0]);
  });
});
