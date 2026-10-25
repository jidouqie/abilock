// Service-side environment names. CLI uses its own execution-only accessor.
export function setting(name: string): string | undefined {
  return (
    process.env[`ABILOCK_${name}`] ??
    process.env[`PERMIVELO_${name}`] ??
    process.env[`COI_${name}`]
  );
}
