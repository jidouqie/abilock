export function requestProgress(options?: {
  enabled?: boolean;
  write?: (text: string) => unknown;
  now?: () => number;
  intervalMs?: number;
}): { wrap(response: Response): Response; stop(): void };
