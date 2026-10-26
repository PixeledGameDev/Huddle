import express, { type NextFunction, type Request, type Response } from "express";
import http from "http";
import fs from "fs";
import path from "path";
import { ZodError } from "zod";
import { authRouter, cleanupSessions, requireAuth } from "./auth";
import { migrate, q, requestStats, startPoolWarmer } from "./db";
import { downloadsRouter } from "./downloads";
import { bootstrapHuddle } from "./huddleAdmin";
import { inviteMeta, invitesRouter } from "./invites";
import { loadMaintenance, maintenanceGate, maintenanceRouter, startMaintenanceWatcher } from "./maintenance";
import { recoveryRouter } from "./security";
import { HttpError } from "./http";
import { initRealtime } from "./realtime";
import { api } from "./routes";
import { checkR2, migrateLegacyFiles, r2Enabled, startStorageSweeper } from "./storage";
import { startVoteSweeper } from "./votes";

async function main() {
  await migrate();
  await bootstrapHuddle();
  await loadMaintenance();
  startPoolWarmer();

  const app = express();
  app.set("trust proxy", 1); // Render terminates TLS in front of the app
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.giphy.com; frame-ancestors 'none'"
    );
    next();
  });
  // Slow API requests are logged with how many database queries they ran and how long those took, so a slowdown can be traced.
  app.use("/api", (req, res, next) => {
    const stats = { queries: 0, ms: 0 };
    const t0 = Date.now();
    res.on("finish", () => {
      const total = Date.now() - t0;
      if (total > 800) console.warn(`slow request ${req.method} ${req.originalUrl.split("?")[0]} ${total}ms (${stats.queries} queries, ${Math.round(stats.ms)}ms in the database)`);
    });
    requestStats.run(stats, next);
  });
  app.use(express.json({ limit: "20kb" }));

  app.get("/healthz", (_req, res) => void res.send("ok"));
  app.use(downloadsRouter); // desktop app downloads: public, so the page works before signing in
  app.use("/api", maintenanceRouter);
  app.use("/api", maintenanceGate); // while maintenance is on, only Huddle Admins get past here
  app.use("/api/auth", authRouter);
  app.use("/api/auth", recoveryRouter);
  app.use("/api", invitesRouter); // public: invite cards work before signing in
  app.use("/api", requireAuth, api);
  app.use("/api", (_req, res) => void res.status(404).json({ error: "Not found." }));

  // Twemoji graphics are served from the installed package, so no third-party CDN is involved.
  const twemojiDir = path.dirname(require.resolve("@twemoji/svg/package.json"));
  app.use("/twemoji", express.static(twemojiDir, { maxAge: "30d", immutable: true, index: false, extensions: [] }));
  app.use("/twemoji", (_req, res) => void res.sendStatus(404));

  const webDist = path.join(__dirname, "../../web/dist");
  app.use(express.static(webDist));
  // Invite links get link-preview tags (so pasting one into other apps shows a card); every other page is the app shell.
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  let shell: string | null = null;
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    const invite = /^\/invite\/([A-Za-z0-9_-]{6,32})\/?$/.exec(req.path);
    if (!invite) return void res.sendFile(path.join(webDist, "index.html"), (err) => err && next());
    (async () => {
      shell ??= fs.readFileSync(path.join(webDist, "index.html"), "utf8");
      const meta = await inviteMeta(invite[1]);
      if (!meta) return void res.type("html").send(shell);
      const origin = `${req.protocol}://${req.get("host")}`;
      const title = esc(`Join ${meta.name} on Huddle`);
      const tags = [
        `<meta property="og:site_name" content="Huddle" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:title" content="${title}" />`,
        `<meta property="og:description" content="${meta.memberCount} ${meta.memberCount === 1 ? "member" : "members"}. You've been invited to join this server." />`,
        `<meta property="og:url" content="${esc(origin + req.path)}" />`,
        ...(meta.iconVersion > 0
          ? [`<meta property="og:image" content="${esc(`${origin}/api/invites/${invite[1]}/icon?v=${meta.iconVersion}`)}" />`, `<meta name="twitter:card" content="summary" />`]
          : []),
      ].join("\n    ");
      res.type("html").send(shell.replace("<title>Huddle</title>", `<title>${title}</title>`).replace("</head>", `    ${tags}\n  </head>`));
    })().catch(next);
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, ...err.extra });
    if (err instanceof ZodError) return void res.status(400).json({ error: err.issues[0]?.message ?? "Invalid request." });
    if (err?.code === "22P02") return void res.status(404).json({ error: "Not found." }); // malformed uuid / id
    if (err?.type === "entity.too.large") return void res.status(413).json({ error: "That file is too large." });
    if (err?.type === "entity.parse.failed") return void res.status(400).json({ error: "Invalid JSON." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on our end." });
  });

  const server = http.createServer(app);
  initRealtime(server);
  startVoteSweeper();
  startMaintenanceWatcher();
  // Uploads that never got attached to a message are removed after an hour.
  setInterval(() => q(`delete from attachments where message_id is null and created_at < now() - interval '1 hour'`).catch(console.error), 10 * 60_000).unref();
  setInterval(() => cleanupSessions().catch(console.error), 6 * 3600_000).unref();

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`Huddle listening on :${port}`);
    if (r2Enabled) {
      void checkR2();
      void migrateLegacyFiles();
      startStorageSweeper();
    } else {
      console.log("File storage: Postgres (set the R2_* variables to use Cloudflare R2)");
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
