import path from "node:path";
import { acquireProcessLock } from "../../src/process-lock.js";
import { Store } from "../../src/store.js";

const store = new Store(process.argv[2], "9".repeat(64), [], {
  readOnly: process.argv[3] === "reader",
});
let lock: Awaited<ReturnType<typeof acquireProcessLock>> | undefined;
try {
  if (process.argv[3] === "contender") {
    lock = await acquireProcessLock(path.join(process.argv[2], "service.lock"));
  } else {
    await store.init();
    if (process.argv[3] !== "reader")
      lock = await acquireProcessLock(path.join(process.argv[2], "service.lock"));
  }
  process.send?.({ type: "ready" });
  process.on("message", async (message) => {
    if (message !== "close") return;
    await store.close();
    await lock?.release();
    process.disconnect();
  });
} catch (error) {
  process.send?.({ type: "error", code: (error as { code?: string }).code });
  await store.close();
  process.disconnect();
}
