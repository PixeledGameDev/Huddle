export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "Request failed.", res.status, data);
  return data as T;
}
