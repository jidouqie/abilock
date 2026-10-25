import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PasswordInput } from "../web/components/password-input.js";
import { validPasswordLength } from "../src/password-policy.js";

test("password input admits every server-valid Unicode length without truncating emoji passwords", () => {
  for (const value of ["🔒".repeat(130), "🔒".repeat(256), "汉".repeat(256), "a".repeat(256)]) {
    assert.ok(validPasswordLength(value));
    const html = renderToStaticMarkup(React.createElement(PasswordInput, { value, readOnly: true }));
    assert.match(html, /maxLength="512"/i);
    assert.ok(html.includes(value));
  }
  assert.ok(!validPasswordLength("🔒".repeat(7)));
  assert.ok(!validPasswordLength("a".repeat(257)));
  assert.ok(!validPasswordLength("🔒".repeat(257)));
});
