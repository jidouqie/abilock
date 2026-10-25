import {
  assertWindowsEnvironment,
  windowsRuntime,
} from "./windows-environment.js";
import {
  initializeAdminAtRoot,
  verifyAdminAtRoot,
} from "./isolation-bootstrap.js";
import type { Readable } from "node:stream";
import { z } from "zod";
import { validPasswordLength } from "./password-policy.js";
import { assertWindowsAdmin } from "./windows-environment.js";

const request = z.union([
  z.object({ verify: z.literal(true) }).strict(),
  z.object({ password: z.string().refine(validPasswordLength) }).strict(),
]);
export async function readWindowsBootstrapRequest(input: Readable) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > 8192) throw new Error("Invalid bootstrap input");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    try {
      return request.parse(JSON.parse(bytes.toString("utf8")));
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Only reachable through the installer-only Bootstrap task. No reset path. */
export async function verifyWindowsInitialization(): Promise<
  "initialized" | "setup-required"
> {
  await assertWindowsEnvironment();
  const result = await verifyAdminAtRoot(windowsRuntime.data);
  if (result === "initialized") await assertWindowsAdmin();
  return result;
}

export async function initializeWindowsAdmin(password: string) {
  await assertWindowsEnvironment();
  await initializeAdminAtRoot(password, windowsRuntime.data);
}
