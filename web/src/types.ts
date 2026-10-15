export interface User { id: string; username: string }
export interface ServerSummary { id: string; name: string }
export interface Channel { id: string; name: string }
export type Role = "owner" | "admin" | "member";
export type VoteAction = "kick" | "timeout" | "ban";

export interface Member {
  id: string;
  username: string;
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

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  attachments: Attachment[];
  reactions: Reaction[];
}
