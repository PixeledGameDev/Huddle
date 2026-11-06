/**
 * Server tags: a verified or Huddle Official server can have a short tag (2 to 4 letters or numbers). Members of it may choose to
 * wear that tag next to their name, in every server. A person wears one tag at a time (users.tag_server_id).
 * A tag only shows while the person is still in that server and the server is still verified or official.
 */
export const TAG_RE = /^[A-Za-z0-9]{2,4}$/;

export interface UserTag { text: string; official: boolean; serverId: string }

/** SQL for the tag the user (a row aliased `alias` in the query) currently wears, or null. Read it as `user_tag`. */
export const userTagSql = (alias: string) =>
  `(select jsonb_build_object('text', ts.tag, 'official', ts.official, 'serverId', ts.id)
      from servers ts join memberships tm on tm.server_id = ts.id and tm.user_id = ${alias}.id
     where ts.id = ${alias}.tag_server_id and ts.tag is not null and (ts.verified or ts.official))`;

export const asUserTag = (v: unknown): UserTag | null => (v && typeof v === "object" ? (v as UserTag) : null);
