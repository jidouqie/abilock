import { Store } from "../../src/store.js";
import { platformSchema } from "../../src/schema.js";
import type { LearnManifest } from "../../src/learn.js";

const store = new Store(process.argv[2], "9".repeat(64));
try {
  await store.init();
  process.send?.({ type: "ready" });
  process.on("message", async (message: {
    id: number; action: "save" | "learn" | "read" | "close";
    value?: unknown; alias?: string; expected?: number;
  }) => {
    try {
      if (message.action === "close") {
        await store.close();
        process.disconnect();
        return;
      }
      let value: unknown;
      if (message.action === "save")
        value = await store.save(platformSchema.parse(message.value), undefined,
          false, message.expected);
      else if (message.action === "learn")
        value = await store.applyLearnedPlatform(message.alias!, message.value as LearnManifest);
      else {
        await store.refresh();
        value = { platforms: store.list(), docs: store.state.docs };
      }
      process.send?.({ id: message.id, value });
    } catch (error) {
      process.send?.({ id: message.id, error: { code: (error as {code?: string}).code } });
    }
  });
} catch (error) {
  process.send?.({ type: "error", code: (error as { code?: string }).code });
  await store.close();
  process.disconnect();
}
