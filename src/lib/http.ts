/**
 * Browser-side helper for calling our API routes.
 *
 * `res.json()` on an empty or HTML body (an uncaught 500, a 405, a proxy
 * error page) throws "Unexpected end of JSON input", which hides the real
 * status. readJson() always produces a readable Error that names the call
 * and the HTTP status, and uses the server's `{ error }` message when there
 * is one.
 */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

function snippet(text: string): string {
  const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

export async function readJson<T = Record<string, unknown>>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => "");
  let body: unknown = undefined;
  if (text) {
    try { body = JSON.parse(text); } catch { body = undefined; }
  }
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  const serverMessage =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : null;

  if (!res.ok) {
    const detail = serverMessage ?? (text ? snippet(text) : "the server returned an empty response");
    throw new ApiError(`${label} failed (${status}): ${detail}`, res.status, body);
  }
  if (body === undefined) {
    throw new ApiError(`${label} failed (${status}): the server returned ${text ? "a non-JSON" : "an empty"} response`, res.status, text);
  }
  return body as T;
}
