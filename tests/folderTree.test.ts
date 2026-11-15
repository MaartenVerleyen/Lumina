import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFolderTree } from "../src/utils/folderTree.ts";
import type { PhotoItem } from "../src/types/lumina.ts";

const photo = (hash: string, subfolder: string) => ({ hash, subfolder }) as PhotoItem;

test("folders on disk without photos show in the tree with a count of 0", () => {
  const tree = buildFolderTree([photo("a", "Trip / Day 1"), photo("b", "Root")], ["Trip", "Trip / Day 1", "Trip / Day 2", "Empty", "Root"]);
  assert.equal(tree.rootCount, 1);
  assert.deepEqual(
    tree.nodes.map((n) => [n.fullPath, n.totalCount, n.children.map((c) => [c.name, c.totalCount])]),
    [
      ["Empty", 0, []],
      ["Trip", 1, [["Day 1", 1], ["Day 2", 0]]],
    ]
  );
});
