export interface User {
  id: string;
  username: string;
  displayName: string | null;
  bio: string;
  pronouns?: string;
  accent: string | null;
  statusText: string;
  avatarVersion: number;
  bannerVersion?: number;
  nameFont?: string;
  createdAt?: string;
  /** How others currently see them. */
  status?: PublicStatus;
  /** What you chose. Only present on your own account. */
  presence?: Presence | null;
  /** Who may start a new DM with you. Only present on your own account. */
  dmPrivacy?: DmPrivacy | null;
  /** Only present on your own account. */
  huddleAdmin?: boolean;
}
export type Presence = "online" | "idle" | "dnd" | "invisible";
export type PublicStatus = "online" | "idle" | "dnd" | "offline";
export interface FriendUser { id: string; username: string; displayName: string | null; avatarVersion: number; accent: string | null; statusText: string; nameFont?: string; status: PublicStatus }
export type Friendship = "none" | "friends" | "outgoing" | "incoming";
export type DmPrivacy = "everyone" | "friends" | "nobody";
export interface ServerSummary { id: string; name: string; iconVersion: number; verified?: boolean }
export interface Channel { id: string; name: string }
/** The base membership role. "admin" only exists on servers that haven't converted their old admins to a role yet. */
export type Role = "owner" | "admin" | "member";
export type Permission = "manage_server" | "manage_channels" | "manage_roles" | "manage_messages" | "kick_members" | "ban_members" | "timeout_members" | "mention_everyone" | "view_audit_log" | "manage_emojis";
export interface ServerRole { id: string; name: string; color: string | null; permissions: Permission[]; position: number; hoist: boolean; sectionName: string | null; selfAssignable: boolean; memberCount: number }
export type VoteAction = "kick" | "timeout" | "ban";

export interface Member {
  id: string;
  username: string;
  displayName: string | null;
  avatarVersion: number;
  accent: string | null;
  statusText: string;
  nameFont?: string;
  role: Role;
  /** Role ids, highest ranked first. */
  roleIds: string[];
  /** Rank: higher outranks lower. You can only moderate people ranked below you. */
  top: number;
  online: boolean;
  status: PublicStatus;
  timeoutUntil: string | null;
}

export interface Settings {
  voteEnabled: boolean;
  voteAction: VoteAction;
  voteDurationSeconds: number;
  voteThresholdPct: number;
  voteMinVotes: number;
  voteWindowSeconds: number;
  voteCooldownSeconds: number;
  voteMinMemberAgeSeconds: number;
}

export interface Vote {
  id: string;
  serverId: string;
  targetId: string;
  targetName: string;
  initiatorId: string;
  initiatorName: string;
  action: VoteAction;
  durationSeconds: number;
  requiredVotes: number;
  eligibleCount: number;
  status: "open" | "passed" | "failed";
  expiresAt: string;
  yes: number;
  no: number;
  myVote?: boolean | null;
}

export interface ServerDetail {
  id: string;
  name: string;
  iconVersion: number;
  verified?: boolean;
  isDm: boolean;
  ownerId: string;
  myRole: Role;
  myPermissions: Permission[];
  myTop: number;
  /** Only sent to the owner: how many people still have the old admin rank. */
  legacyAdminCount: number;
  roles: ServerRole[];
  emojis: { id: string; name: string }[];
  stickers: { id: string; name: string }[];
  myTimeoutUntil: string | null;
  channels: Channel[];
  members: Member[];
  settings: Settings;
  votes: Vote[];
}

export interface Attachment { id: string; name: string; mime: string; size: number }
export interface Reaction { emoji: string; userIds: string[] }
export interface PollOption { id: string; text: string; count: number; voterIds: string[] }
export interface Poll {
  id: string;
  question: string;
  multi: boolean;
  anonymous: boolean;
  endsAt: string | null;
  closed: boolean;
  options: PollOption[];
  myVotes: string[];
  totalVoters: number;
}
export interface ReplyRef { id: string; authorId: string; authorName: string; snippet: string; hasExtra: boolean }

export interface Message {
  id: string;
  channelId: string;
  serverId: string;
  authorId: string;
  authorName: string;
  authorAvatar: number;
  content: string;
  createdAt: string;
  editedAt: string | null;
  mentions: string[];
  mentionsEveryone: boolean;
  gif: string | null;
  /** The status text this message is a reply to (direct messages only). */
  statusReply: string | null;
  sticker: { id: string; name: string } | null;
  replyTo: ReplyRef | null;
  attachments: Attachment[];
  reactions: Reaction[];
  poll: Poll | null;
}

export interface GifResult { id: string; title: string; url: string; preview: string; width: number; height: number }

export interface DeletedMessage {
  id: string;
  channelName: string;
  content: string;
  gif: string | null;
  createdAt: string;
  deletedAt: string;
  attachments: { name: string; mime: string; size: number }[];
  poll: { question: string; options: string[] } | null;
  authorId: string;
  authorName: string;
  deletedById: string;
  deletedByName: string;
}

export interface BanEntry { userId: string; username: string; name: string; permanent: boolean; until: string | null }

export interface DmSummary {
  id: string; // the DM's conversation id (used like a server id)
  lastAt: string;
  online: boolean;
  status: PublicStatus;
  blockedByMe: boolean;
  user: { id: string; username: string; displayName: string | null; avatarVersion: number; accent: string | null; statusText: string; nameFont?: string };
}
