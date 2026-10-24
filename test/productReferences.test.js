import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { cleanProductReference } from "../src/utils/productReferences.js";

const id = "6528debce9e8a06a49a23b2c";

test("accepts the populated category in a product edit response", () => {
  const value = cleanProductReference({ _id: id, title: "Softeners" });
  assert.equal(value, id);
  assert.equal(mongoose.Types.ObjectId.isValid(value), true);
});

test("preserves string IDs, ObjectIds, omissions and explicit clears", () => {
  assert.equal(cleanProductReference(` ${id} `), id);
  assert.equal(cleanProductReference(new mongoose.Types.ObjectId(id)), id);
  assert.equal(cleanProductReference(undefined), undefined);
  assert.equal(cleanProductReference(null), null);
  assert.equal(cleanProductReference(""), null);
});

test("malformed populated references still fail ObjectId validation", () => {
  for (const value of [
    { title: "Softeners" },
    { _id: "invalid" },
    { _id: null },
    { _id: {} },
  ]) {
    assert.equal(
      mongoose.Types.ObjectId.isValid(cleanProductReference(value)),
      false,
    );
  }
});
