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
    version: "4.4",
    date: "2026-10-21",
    title: "Banners and name fonts",
    changes: [
      "Add a banner image to your profile card (Profile & appearance → Upload banner).",
      "Pick a font for your display name from ten styles. It shows in the member list, messages, direct messages and your profile.",
    ],
  },
  {
    version: "4.3",
    date: "2026-10-21",
    title: "Friends and DM privacy",
    changes: [
      "Add friends from someone's profile (Add friend) or by username in the new Friends window, next to your direct messages. Accept or decline requests there too.",
      "Profiles now show the servers and friends you have in common.",
      "Choose who can start a direct message with you in Profile & appearance: anyone who shares a server, only friends, or nobody. This only affects new conversations.",
      "Blocking someone also ends your friendship.",
    ],
  },
  {
    version: "4.2",
    date: "2026-10-21",
    title: "Statuses",
    changes: [
      "Pick Online, Idle, Do not disturb or Invisible with the dot at the bottom left. Invisible makes you look offline to everyone while you keep using Huddle normally; Do not disturb stops pop-ups and desktop notifications (unread badges still count).",
      "You can now reply to someone's status: open their profile and choose Reply to status. It opens a direct message that quotes what their status said.",
    ],
  },
  {
    version: "4.1",
    date: "2026-10-21",
    title: "Small fixes",
    changes: [
      "Rename a server from Settings → General (needs the Manage server permission).",
      "In light mode the left bars are light too.",
      "The react, reply, edit and delete buttons only show when you hover a message (on a phone or tablet, tap the message).",
    ],
  },
  {
    version: "4.0",
    date: "2026-10-21",
    title: "Roles and permissions",
    changes: [
      "The single admin rank is gone. Owners now create roles (Settings → Roles) with their own colors and permissions: manage server, channels, roles or messages, kick, ban, time out, mention @everyone, and view the activity log.",
      "Give roles to people with the Roles button next to them in the member list. You can only edit roles, and moderate people, ranked below your own highest role, and only hand out permissions you have.",
      "Servers that already had admins: the owner is asked to turn those admins into a role. Until then admins keep their access.",
    ],
  },
  {
    version: "3.3",
    date: "2026-10-22",
    title: "Download button",
    changes: ["There's now a download button at the bottom of the left bar that takes you straight to the desktop app downloads."],
  },
  {
    version: "3.2",
    date: "2026-10-22",
    title: "Suggestions",
    changes: ["There's a new Suggestions page (the 💡 button on the left, or go to /suggestions). Post ideas for Huddle, vote for the ones you want most, and see what's planned and done."],
  },
  {
    version: "3.1",
    date: "2026-10-21",
    title: "Videos",
    changes: [
      "Attach videos (MP4, MOV and WebM, up to 50 MB) and watch them right in the chat, with play, seek, volume and fullscreen. There's a Download link under each one.",
      "If your browser can't play a particular video, you'll get a download link instead.",
    ],
  },
  {
    version: "3.0",
    date: "2026-10-21",
    title: "Picture previews",
    changes: ["Click a picture to look at it full size without leaving the chat. Download is in the top right; use ← → to move between a message's pictures and Esc to close."],
  },
  {
    version: "2.9",
    date: "2026-10-21",
    title: "Password reset and two-factor sign-in",
    changes: [
      "Forgot your password? Use \"Forgot your password?\" on the sign-in screen to get a code by email, if you've added and verified an email address.",
      "Add an email, change your password, and turn on two-factor sign-in with an authenticator app, all under Profile & appearance → Sign-in & recovery. Save the recovery codes it gives you.",
      "If you can't get in at all, a Huddle Admin can give you a reset code.",
    ],
  },
  {
    version: "2.8",
    date: "2026-10-20",
    title: "Download the desktop app",
    changes: ["The desktop app can now be downloaded right here, from the Get the desktop app link on the sign-in page and in Profile & appearance → Notifications (or go to /download)."],
  },
  {
    version: "2.7",
    date: "2026-10-20",
    title: "Notifications and a desktop app",
    changes: [
      "Get a notification and a chime for direct messages, @mentions, and @everyone while Huddle isn't the window you're looking at. Click one to jump to that conversation. Turn the parts you want on or off under Profile & appearance → Notifications.",
      "Huddle now has a desktop app for Windows, macOS and Linux, with notifications, an unread badge, and a tray icon so it keeps running when you close the window.",
    ],
  },
  {
    version: "2.6",
    date: "2026-10-19",
    title: "Delete servers and accounts",
    changes: [
      "Server owners can delete a server for good from Settings → Danger zone. You confirm by typing the server's name.",
      "You can delete your account from your profile. Your details are removed and your username frees up. Your old messages stay as \"Deleted user\" unless you choose to delete them too. Delete any servers you own first.",
    ],
  },
  {
    version: "2.5",
    date: "2026-10-19",
    title: "Emoji shortcodes and link previews",
    changes: [
      "Type :name: to send an emoji, like :joy: or :fire:. Start typing a name after a colon and suggestions pop up; press Enter or Tab to pick one. Put a backslash in front (\\:joy:) to type it literally.",
      "Every link in a message is now clickable and shows a preview card with the page's title, description, and picture. Links to pictures show the picture itself.",
      "Previews are fetched by the server, so the sites you link to never see who's looking. Links inside ||spoilers|| don't get a card, so they can't give the spoiler away.",
    ],
  },
  {
    version: "2.4",
    date: "2026-10-17",
    title: "Invite links and text formatting",
    changes: [
      "Invite is now a link you can paste anywhere. In chat it turns into a card with the server's icon and member count and a Join button, and the link works even before you've signed in.",
      "Format your messages: **bold**, *italic*, ***both***, and ||spoilers|| that stay hidden until clicked. Put a backslash in front of a symbol to type it literally.",
    ],
  },
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
