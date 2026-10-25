import crypto from "node:crypto";

export type GitBridgeService = "upload" | "receive";
export type GitBridgeRequest = {
  method?: string;
  url?: string;
  capability?: string | string[];
};

// This policy is independent of HTTP/Git execution so its authorization matrix
// can be tested without starting processes, sockets or protocol fixtures.
export function gitBridgeRequestAuthorized(
  request: GitBridgeRequest,
  expectedCapability: string,
  service: GitBridgeService,
) {
  if (
    !/^[a-f0-9]{64}$/.test(expectedCapability) ||
    typeof request.capability !== "string"
  )
    return false;
  const expected = Buffer.from(expectedCapability);
  const supplied = Buffer.from(request.capability);
  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  )
    return false;
  return (
    (request.method === "GET" &&
      request.url === `/repo.git/info/refs?service=git-${service}-pack`) ||
    (request.method === "POST" &&
      request.url === `/repo.git/git-${service}-pack`)
  );
}
