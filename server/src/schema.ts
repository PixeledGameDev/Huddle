export const SCHEMA = `
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists users_username_lower on users (lower(username));

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists servers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  vote_enabled boolean not null default false,
  vote_action text not null default 'timeout' check (vote_action in ('kick','timeout','ban')),
  vote_duration_seconds int not null default 600,
  vote_threshold_pct int not null default 51,
  vote_min_votes int not null default 3,
  vote_window_seconds int not null default 60,
  vote_cooldown_seconds int not null default 300,
  vote_min_member_age_seconds int not null default 0
);

create table if not exists memberships (
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (server_id, user_id)
);
create index if not exists memberships_user on memberships(user_id);

-- Timeouts and bans live outside memberships so leaving and rejoining can't clear them.
create table if not exists server_timeouts (
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  until timestamptz not null,
  primary key (server_id, user_id)
);
create table if not exists server_bans (
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  until timestamptz not null,
  primary key (server_id, user_id)
);

create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create index if not exists channels_server on channels(server_id);

create table if not exists messages (
  id bigserial primary key,
  channel_id uuid not null references channels(id) on delete cascade,
  author_id uuid not null references users(id),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_channel on messages(channel_id, id desc);

create table if not exists invites (
  code text primary key,
  server_id uuid not null references servers(id) on delete cascade,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table if not exists votes (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  target_id uuid not null references users(id),
  initiator_id uuid not null references users(id),
  action text not null check (action in ('kick','timeout','ban')),
  duration_seconds int not null default 0,
  required_votes int not null,
  eligible_count int not null,
  status text not null default 'open' check (status in ('open','passed','failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz
);
create unique index if not exists votes_one_open_per_target on votes(server_id, target_id) where status = 'open';
create index if not exists votes_open on votes(expires_at) where status = 'open';

create table if not exists vote_ballots (
  vote_id uuid not null references votes(id) on delete cascade,
  user_id uuid not null references users(id),
  choice boolean not null,
  primary key (vote_id, user_id)
);

create table if not exists audit_log (
  id bigserial primary key,
  server_id uuid not null references servers(id) on delete cascade,
  actor_id uuid references users(id),
  target_id uuid references users(id),
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists audit_server on audit_log(server_id, id desc);

create table if not exists attachments (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  message_id bigint references messages(id) on delete cascade,
  uploader_id uuid not null references users(id),
  name text not null,
  mime text not null,
  size int not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists attachments_message on attachments(message_id);
create index if not exists attachments_orphans on attachments(created_at) where message_id is null;

create table if not exists reactions (
  message_id bigint not null references messages(id) on delete cascade,
  user_id uuid not null references users(id),
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

-- v3: profiles, replies, edits, mentions, GIFs, polls, deleted-message archive
alter table users add column if not exists display_name text;
alter table users add column if not exists bio text not null default '';
alter table users add column if not exists accent text;
alter table users add column if not exists status_text text not null default '';
alter table users add column if not exists avatar_version int not null default 0;
create table if not exists user_avatars (
  user_id uuid primary key references users(id) on delete cascade,
  mime text not null,
  data bytea not null
);
alter table servers add column if not exists icon_version int not null default 0;
create table if not exists server_icons (
  server_id uuid primary key references servers(id) on delete cascade,
  mime text not null,
  data bytea not null
);

alter table messages add column if not exists edited_at timestamptz;
alter table messages add column if not exists reply_to bigint references messages(id) on delete set null;
alter table messages add column if not exists mentions uuid[] not null default '{}';
alter table messages add column if not exists mentions_everyone boolean not null default false;
alter table messages add column if not exists gif_url text;

create table if not exists polls (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null unique references messages(id) on delete cascade,
  question text not null,
  multi boolean not null default false,
  anonymous boolean not null default false,
  ends_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  text text not null,
  position int not null
);
create index if not exists poll_options_poll on poll_options(poll_id);
create table if not exists poll_votes (
  poll_id uuid not null references polls(id) on delete cascade,
  option_id uuid not null references poll_options(id) on delete cascade,
  user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (option_id, user_id)
);
create index if not exists poll_votes_poll on poll_votes(poll_id, user_id);

-- Deleted messages vanish for everyone, but admins can still read them here.
create table if not exists deleted_messages (
  id bigint primary key,
  server_id uuid not null references servers(id) on delete cascade,
  channel_id uuid not null,
  channel_name text not null,
  author_id uuid not null references users(id),
  content text not null,
  gif_url text,
  created_at timestamptz not null,
  attachments jsonb not null default '[]',
  meta jsonb not null default '{}',
  deleted_by uuid not null references users(id),
  deleted_at timestamptz not null default now()
);
create index if not exists deleted_messages_server on deleted_messages(server_id, deleted_at desc);

-- v4: direct messages. A DM is a hidden two-person "server" with a single channel, so every message feature just works.
alter table servers add column if not exists is_dm boolean not null default false;
alter table servers add column if not exists dm_key text;
create unique index if not exists servers_dm_key on servers(dm_key) where dm_key is not null;
create table if not exists user_blocks (
  blocker uuid not null references users(id) on delete cascade,
  blocked uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked)
);

-- v5: file storage can live in Cloudflare R2. Legacy rows keep their bytes in the data column until they are moved.
alter table attachments add column if not exists storage_key text;
alter table attachments alter column data drop not null;
create table if not exists storage_deletions (
  key text primary key,
  created_at timestamptz not null default now()
);
create or replace function queue_storage_deletion() returns trigger language plpgsql as $$
begin
  if old.storage_key is not null then
    insert into storage_deletions(key) values (old.storage_key) on conflict do nothing;
  end if;
  return old;
end
$$;
drop trigger if exists attachments_queue_deletion on attachments;
create trigger attachments_queue_deletion after delete on attachments for each row execute function queue_storage_deletion();

-- v8: Huddle Admin (a site-wide admin that isn't shown anywhere) and the built-in "Huddle" bot.
alter table users add column if not exists is_bot boolean not null default false;
alter table users add column if not exists huddle_admin boolean not null default false;
alter table users add column if not exists huddle_admin_locked boolean not null default false;
create unique index if not exists users_one_bot on users(is_bot) where is_bot;
alter table users add column if not exists deleted_at timestamptz;
alter table users add column if not exists banned_until timestamptz;
alter table users add column if not exists ban_reason text;

-- v10: suggestions board
create table if not exists suggestions (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references users(id),
  title text not null,
  body text not null default '',
  status text not null default 'open' check (status in ('open', 'planned', 'in_progress', 'done', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists suggestions_status on suggestions(status, created_at desc);
create table if not exists suggestion_votes (
  suggestion_id uuid not null references suggestions(id) on delete cascade,
  user_id uuid not null references users(id),
  primary key (suggestion_id, user_id)
);

-- v9: email (for password resets) and two-factor sign-in
alter table users add column if not exists email text;
alter table users add column if not exists email_verified_at timestamptz;
create unique index if not exists users_email_verified on users(lower(email)) where email_verified_at is not null;
alter table users add column if not exists totp_secret text;
alter table users add column if not exists totp_pending text;
alter table users add column if not exists totp_enabled_at timestamptz;
alter table users add column if not exists totp_last_step bigint;
create table if not exists email_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('verify', 'reset')),
  email text,
  code_hash text not null,
  salt text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists email_codes_user on email_codes(user_id, purpose);
create table if not exists recovery_codes (
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  primary key (user_id, code_hash)
);
create table if not exists huddle_admin_log (
  id bigserial primary key,
  actor_id uuid references users(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
-- v19: roles with separate permissions. memberships.role stays as owner/member; the old 'admin' value survives only until the owner converts it.
create table if not exists server_roles (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  name text not null,
  color text,
  permissions text[] not null default '{}',
  position int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists server_roles_server on server_roles(server_id, position desc);
create table if not exists member_roles (
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references server_roles(id) on delete cascade,
  primary key (user_id, role_id)
);
create index if not exists member_roles_server on member_roles(server_id, user_id);
-- Leaving, being kicked or banned drops a member's roles.
create or replace function drop_member_roles() returns trigger language plpgsql as $$
begin
  delete from member_roles where server_id = old.server_id and user_id = old.user_id;
  return old;
end
$$;
drop trigger if exists memberships_drop_roles on memberships;
create trigger memberships_drop_roles after delete on memberships for each row execute function drop_member_roles();

-- v20: presence statuses and replies to someone's status
alter table users add column if not exists presence text not null default 'online' check (presence in ('online', 'idle', 'dnd', 'invisible'));
alter table messages add column if not exists status_reply text;

-- v21: friends and who may start a DM with you
alter table users add column if not exists dm_privacy text not null default 'everyone' check (dm_privacy in ('everyone', 'friends', 'nobody'));
create table if not exists friendships (
  user_a uuid not null references users(id) on delete cascade,
  user_b uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);
create index if not exists friendships_b on friendships(user_b);
create table if not exists friend_requests (
  from_id uuid not null references users(id) on delete cascade,
  to_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);
create index if not exists friend_requests_to on friend_requests(to_id);

-- v22: profile banners and display-name fonts
alter table users add column if not exists banner_version int not null default 0;
alter table users add column if not exists name_font text not null default 'default';
create table if not exists user_banners (
  user_id uuid primary key references users(id) on delete cascade,
  mime text not null,
  data bytea not null
);

-- v23: verified servers (only Huddle Admins can set this)
alter table servers add column if not exists verified boolean not null default false;

-- v24: server emojis and stickers
create table if not exists server_emojis (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  name text not null,
  mime text not null,
  data bytea not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists server_emojis_name on server_emojis(server_id, lower(name));
create table if not exists server_stickers (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  name text not null,
  mime text not null,
  data bytea not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists server_stickers_name on server_stickers(server_id, lower(name));
alter table messages add column if not exists sticker_id uuid references server_stickers(id) on delete set null;

-- v25: roles can get their own section in the member list, and some roles can be taken by anyone for themselves
alter table server_roles add column if not exists hoist boolean not null default false;
alter table server_roles add column if not exists self_assignable boolean not null default false;

-- v26: people can remove a conversation from their own DM list. The messages stay; a new message brings it back.
alter table memberships add column if not exists dm_hidden_at timestamptz;

-- v27: site-wide state (maintenance mode lives here so it survives a restart)
create table if not exists site_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- v28: optional pronouns on a profile
alter table users add column if not exists pronouns text not null default '';

-- v29: roles can name the member-list section they appear in (roles sharing a name share a section)
alter table server_roles add column if not exists section_name text;
`;
