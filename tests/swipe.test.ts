import { test } from "node:test";
import assert from "node:assert/strict";
import { swipeAnswer, swipeHint, swipeTilt } from "../src/utils/swipe.ts";

const W = 360;
const H = 520;

test("far enough right, left, up or down is an answer; less springs back", () => {
  assert.equal(swipeAnswer(130, 10, 0, 0, W, H), "yes");
  assert.equal(swipeAnswer(-130, -10, 0, 0, W, H), "no");
  assert.equal(swipeAnswer(10, -140, 0, 0, W, H), "else");
  assert.equal(swipeAnswer(100, 0, 0.1, 0, W, H), null);
  assert.equal(swipeAnswer(0, -100, 0, -0.1, W, H), null);
  assert.equal(swipeAnswer(10, 140, 0, 0, W, H), "skip");
  assert.equal(swipeAnswer(0, 100, 0, 0.1, W, H), null);
});

test("a quick flick counts, a jittery tap doesn't", () => {
  assert.equal(swipeAnswer(60, 5, 1.2, 0, W, H), "yes");
  assert.equal(swipeAnswer(-60, 5, -1.2, 0, W, H), "no");
  assert.equal(swipeAnswer(5, -60, 0, -1.2, W, H), "else");
  assert.equal(swipeAnswer(5, 60, 0, 1.2, W, H), "skip");
  assert.equal(swipeAnswer(10, 2, 2, 0, W, H), null);
});

test("diagonal drags go by their larger direction", () => {
  assert.equal(swipeAnswer(200, 150, 0, 0, W, H), "yes");
  assert.equal(swipeAnswer(100, 150, 0, 0, W, H), "skip");
  assert.equal(swipeAnswer(200, -150, 0, 0, W, H), "yes");
  assert.equal(swipeAnswer(100, -150, 0, 0, W, H), "else");
});

test("the card leans and shows its answer as it goes", () => {
  assert.equal(swipeTilt(0, W), 0);
  assert.equal(swipeTilt(W, W), 12);
  assert.equal(swipeTilt(-W * 2, W), -12);
  assert.equal(swipeHint(10, 0), null);
  assert.equal(swipeHint(40, 5), "yes");
  assert.equal(swipeHint(-40, 5), "no");
  assert.equal(swipeHint(5, -40), "else");
  assert.equal(swipeHint(5, 40), "skip");
});
