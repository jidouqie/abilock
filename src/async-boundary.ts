import { AppError } from "./schema.js";

// OS DNS lookup cannot necessarily be stopped, but its wait can. A late result
// must never resume the cancelled request or start an adapter/socket.
export function awaitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof AppError
          ? signal.reason
          : new AppError(499, "REQUEST_CANCELLED", "请求已取消"),
      );
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) resolve(value);
        else abort();
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}
