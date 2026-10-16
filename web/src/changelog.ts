/**
 * The in-app update log (the ✨ button at the bottom left). Newest first.
 * To announce a change: add an entry at the top. Bumping the top version shows the "new" dot to everyone again.
 */
export interface ChangelogEntry {
  version: string;
  date: string; // YYYY-MM-DD
  title: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "2.3",
    date: "2026-10-17",
    title: "Bigger file storage",
    changes: [
      "Uploaded files now live in Cloudflare R2 instead of the database, so there's room for far more of them.",
      "Files you uploaded earlier were moved over automatically. Nothing to re-upload.",
    ],
  },
  {
    version: "2.2",
    date: "2026-10-16",
    title: "Update log",
    changes: ["Added this update log. A dot appears on the ✨ button whenever there's something new."],
  },
  {
    version: "2.1",
    date: "2026-10-16",
    title: "Direct messages",
    changes: [
      "One-on-one DMs with anyone you share a server with. Open someone's profile or use Message next to a member, and find your conversations under the 💬 button.",
      "Replies, edits, deleting, files, reactions, polls, GIFs, and emoji all work in DMs.",
      "Block someone from their profile or the DM side panel. Blocked pairs can't send in the DM, and blocks don't affect shared servers.",
      "DMs are private to the two people in them. Messages deleted from a DM are removed outright.",
    ],
  },
  {
    version: "2.0",
    date: "2026-10-16",
    title: "Polls, profiles, mentions, and more",
    changes: [
      "Polls: single or multiple choice, anonymous voting, optional end time.",
      "Profiles: display name, picture, status, bio, and profile color. Admins can set a server icon.",
      "Light, dark, and match-my-device themes, plus compact message spacing.",
      "@mentions with autocomplete, @everyone for admins, and mention badges on channels and servers.",
      "Reply to, edit, and delete messages. Admins can still read deleted messages in Settings.",
      "Admins can time out, kick, or ban people instantly, rename and delete channels, and lift bans.",
      "GIF search (when the server has a GIPHY key) and Twemoji emoji.",
    ],
  },
  {
    version: "1.1",
    date: "2026-10-15",
    title: "Files and reactions",
    changes: [
      "Attach up to 4 files (8 MB each) by button, drag and drop, or paste.",
      "React to messages with emoji.",
    ],
  },
  {
    version: "1.0",
    date: "2026-10-15",
    title: "Launch",
    changes: [
      "Accounts, servers, channels, and realtime chat with invites and roles.",
      "Vote moderation: members can vote to time out, kick, or temporarily ban someone, configured per server.",
    ],
  },
];

export const LATEST_VERSION = CHANGELOG[0].version;
const SEEN_KEY = "huddle.seenVersion";

export function hasUnseenUpdates(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== LATEST_VERSION;
  } catch {
    return false;
  }
}

export function markUpdatesSeen() {
  try {
    localStorage.setItem(SEEN_KEY, LATEST_VERSION);
  } catch {
    /* storage unavailable */
  }
}
