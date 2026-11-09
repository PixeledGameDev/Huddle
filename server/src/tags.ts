/**
 * Server tags: a verified or Huddle Official server can have a short tag (2 to 12 letters or numbers). Members of it may choose to
 * wear that tag next to their name, in every server. A person wears one tag at a time (users.tag_server_id).
 * A tag only shows while the person is still in that server and the server is still verified or official.
 * The server can also give its tag a color and a small picture, and choose whether clicking the tag opens an invite to it.
 */
export const TAG_MAX = 12;
export const TAG_RE = new RegExp(`^[A-Za-z0-9]{2,${TAG_MAX}}$`);
/** Tag colors are plain #rrggbb, so they are safe to put in a style. */
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface UserTag { text: string; official: boolean; serverId: string; color: string | null; iconVersion: number; invite: boolean }

/** SQL for the tag the user (a row aliased `alias` in the query) currently wears, or null. Read it as `user_tag`. */
export const userTagSql = (alias: string) =>
  `(select jsonb_build_object('text', ts.tag, 'official', ts.official, 'serverId', ts.id, 'color', ts.tag_color, 'iconVersion', ts.tag_icon_version, 'invite', ts.tag_invite)
      from servers ts join memberships tm on tm.server_id = ts.id and tm.user_id = ${alias}.id
     where ts.id = ${alias}.tag_server_id and ts.tag is not null and (ts.verified or ts.official))`;

export const asUserTag = (v: unknown): UserTag | null => (v && typeof v === "object" ? (v as UserTag) : null);
