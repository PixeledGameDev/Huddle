# Huddle

A Discord-style chat app: accounts, servers, channels, realtime messaging, roles, invites, and
**toggleable vote moderation** (kick, timeout, or temporary ban). One Node service serves the API,
WebSockets, and the built React app, so it deploys to Render as a single web service plus Postgres.

## Run locally

Requires Node 20+ and a Postgres database.

```bash
docker run -d --name huddle-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=huddle -p 5432:5432 postgres:16
# set DATABASE_URL (see .env.example) in your shell, then:
npm install
npm run dev                 # API on :3000, UI on http://localhost:5173
```

The schema is created automatically on startup.

## Deploy to Render

1. Push this folder to a Git repo.
2. In Render: **New > Blueprint**, pick the repo. `render.yaml` creates the web service and the database
   and wires `DATABASE_URL` for you.
3. Check the `plan` values in `render.yaml` against Render's current pricing. Free web instances spin
   down when idle, which drops WebSocket connections, so use a paid instance for real use.

## Vote moderation

Owners and admins configure it under **Settings** (off by default):

| Setting | Meaning |
|---|---|
| Action | Timeout, kick, or temporary ban |
| Length | How long a timeout or ban lasts |
| Share of online voters | Yes votes needed, as a % of eligible members online when the vote starts |
| Minimum yes votes | A vote can't start unless this many eligible members are online |
| Voting time | How long the vote stays open |
| Cooldown | Minimum gap between votes involving the same initiator or target |
| Who can vote | Minimum time in the server (owners and admins always can) |

Enforced on the server: owners and admins are immune, you can't vote on yourself, one open vote per
target, one ballot per person, and the outcome is applied transactionally exactly once. Timeouts and
bans are stored separately from memberships, so leaving and rejoining doesn't clear them. Open votes
are persisted and resolved by a sweeper, so a restart doesn't lose them.

## Files and reactions

- Attach up to 4 files per message (8 MB each) with the paperclip, by drag and drop, or by pasting an image.
- Files are stored in Postgres, so no extra storage service is needed. Each server is capped at 250 MB
  (change with the `SERVER_STORAGE_MB` env var). Watch the free Postgres 1 GB limit.
- Only real PNG/JPEG/GIF/WebP images (checked by their bytes) display inline. Every other file is served as a
  forced download with a sandboxing CSP, so an uploaded HTML or SVG file can never run on your site.
- Only current server members can download files, so a kicked member loses access.
- Reactions: any emoji, up to 20 different ones per message. Timed-out members can't upload or react.
- Uploads that are never attached to a message are deleted after an hour.

## File storage on Cloudflare R2

