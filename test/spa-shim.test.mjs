import test from "node:test";
import assert from "node:assert/strict";
import { injectSpaShim } from "../src/spa-shim.mjs";

test("injects the randomUUID shim immediately after head", () => {
  const html = injectSpaShim("<!doctype html><html><head><title>x</title></head><body></body></html>");
  assert.ok(html.indexOf("crypto.randomUUID") > html.indexOf("<head>"));
  assert.ok(html.indexOf("crypto.randomUUID") < html.indexOf("<title>"));
});

test("member UI hides Host plugin actions and shared usage card", () => {
  const html = injectSpaShim("<html><head></head><body></body></html>");
  for (const label of ["Plugins", "Task Board", "Skill Center", "SSH", "Remote access", "Add workspace", "Open usage statistics settings", "Models", "Built-in plugins", "Agent presets", "Plugin Market", "Web Plugins"])
    assert.ok(html.includes(label), `missing member-only UI suppression for ${label}`);
  assert.ok(html.includes("card.style.display = \"none\""));
});

test("does not inject twice", () => {
  const once = injectSpaShim("<head><title>x</title>");
  const twice = injectSpaShim(once);
  assert.equal(twice, once);
});
