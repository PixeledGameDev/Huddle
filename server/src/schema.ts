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
`;
