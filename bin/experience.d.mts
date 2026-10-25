export const EXPERIENCE_INPUT_BYTES: number;
export const EXPERIENCE_OUTPUT_BYTES: number;
export function experienceMain(
  args: string[],
  fail: (code: string, message: string, exitCode?: number) => void,
  trace: unknown,
): Promise<void>;
export function parseExperienceArgs(args: string[]): {
  action: string;
  payload: Record<string, unknown>;
  json: boolean;
  file?: string;
  stdin: boolean;
};
export function readExperienceManifest(
  file?: string,
  stream?: AsyncIterable<Uint8Array | string>,
): Promise<Record<string, unknown>>;
export type ExperienceRequestOptions = {
  signal?: AbortSignal;
  fetcher?: (url: URL, options: RequestInit) => Promise<Response>;
};
export function experienceRequest(
  action: string,
  payload: unknown,
  options?: ExperienceRequestOptions,
): Promise<{ ok: boolean; status: number; value: Record<string, unknown> }>;
export function captureExperienceResult(
  alias: string,
  id: string | null | undefined,
  options?: ExperienceRequestOptions,
): Promise<{
  status: "available" | "unavailable";
  evidence?: unknown;
  code?: string;
  message?: string;
  docsCommand: string;
}>;
