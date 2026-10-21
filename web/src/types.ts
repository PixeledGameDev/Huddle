export interface User {
  id: string;
  username: string;
  displayName: string | null;
  bio: string;
  accent: string | null;
  statusText: string;
  avatarVersion: number;
  createdAt?: string;
  /** Only present on your own account. */
  huddleAdmin?: boolean;
}
export interface ServerSummary { id: string; name: string; iconVersion: number }
export interface Channel { id: string; name: string }
export type Role = "owner" | "admin" | "member";
export type VoteAction = "kick" | "timeout" | "ban";

export interface Member {
  id: string;
  username: string;
  displayName: string | null;
  avatarVersion: number;
  accent: string | null;
  statusText: string;
  role: Role;
  online: boolean;
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
  isDm: boolean;
  ownerId: string;
  myRole: Role;
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
  blockedByMe: boolean;
  user: { id: string; username: string; displayName: string | null; avatarVersion: number; accent: string | null; statusText: string };
}
