import { test } from "node:test";
import assert from "node:assert/strict";
import { shutterLabel } from "../src/utils/exposure.ts";

test("shutter speeds stored as decimals show as fractions", () => {
  assert.equal(shutterLabel("0.016666666666666666s"), "1/60s");
  assert.equal(shutterLabel("0.001s"), "1/1000s");
  assert.equal(shutterLabel("0.5s"), "1/2s");
});

test("fractions, long exposures and empty values", () => {
  assert.equal(shutterLabel("1/250s"), "1/250s");
  assert.equal(shutterLabel("2s"), "2s");
  assert.equal(shutterLabel("1.3333333s"), "1.3s");
  assert.equal(shutterLabel(null), "");
  assert.equal(shutterLabel(""), "");
});
