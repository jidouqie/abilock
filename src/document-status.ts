import type { Store } from "./store.js";

export function withDocumentExportStatus(value: unknown, store: Pick<Store, "docsExportStatus">) {
  const status = store.docsExportStatus;
  if (status?.status === "pending" && value && typeof value === "object" && !Array.isArray(value))
    return { ...value, docsExportStatus: status };
  return value;
}
