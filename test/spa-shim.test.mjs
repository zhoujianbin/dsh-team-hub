import test from "node:test";
import assert from "node:assert/strict";
import { injectSpaShim } from "../src/spa-shim.mjs";

test("injects the randomUUID shim immediately after head", () => {
  const html = injectSpaShim("<!doctype html><html><head><title>x</title></head><body></body></html>");
  assert.ok(html.indexOf("crypto.randomUUID") > html.indexOf("<head>"));
  assert.ok(html.indexOf("crypto.randomUUID") < html.indexOf("<title>"));
});

test("does not inject twice", () => {
  const once = injectSpaShim("<head><title>x</title>");
  const twice = injectSpaShim(once);
  assert.equal(twice, once);
});
