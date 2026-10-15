import express, { type NextFunction, type Request, type Response } from "express";
import http from "http";
import path from "path";
import { ZodError } from "zod";
import { authRouter, cleanupSessions, requireAuth } from "./auth";
import { migrate, q } from "./db";
import { HttpError } from "./http";
import { initRealtime } from "./realtime";
import { api } from "./routes";
import { startVoteSweeper } from "./votes";

async function main() {
  await migrate();

  const app = express();
  app.set("trust proxy", 1); // Render terminates TLS in front of the app
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
    );
    next();
  });
  app.use(express.json({ limit: "20kb" }));

  app.get("/healthz", (_req, res) => void res.send("ok"));
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, api);
  app.use("/api", (_req, res) => void res.status(404).json({ error: "Not found." }));

  const webDist = path.join(__dirname, "../../web/dist");
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => err && next());
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, ...err.extra });
    if (err instanceof ZodError) return void res.status(400).json({ error: err.issues[0]?.message ?? "Invalid request." });
    if (err?.code === "22P02") return void res.status(404).json({ error: "Not found." }); // malformed uuid / id
    if (err?.type === "entity.too.large") return void res.status(413).json({ error: "That file is too large. The limit is 8 MB." });
    if (err?.type === "entity.parse.failed") return void res.status(400).json({ error: "Invalid JSON." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on our end." });
  });

  const server = http.createServer(app);
  initRealtime(server);
  startVoteSweeper();
  // Uploads that never got attached to a message are removed after an hour.
  setInterval(() => q(`delete from attachments where message_id is null and created_at < now() - interval '1 hour'`).catch(console.error), 10 * 60_000).unref();
  setInterval(() => cleanupSessions().catch(console.error), 6 * 3600_000).unref();

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`Huddle listening on :${port}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
