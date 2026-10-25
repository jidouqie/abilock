import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { connectionKinds, protocolRoute } from "../src/protocol-kinds.js";
import { capabilities, protocolAdapters } from "../src/protocols/index.js";
import { nativeKinds } from "../bin/native-kinds.mjs";

// Adding a protocol kind must reach every entry point; these checks name the
// one that was missed instead of failing at a user's first call.
test("every protocol kind has an adapter, CLI command, capability and guide", async () => {
  assert.deepEqual(Object.keys(protocolAdapters).sort(), [...connectionKinds].sort());
  assert.deepEqual(
    [...new Set(nativeKinds.values())].sort(),
    [...connectionKinds].sort(),
  );
  for (const kind of connectionKinds) {
    assert.equal(nativeKinds.get(kind === "kubernetes" ? "kubectl" : kind), kind);
    const capability = capabilities.find((item) => item.kind === kind);
    assert.ok(capability, kind);
    await fs.access(`docs/protocols/${capability.documentation}`);
    assert.ok(protocolRoute.test(`/v2/run/${kind}/alias`));
    assert.ok(protocolRoute.test(`/v2/context/${kind}/alias`));
  }
  assert.equal(protocolRoute.test("/v2/run/unknown/alias"), false);
});

test("the published shrinkwrap and the development lockfile stay identical", async () => {
  assert.deepEqual(
    await fs.readFile("npm-shrinkwrap.json"),
    await fs.readFile("package-lock.json"),
  );
});
