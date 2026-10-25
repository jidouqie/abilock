// The one list of protocol connection kinds. Server, local worker and gateway
// routes are derived from it; the UI and the adapter table are typed by it, so
// adding a kind fails type checks wherever a form or adapter is still missing.
// The CLI command map (bin/native-kinds.mjs) is checked against it in tests.
export const connectionKinds = [
  "ssh",
  "postgres",
  "mysql",
  "redis",
  "git",
  "s3",
  "aws",
  "registry",
  "docker",
  "kubernetes",
] as const;
export type ConnectionKind = (typeof connectionKinds)[number];

const kinds = connectionKinds.join("|");
/** /v2/(run|context)/KIND/SELECTOR; groups: action, kind, selector. */
export const protocolRoute = new RegExp(
  `^/v2/(run|context)/(${kinds})/([A-Za-z0-9_.:-]{1,100})$`,
);
export const protocolContextRoute = new RegExp(
  `^/v2/context/(${kinds})/[A-Za-z0-9_.:-]{1,100}$`,
);
export const protocolRunRoute = new RegExp(
  `^/v2/run/(${kinds})/[A-Za-z0-9_.:-]{1,100}$`,
);
