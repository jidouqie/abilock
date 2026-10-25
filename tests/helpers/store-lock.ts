import { acquireProcessLock } from "../../src/process-lock.js";

/** Persistent lock inodes are released by the kernel, never by unlinking. */
export async function assertLockReleased(file: string) {
  const lock = await acquireProcessLock(file, { busyCode: "CONFIG_BUSY" });
  await lock.release();
}
