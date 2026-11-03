import type { Attachment } from "./types";
import { trackUpload } from "./uploadProgress";

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
  if (!res.ok) {
    if (res.status === 503 && data.maintenance) window.dispatchEvent(new Event("huddle:maintenance")); // Huddle just went into maintenance
    throw new ApiError(data.error ?? "Request failed.", res.status, data);
  }
  return data as T;
}

/**
 * Uploads one file as a raw body. Throws ApiError with a readable message on failure.
 * (Not fetch, because only XMLHttpRequest reports how much has been sent: the desktop app shows it on the taskbar button.)
 */
export function uploadFile(channelId: string, file: File): Promise<Attachment> {
  const track = trackUpload(file.size);
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fail = (message: string, status = 0, data: unknown = {}) => {
      track.done();
      reject(new ApiError(message, status, data));
    };
    xhr.open("POST", `/api/channels/${channelId}/files?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) track.progress(e.loaded); };
    xhr.onload = () => {
      let data: any = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status < 200 || xhr.status >= 300) return fail(data.error ?? "Upload failed.", xhr.status, data);
      track.done();
      resolve(data.attachment as Attachment);
    };
    xhr.onerror = () => fail("Upload failed. Check your connection.");
    xhr.onabort = () => fail("Upload cancelled.");
    xhr.ontimeout = () => fail("Upload timed out.");
    xhr.send(file);
  });
}

/** Raw-body upload (images). Throws ApiError with a readable message on failure. */
export async function uploadRaw<T = any>(path: string, body: Blob, method = "PUT"): Promise<T> {
  const res = await fetch("/api" + path, { method, headers: { "Content-Type": "application/octet-stream" }, body, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "Upload failed.", res.status, data);
  return data as T;
}
