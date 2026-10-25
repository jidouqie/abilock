export type AdminApiError = Error & { code?: string; status?: number };

// A proxy, crash page or truncated body is reported as an unreadable service
// response instead of a raw JSON parser exception.
// Typed like Response.json(): each admin route reads its own fields.
export async function readJson(response: Response): ReturnType<Response["json"]> {
  const text = await response.text();
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    /* Reported below with the status only. */
  }
  throw Object.assign(
    new Error(`服务返回了无法识别的响应（HTTP ${response.status}）`),
    { code: "INVALID_RESPONSE", status: response.status },
  );
}

export function apiFailure(
  response: Response,
  data: { error?: { code?: string; message?: string } },
): AdminApiError {
  return Object.assign(
    new Error(data.error?.message ?? `HTTP ${response.status}`),
    { code: data.error?.code, status: response.status },
  );
}
