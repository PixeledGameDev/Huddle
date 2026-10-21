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

## Roles and permissions

Servers have **roles** (Settings → Roles). A member can hold several; they get the combined permissions of all of them, and the
server owner always has every permission.

| Permission | Lets someone |
|---|---|
| Manage server | Change settings, the icon and vote moderation |
| Manage channels | Create, rename and delete channels |
| Manage roles | Create and edit roles below their own, and give them to people |
| Manage messages | Delete other people's messages, close polls, see deleted messages |
| Kick / Ban / Time out members | Moderate instantly, without a vote |
| Mention @everyone | Notify every member |
| View activity log | See the server's moderation and settings history |

Roles are ranked (top of the list is highest). You can only edit roles, give roles, or moderate people ranked **below your
highest role**, and you can only grant permissions you hold yourself. Leaving, being kicked or banned drops a member's roles.

**Servers from before roles existed:** the old single *admin* rank keeps working (everything except managing roles) until the
owner is prompted to turn those admins into a real role, or remove the rank. Nobody can be made a legacy admin any more.

## Vote moderation

People with the **Manage server** permission configure it under **Settings** (off by default):

| Setting | Meaning |
|---|---|
| Action | Timeout, kick, or temporary ban |
| Length | How long a timeout or ban lasts |
| Share of online voters | Yes votes needed, as a % of eligible members online when the vote starts |
| Minimum yes votes | A vote can't start unless this many eligible members are online |
| Voting time | How long the vote stays open |
| Cooldown | Minimum gap between votes involving the same initiator or target |
| Who can vote | Minimum time in the server (owners and admins always can) |

Enforced on the server: the owner and anyone with a moderation permission are immune, you can't vote on yourself, one open vote per
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

## Invite links

The **Invite** button copies a link like `https://your-app/invite/<code>`.

