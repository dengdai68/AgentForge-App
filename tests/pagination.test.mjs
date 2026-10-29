import test from "node:test";
import assert from "node:assert/strict";
import { paginate, paginationMarkup } from "../web/pagination.mjs";

test("directory pagination shows 20 records and clamps after filtering or deletion", () => {
  const records = Array.from({ length: 45 }, (_, index) => index + 1);
  assert.deepEqual(paginate(records, 1).items, records.slice(0, 20));
  assert.deepEqual(paginate(records, 2).items, records.slice(20, 40));
  assert.deepEqual(paginate(records, 3).items, records.slice(40));
  assert.equal(paginate(records.slice(0, 8), 3).page, 1);
  assert.equal(paginate([], 5).page, 1);
  assert.match(paginationMarkup(paginate(records, 2), "tasks"), /第 2\/3 页/);
  assert.equal(paginationMarkup(paginate(records.slice(0, 20)), "tasks"), "");
});
