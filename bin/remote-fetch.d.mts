export interface RemoteFetchOptions {
  method?: string;
  headers?: HeadersInit;
  body?: string | Buffer;
  signal?: AbortSignal;
  redirect?: "error";
}
export function remoteFetch(
  url: string | URL,
  options?: RemoteFetchOptions,
): Promise<Response>;
