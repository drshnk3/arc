import { describe, expect, test } from "bun:test";
import { addSpace, bookmarkItems, bookmarkRoots, chromeProfiles, importedSpaceID, nextProfileDirectory } from "./import-chrome-profiles";

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
});
