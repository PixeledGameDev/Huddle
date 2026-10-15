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

## Layout

```
server/src   index.ts (app) · auth.ts · routes.ts · votes.ts · realtime.ts · schema.ts · db.ts
web/src      App.tsx · Chat.tsx · Members.tsx · VoteBanner.tsx · Modals.tsx · Auth.tsx
render.yaml  Render Blueprint
```

## Known v1 limits

- No DMs, file uploads, reactions, or voice/video.
- Single instance only: presence and rate limits are in memory. To scale out, add the Socket.IO Redis
  adapter and move the rate limiter to Redis.
- Messages render as plain text (no Markdown) so output stays safely escaped.
- No email, password reset, or account deletion yet.
