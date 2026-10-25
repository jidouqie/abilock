// Pure portable manifest policy. No native executable, sockets or filesystem.
export function gitManifestPathAllowed(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1000 &&
    /^[\x20-\x7e]+$/.test(value) &&
    value.normalize("NFC") === value &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value
      .split("/")
      .every(
        (part) =>
          Boolean(part) &&
          part !== "." &&
          part !== ".." &&
          ![
            ".git",
            ".abilock-worktree.json",
            ".permivelo-worktree.json",
          ].includes(part.toLowerCase().replace(/[. ]+$/, "")),
      )
  );
}

export function gitManifestPathsAllowed(paths: string[]): boolean {
  const seen = new Set<string>();
  const spellings = new Map<string, string>();
  for (const value of paths) {
    if (!gitManifestPathAllowed(value)) return false;
    const key = value.toLowerCase();
    const parts = value.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const spelling = parts.slice(0, count).join("/");
      const canonical = spelling.toLowerCase();
      if (spellings.has(canonical) && spellings.get(canonical) !== spelling)
        return false;
      spellings.set(canonical, spelling);
    }
    if (seen.has(key)) return false;
    seen.add(key);
  }
  for (let ancestor of seen) {
    while (ancestor.includes("/")) {
      ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
      if (seen.has(ancestor)) return false;
    }
  }
  return true;
}
