import type { NextFunction, Request, Response } from "express";

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const buckets = new Map<string, { n: number; reset: number }>();

/** Tiny in-memory fixed-window limiter. Move to Redis if you run more than one instance. */
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { n: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  if (++b.n > max) throw new HttpError(429, "You're doing that too fast. Wait a moment and try again.");
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();