- Pasted in chat, the link becomes a card showing the server's icon, name, online count, and member count, with a
  **Join** button (or **Open** if you're already in).
- Opening the link shows the same card on its own page. If you're not signed in, the sign-in form appears under it,
  and you're taken straight into the server afterwards.
- Pasting the link into other apps shows a link preview (the server's name, icon, and member count) in apps that
  support it. Anyone holding the link can see those basics, which is what makes the card work before signing in.
- The "Join a server" box accepts either a link or a bare code.

## Message formatting

`**bold**`, `*italic*`, `***both***`, and `||spoiler||`. Formatting nests, and unpaired symbols stay as typed.
Put a backslash before a symbol (`\*`, `\:`) to type it literally. Underscores aren't formatting, since usernames
contain them. Spoilers stay hidden until clicked (or activated with Enter or Space), including in reply previews.

**Emoji shortcodes.** `:name:` turns into an emoji (`:joy:`, `:+1:`, `:fire:`, `:flag_au:`, and every emoji's full
Unicode name such as `:face_with_tears_of_joy:`). Typing a colon and two letters in the composer opens suggestions;
Enter or Tab inserts the emoji. Names that don't match an emoji stay as typed, so `10:30:45` is safe. The message is
stored as typed and converted when it's shown, so editing a message shows the `:name:` again. The name list lives in
`web/src/emojiData.ts`; the short aliases are the ones to extend.

## Account security: email, password reset, two-factor

- **Email.** In *Profile & appearance → Sign-in & recovery* anyone can add an email address; it only counts once they
  enter the 6-digit code sent to it. A verified email is used to reset a forgotten password and to send a heads-up
  when the password, email or two-factor setting changes. Email is **optional** and needs setup (below).
- **Forgot password.** On the sign-in screen: enter your username or verified email, get a 6-digit code (valid 30
  minutes, works once, dies after 5 wrong tries), enter it with a new password. The answer is the same whether or not
  the account exists, so it can't be used to find out who has one. A reset signs the account out everywhere. Codes
  rather than links mean it works in the desktop app too.
- **Two-factor sign-in.** Authenticator apps (Google Authenticator, Authy, 1Password…), turned on with a QR code and a
  confirming code, plus 10 one-time recovery codes. Signing in then needs the code; a code can't be reused. A
  **password reset on an account with two-factor also needs an authenticator or recovery code**, so access to
  someone's inbox alone isn't enough. Changing the password, removing the email, turning two-factor off and deleting
  the account all ask for the password (and a code, if two-factor is on).
- **Change password** (same section) signs out your other devices and keeps this one.
- **Locked out?** A Huddle Admin can create a one-hour reset code for someone (for people with no verified email or
  on a server without email) and can turn off someone's two-factor if they've lost their authenticator and recovery
  codes. Both are in the Huddle Admin panel, are logged, and can't be aimed at other Huddle Admins.

Setup: set `RESEND_API_KEY` and `MAIL_FROM` (see `.env.example`) to turn email on; it uses Resend's HTTP API because
many hosts block SMTP. Without them the app says email isn't set up and everything except email works (codes appear
in the server log in development). Set `AUTH_SECRET` to a long random string to encrypt authenticator secrets in the
database (without it they're stored as plain text; changing it later means giving people a two-factor reset). Rate
limits apply to every step, and nothing here needs a new npm package.

## Deleting servers and accounts

- **Delete a server** (owner only): Settings → Danger zone, confirmed by typing the server's name. Everything in it is
  removed (channels, messages, files, invites, bans, history); uploaded files in R2 are queued for deletion by the
  existing storage sweeper. Everyone in it is told live. DMs can't be deleted this way.
- **Delete your account**: profile → Delete account, confirmed with your password. You can't still own servers (delete
  them first; there's no ownership transfer yet). The account row is kept as an empty placeholder called "Deleted
  user" so other people's conversations still make sense: name, picture, bio, status, password, sessions, memberships,
  blocks, invites, pending uploads and open votes are removed, open tabs are signed out, and the username can be
  registered again. DMs with them stay for the other person but can't be written to. Optionally their messages,
  reactions and poll votes are deleted too (live in open tabs, up to 1000 messages).

## Huddle Admin and the Huddle bot

*Operator notes; nothing in the app mentions any of this to regular users.*

**Huddle Admin** is a site-wide admin flag on a user. Having it makes that person an admin of every server (not DMs),
whether or not they joined, with no badge or marker anywhere. They can't be kicked, banned, timed out, or voted on,
are never timed out, and see every server in their sidebar with live updates. It does **not** give access to anyone's
direct messages. Their actions otherwise look like any admin's (for example, deletions appear in a server's audit log).

- **The panel.** Huddle Admins get a "Huddle Admin" button next to Sign out. Everyone else's requests to
  `/api/huddle/*` get a plain 404.
- **The bot.** A built-in account named **Huddle** (the username is reserved; nobody can sign in as it) sends messages
  from the panel, either to a channel of any server (an `@everyone` in the text pings everyone) or to everyone's DMs.
  The DM broadcast is delivered in the background, skips anyone who blocked Huddle, and only one runs at a time. People
  can't reply to the bot. If a regular user already owns the username `Huddle`, the bot stays off and a message is
  logged at startup until that account is renamed.
- **Giving it out.** Admins can give Huddle Admin to anyone by username from the panel, and take it from anyone except
  the permanent accounts. `PixeledFaggy` is permanent, and so is every name in the optional `HUDDLE_ADMIN_USERNAMES`
  environment variable (comma-separated). These are applied each time the server starts, **only if the account
  already exists**, so register the account first, then restart. Granting is never tied to sign-up, so nobody can claim
  it by registering a name early.
- **Site-wide bans.** From the panel, ban anyone for 1 hour, 1 day, 1 week, 30 days, or permanently, with an optional
  reason they see when they try to sign in. They're signed out immediately (sessions deleted, open tabs disconnected),
  can't sign in until it ends, and are skipped by DM broadcasts. Unban from the same panel. Bans are checked from
  `users.banned_until`, so expiry needs no cleanup job.
- **Deleting someone's account.** Same erasure as deleting your own (see above), after retyping their username. The
  panel can also wipe their messages, reactions and poll votes. If they own servers the request is refused unless
  "Also delete servers they own" is ticked (there's no ownership transfer yet). Other Huddle Admins and yourself can't
  be banned or deleted; remove the flag first (permanent ones can't be touched).
- **Record.** Grants, removals, sends, bans and deletions are written to the `huddle_admin_log` table.

## Suggestions

The 💡 button at the bottom of the left rail (or the address `/suggestions`) opens a site-wide board. Anyone signed in
can post an idea (title, optional details; 5 per hour), vote with ▲ (one vote each, toggle off any time; your own idea
starts with your vote), and sort by most votes or newest. Ideas move through **Open → Planned → In progress → Done**
or **Declined**, which only Huddle Admins can set (a dropdown on each idea, shown only to them; the endpoint answers
everyone else with "not found"). Done and declined ideas move to the second tab. Authors can remove their own ideas and
Huddle Admins can remove any. Deleting an account removes its votes, and its suggestions too if "delete my messages" is
ticked; otherwise they stay as "Deleted user". Code: `server/src/suggestions.ts`, `web/src/Suggestions.tsx`.

## Picture previews

Clicking an image attachment opens a full-size viewer over the chat instead of a new tab or a download. The Download
button is top right next to Close; ← → (or the side buttons) move between a message's pictures, Esc or a click outside
closes it, and keyboard focus stays inside while it's open (`web/src/Lightbox.tsx`).

## Videos

MP4/M4V, MOV and WebM files can be attached and are played in the chat with the browser's own controls, with a Download
link underneath. The type is decided from the file's contents (never its name or claimed type), so renaming something
`.mp4` doesn't make it a video. Limits: **videos up to 50 MB and other files up to 8 MB when files are stored in R2**;
without R2 everything stays at 8 MB, because in Postgres each file is held in memory and in a table row. Videos count
toward each server's storage quota (`SERVER_STORAGE_MB`, default 250), so you may want to raise it.

Served files support HTTP range requests (`server/src/fileserve.ts`), which is what lets a video start quickly and be
skipped around in, and what Safari/iOS requires. Huddle doesn't convert videos, so a format the viewer's browser can't
decode (typically HEVC/H.265, the iPhone default, in Chrome or Firefox) shows a download link instead of the player.
Screen recordings and most Android videos are H.264 and play everywhere.

## Notifications

Messages meant for you (direct messages, @mentions, @everyone) give an unread badge, an in-app toast, and, while Huddle
isn't the window you're looking at, a system notification plus a short chime (generated with Web Audio, so there's no
sound file). Clicking a notification opens that conversation. In *Profile & appearance → Notifications* each kind can be
switched off, along with the sound and the message preview (off shows only who sent it). Browsers ask for permission
the first time you tap "Allow notifications in this browser"; the desktop app needs none. Spoilers show as
"[spoiler]" in previews, and a burst of messages in one channel updates a single notification instead of stacking.

Limits: notifications arrive over the open connection, so they work while Huddle is open in a tab or the desktop app is
running (in the tray if you closed the window), not when everything is closed. True background push would need a push
service and a service worker, which isn't built. Unread counts live in the open page, as before.

## Desktop app

A blue download button sits at the bottom of the left rail and opens `/download` in a new tab. It only appears when
there's a build to download (it asks `/api/desktop`), so it never leads to an empty page; it's hidden inside the desktop
app itself and on phone-sized screens.

`desktop/` is an Electron app for Windows, macOS and Linux (see `desktop/README.md`). It opens your server's web app in
its own window and adds system notifications, an unread badge, a tray icon, and keep-running-in-the-tray. It's not part
of the server's build (it isn't in the npm workspaces), so deploying the server doesn't touch it. Installers are built
by `.github/workflows/desktop.yml` and are unsigned. They're offered to everyone at `/download` on your own site, so the
repository can stay private: the workflow uploads them to your R2 bucket (setup in `desktop/README.md`) and the server
serves the page and files from there (`server/src/downloads.ts`; the page is plain HTML with no scripts, and only
files listed in the uploaded manifest can be fetched).

## Links and link previews

Every `http://` or `https://` link in a message is clickable (opens in a new tab) and gets a preview card under the
message: site name, title, description, and picture, read from the page's Open Graph/Twitter tags. A link straight to
a PNG/JPEG/GIF/WebP shows the picture itself. Links whose page can't be read still get a plain card. Up to 3 cards
per message; this app's own invite links keep their server card, and links inside a `||spoiler||` get no card.

- **The server does the fetching.** Members ask `GET /api/embed?url=...`; the server fetches the page and returns just
  the preview fields. Preview pictures are re-served through `/api/embed/image`, which only serves URLs the server
  itself handed out (HMAC-signed) and only real PNG/JPEG/GIF/WebP bytes, so the CSP is unchanged and a linked site
  never sees a member's IP address. Previews are cached in memory (30 minutes, 5 for failures).
- **It can't be pointed at your network.** Only http(s) on ports 80/443, no credentials in the URL, and the address
  actually connected to must be public: loopback, private, link-local (including cloud metadata addresses),
  carrier-grade NAT, and other reserved ranges are refused, a hostname that resolves to any of them is refused, and
  every redirect hop is checked again. Time (6 s), page size (600 KB), image size (6 MB) and redirects (4) are capped.
- Cards load when they scroll near the screen, not for the whole history at once. Set `EMBED_SECRET` to keep signed
  image URLs valid across restarts (optional).
- Not included: playable video/audio embeds, and sites that only show previews to logged-in users or block servers
  fall back to the plain card.

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
             votes.ts · gifs.ts · embeds.ts · hydrate.ts · perms.ts · realtime.ts · schema.ts · db.ts
web/src      App.tsx · Chat.tsx · MessageRow.tsx · Composer.tsx · Members.tsx · Polls.tsx · GifPicker.tsx
             DmPanel.tsx · EmojiPicker.tsx · emojiData.ts · LinkEmbed.tsx · Rich.tsx · Avatar.tsx · Modals.tsx · ProfileModals.tsx · VoteBanner.tsx · Auth.tsx
render.yaml  Render Blueprint
```

## Known v1 limits

- No group DMs or voice/video.
- Downloads are proxied through the server (so permission checks stay in one place), which uses some of Render's bandwidth.
- Single instance only: presence and rate limits are in memory. To scale out, add the Socket.IO Redis
  adapter and move the rate limiter to Redis.
- Messages render as plain text (no Markdown) so output stays safely escaped.
- Mention badges reset on reload. The deleted-message archive isn't pruned automatically.
- No ownership transfer for servers (an owner has to delete the server before deleting their account).
