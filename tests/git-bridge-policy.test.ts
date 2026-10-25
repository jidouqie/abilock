import test from "node:test";
import assert from "node:assert/strict";
import { gitBridgeRequestAuthorized } from "../src/protocols/git-bridge-policy.ts";

const capability = "a".repeat(64); // Synthetic pure-policy test value only.
test("Git bridge allows exact authenticated upload/receive routes for the current service", () => {
  for (const service of ["upload", "receive"] as const) {
    assert.equal(
      gitBridgeRequestAuthorized(
        {
          method: "GET",
          url: `/repo.git/info/refs?service=git-${service}-pack`,
          capability,
        },
        capability,
        service,
      ),
      true,
    );
    assert.equal(
      gitBridgeRequestAuthorized(
        { method: "POST", url: `/repo.git/git-${service}-pack`, capability },
        capability,
        service,
      ),
      true,
    );
    const other = service === "upload" ? "receive" : "upload";
    assert.equal(
      gitBridgeRequestAuthorized(
        {
          method: "GET",
          url: `/repo.git/info/refs?service=git-${other}-pack`,
          capability,
        },
        capability,
        service,
      ),
      false,
    );
    assert.equal(
      gitBridgeRequestAuthorized(
        { method: "POST", url: `/repo.git/git-${other}-pack`, capability },
        capability,
        service,
      ),
      false,
    );
  }
});
test("Git bridge rejects missing/wrong/duplicate/Unicode capability and route or method tricks", () => {
  const request = { method: "POST", url: "/repo.git/git-upload-pack" };
  for (const value of [
    undefined,
    "",
    "a".repeat(63),
    "b".repeat(64),
    `${capability}, ${capability}`,
    [capability],
    [capability, capability],
    "界".repeat(64),
  ]) {
    assert.equal(
      gitBridgeRequestAuthorized(
        { ...request, capability: value },
        capability,
        "upload",
      ),
      false,
    );
  }
  assert.equal(
    gitBridgeRequestAuthorized({ ...request, capability }, "", "upload"),
    false,
  );
  for (const url of [
    "/other.git/git-upload-pack",
    "/repo.git//git-upload-pack",
    "/repo.git/%67it-upload-pack",
    "/repo.git/git-upload-pack?next=evil",
    "/repo.git/git-upload-pack/",
    "http://evil.example/repo.git/git-upload-pack",
    "/repo.git/info/refs?service=git-upload-pack&extra=1",
  ]) {
    assert.equal(
      gitBridgeRequestAuthorized(
        { method: "POST", url, capability },
        capability,
        "upload",
      ),
      false,
    );
  }
  for (const method of [
    undefined,
    "PUT",
    "DELETE",
    "CONNECT",
    "HEAD",
    "post",
  ]) {
    assert.equal(
      gitBridgeRequestAuthorized(
        { ...request, method, capability },
        capability,
        "upload",
      ),
      false,
    );
  }
});