Uploaded files can live in a Cloudflare R2 bucket instead of Postgres (R2's free tier includes 10 GB of storage with
no egress fees). Set these four environment variables to turn it on:

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID` | Your Cloudflare account ID (shown on the R2 overview page) |
| `R2_ACCESS_KEY_ID` | From an R2 API token with Object Read & Write on the bucket |
| `R2_SECRET_ACCESS_KEY` | The matching secret (shown once when you create the token) |
| `R2_BUCKET` | The bucket name |

With them unset, files stay in Postgres, so local development needs no extra setup.

- **Existing files move automatically.** On startup the server copies any files still stored in Postgres into R2 and
  clears their bytes from the database. It resumes where it left off if it's restarted mid-way. Watch the logs for
  `Moved N existing file(s) from Postgres to R2`.
- **Same access rules.** The bucket stays private. Downloads still go through the server, which checks that you're a
  member and applies the same safe-download headers, so nothing about permissions changed.
- **Cleanup is automatic.** Deleting a message, deleting a channel, or an abandoned upload removes the object from
  R2 within about a minute (a database trigger queues it and a background sweeper deletes it).
- **Errors are honest.** If R2 is unreachable, uploads fail with a clear message and leave nothing half-saved.
- Profile pictures and server icons are tiny and stay in Postgres.
- Postgres reclaims the space from moved files on its own schedule (autovacuum), so the database may take a while to
  shrink.

## Messages, polls, and mentions

- **Reply, edit, delete.** Authors can edit and delete their own messages. Owners and admins can delete anyone's.
  A deleted message disappears for everyone (replies to it just lose their quote), but owners and admins can still
  read it under **Settings > Deleted messages**. Uploaded file contents are removed; only their names are kept.
- **@mentions.** `@username` (autocomplete in the composer) notifies that member; admins can use `@everyone`.
  Replying also notifies the original author. Mention badges show on channels and servers and in the tab title.
- **Polls.** 2 to 10 options, single or multiple choice, optional anonymous voting, optional end time. The author
  or an admin can close one early.
- **GIFs.** Search is proxied through your server so the API key stays secret. It uses GIPHY (Tenor's API shut down
  on June 30, 2026). Set `GIPHY_API_KEY` to turn the GIF button on; without it the button is hidden.
- **Twemoji.** Emoji render as Twemoji images served by your own server (no CDN). Emoji newer than the bundled set
  fall back to the device's own glyph. Twemoji graphics are CC-BY 4.0 (credited in the profile dialog).

## Profiles and customization

Display name, profile picture, status, bio, and profile color per person (people are still mentioned by their
`@username`), a server icon, a light/dark/system theme, and cozy/compact message spacing.

## Admin controls

Owners and admins can time out, kick, or ban (timed or permanent) anyone below them instantly, with a reason,
from **Moderate** in the member list. Owners can moderate admins; admins can only moderate regular members. Bans
can be lifted in **Settings > Bans**. Admins can also rename and delete channels (hover a channel). Everything is
recorded in **Settings > Activity**.

## Direct messages

One-on-one conversations, opened from someone's profile or the **Message** button next to a member (the 💬 button
at the top of the server rail lists them). You can only start a DM with someone you share a server with, and the
conversation survives if one of you later leaves that server. Replies, edits, deleting, files, reactions, polls,
GIFs, and emoji all work in DMs.

- **Blocking.** Block someone from their profile. While blocked, neither of you can send, upload, or react in
  that DM (history stays readable), they can't reopen it, and they aren't told why. Blocks don't affect shared servers.
- **Privacy.** DMs have no admins, so nobody can read them but the two people in them. Messages you delete from a
  DM are removed outright (no archive). Messages from the other person count as unread notifications.
- Under the hood a DM is a hidden two-person space with one channel, which is why every message feature carries over.

## Update log

The ✨ button at the bottom left opens an in-app update log, with a red dot until each person has seen the latest
entry. To announce a change, add an entry at the top of `web/src/changelog.ts`.

## Layout

```
server/src   index.ts · storage.ts · auth.ts · routes.ts (servers) · messages.ts · polls.ts · profiles.ts · admin.ts · dms.ts
             votes.ts · gifs.ts · hydrate.ts · perms.ts · realtime.ts · schema.ts · db.ts
web/src      App.tsx · Chat.tsx · MessageRow.tsx · Composer.tsx · Members.tsx · Polls.tsx · GifPicker.tsx
             DmPanel.tsx · EmojiPicker.tsx · Rich.tsx · Avatar.tsx · Modals.tsx · ProfileModals.tsx · VoteBanner.tsx · Auth.tsx
render.yaml  Render Blueprint
```

## Known v1 limits

- No group DMs or voice/video.
- Downloads are proxied through the server (so permission checks stay in one place), which uses some of Render's bandwidth.
- Single instance only: presence and rate limits are in memory. To scale out, add the Socket.IO Redis
  adapter and move the rate limiter to Redis.
- Messages render as plain text (no Markdown) so output stays safely escaped.
- Mention badges reset on reload. The deleted-message archive isn't pruned automatically.
- No email, password reset, or account deletion yet.
