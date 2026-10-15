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
`;
