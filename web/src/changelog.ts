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
    version: "5.15",
    date: "2026-10-28",
    title: "Desktop app: far less memory in the tray",
    changes: [
      "Desktop app: after Huddle has been hidden in the tray for a few minutes, it now closes its window's page completely, which frees most of its memory. Opening it again rebuilds it in a second or two.",
      "While it's closed, a small connection keeps working: direct messages, @mentions and @everyone still pop up, the tray icon still shows the red dot, and you can still reply from the popup.",
      "Clicking a popup opens Huddle straight to that conversation. You can turn this off with “Free up memory when hidden in the tray” in the Huddle menu.",
      "Unread counts for messages that arrive while the window is unloaded aren't kept once you open Huddle again, but the messages are all there.",
    ],
  },
  {
    version: "5.14",
    date: "2026-10-28",
    title: "Lower memory use",
    changes: [
      "New Low memory mode in Settings → Theme: it turns off blur effects, animations and background pictures, and keeps fewer old messages loaded, so Huddle uses much less memory.",
      "Conversations you aren't looking at now only keep their newest messages in memory, and very long-running channels no longer grow without limit. Scroll up and use “Load earlier messages” to see older ones.",
      "Desktop app: new Memory usage item in the Huddle menu shows how much memory Huddle is using and which part uses it.",
    ],
  },
  {
    version: "5.13",
    date: "2026-10-28",
    title: "Huddle on your phone",
    changes: [
      "Huddle can now be installed like an app on your phone or computer. Open it in Chrome, Edge or Safari and use ⋯ → Install Huddle.",
      "Once installed it opens full screen with its own icon, fits around the notch and home bar, and opens faster.",
      "On iPhone and iPad, tap Share then Add to Home Screen. The ⋯ menu shows the steps.",
    ],
  },
  {
    version: "5.12",
    date: "2026-10-28",
    title: "Reply from notifications",
    changes: [
      "Desktop app: new messages now pop up in a small Huddle-styled card in the corner of your screen, with a box to type a reply and send it without opening Huddle.",
      "Each popup also has Mark as read and Open buttons. It stays while you're typing or pointing at it, and goes away by itself otherwise.",
      "More messages from the same conversation update the same popup instead of piling up, and up to three show at once.",
    ],
  },
  {
    version: "5.11",
    date: "2026-10-28",
    title: "Quick switcher",
    changes: [
      "Press Ctrl+K (Cmd+K on a Mac) to jump to any channel, conversation or server by typing a few letters.",
      "With nothing typed it shows what needs you first: anything with unread mentions or messages, then your recent conversations.",
      "Start with # to search only channels, or @ to search only people. Use the arrow keys and Enter, or click.",
      "It's also in the ⋯ menu as Quick switcher.",
    ],
  },
  {
    version: "5.10",
    date: "2026-10-28",
    title: "Unread dot in the desktop tray",
    changes: [
      "Desktop app: the tray icon now shows a red dot while you have unread mentions or messages, and goes back to normal when you've read them.",
      "The tray icon uses the new Huddle logo. The taskbar still shows your unread count, and the taskbar icon flashes until you come back to the window.",
    ],
  },
  {
    version: "5.9",
    date: "2026-10-28",
    title: "Desktop app 1.4",
    changes: [
      "The desktop app's splash screen now shows which version of Huddle you're running, so you can see when an update has installed.",
    ],
  },
  {
    version: "5.8",
    date: "2026-10-28",
    title: "Email removed",
    changes: [
      "Huddle no longer uses email at all. It wasn't working reliably, so adding an email, emailed codes and emailed security notices are gone.",
      "If you forget your password, choose “Forgot your password?” and enter the one-time reset code a Huddle Admin gives you.",
      "To keep your account safe without email, add a passkey or turn on two-factor sign-in in Settings → Account.",
    ],
  },
  {
    version: "5.7",
    date: "2026-10-27",
    title: "Passkeys",
    changes: [
      "You can now sign in with a passkey: your fingerprint, face, PIN or a security key, with no password to type or forget.",
      "Add one in Settings → Account → Passkeys. You can keep up to 10 and remove them any time.",
      "Passkeys can't be phished, and they count as two-factor on their own, so signing in with one skips the authenticator code.",
      "On the sign-in page, choose “Sign in with a passkey”. Your device offers the passkeys it has, so you don't even need to type your username.",
    ],
  },
  {
    version: "5.6",
    date: "2026-10-27",
    title: "A better desktop installer",
    changes: [
      "The Windows installer is now one click: no wizard pages, just a quick progress screen with the new Huddle logo, and Huddle opens when it's done.",
      "Huddle now has a proper Windows icon (taskbar, shortcuts and the installer all use the new logo).",
      "Installing no longer asks where to put Huddle. It goes in the right place automatically and updates itself from then on.",
    ],
  },
  {
    version: "5.5",
    date: "2026-10-27",
    title: "Desktop app updates on the splash screen",
    changes: [
      "The desktop app now looks for updates every time it opens, right on the splash screen, and installs them before showing Huddle.",
      "Updates install quietly and Huddle reopens by itself, so there's no installer window to click through.",
      "If the server is slow to answer (it can take a moment to wake up), the splash waits a little longer before giving up so you don't miss an update.",
    ],
  },
  {
    version: "5.4",
    date: "2026-10-27",
    title: "Much faster messaging",
    changes: [
      "Sending a message is now several times faster: Huddle checks everything it needs at the same time instead of one step after another.",
      "Huddle keeps its connection to the database warm, so the first message after a quiet spell is no longer slow.",
      "Signing in is remembered for a few seconds between requests, which speeds up everything you do in the app.",
    ],
  },
  {
    version: "5.3",
    date: "2026-10-27",
    title: "Settings, pronouns and member list sections",
    changes: [
      "Settings now has tabs: Profile, Theme, Startup, Notifications and Account. Saving your profile no longer closes the window.",
      "You can add pronouns to your profile. They show on your profile card, next to your username.",
      "Roles have a new Section name. Roles that are shown separately can use a heading of your choosing, and roles that share a name share one section in the member list (handy for grouping several roles under \"Staff\").",
      "Fixed the status menu (Online, Idle, Do not disturb, Invisible) getting cut off at the edge of the sidebar. The ⋯ menu got the same fix.",
      "When Huddle is updated while you have it open, a notice offers a one-click reload so you're never stuck on an old version.",
      "Desktop app: installers are now built for Windows only.",
    ],
  },
  {
    version: "5.2",
    date: "2026-10-26",
    title: "A new look for the front door",
    changes: [
      "The sign-in page is now a proper home page: it shows how many people are on Huddle, what Huddle can do, and a preview of the app.",
      "Huddle has a new logo, used across the app, the website and the desktop app.",
      "Confirmation boxes (deleting a message, leaving a server, blocking someone and so on) now look like the rest of Huddle instead of a plain browser popup. The desktop app's popups match too.",
      "Huddle Admins can put Huddle into maintenance for a set time. Everyone else sees a countdown, and Huddle comes back by itself when it ends.",
      "Desktop app: Huddle can now open when you sign in to your computer (on by default). You choose whether it shows its window or starts quietly in the tray. Find it in your profile settings or the Huddle menu.",
    ],
  },
  {
    version: "5.1",
    date: "2026-10-26",
    title: "Tidy up your messages",
    changes: [
      "You can now remove someone from your Messages list: hover a conversation and press ✕, or use Remove from messages in the panel beside the chat.",
      "Removing only hides it for you. Your chat history is kept, the other person isn't told, and the conversation comes back if either of you sends a new message or you open it again from their profile.",
    ],
  },
  {
    version: "5.0",
    date: "2026-10-22",
    title: "A whole new look",
    changes: [
      "Servers, channels, messages and friends now live in one navigation panel that you can show or hide with the menu button. It scales with your screen: pinned on a computer, a slide-over on a tablet and a full-height drawer on a phone.",
      "The member list groups people by role (owner, then each role that has Show members with this role separately switched on). Names slide in and out as people come online or go offline.",
      "Click anyone to open their profile: their roles and every moderation action (time out, kick, ban, vote) now live there.",
      "You can give yourself roles you're allowed to, the owner can hold roles too, and roles can be made self-service so anyone can pick them for themselves.",
      "Buttons get a soft shine when you hover them, and the whole interface follows your theme.",
      "Desktop app 1.2: no more File/Edit/View bar. Huddle has its own title bar, and the logo opens the Huddle menu. The splash screen is new too.",
    ],
  },
  {
    version: "4.8",
    date: "2026-10-22",
    title: "Custom themes (desktop app)",
    changes: [
      "In the desktop app, Profile & appearance → Custom themes lets you design your own look: pick every color, or start from a preset (Midnight, Sunset, Forest, Paper, Rose, High contrast).",
      "Add background pictures from your own computer for the whole window, the chat area or the sidebar. They stay on your computer and are never uploaded.",
      "Export a theme to a file to share it, or import one someone sent you.",
    ],
  },
  {
    version: "4.7",
    date: "2026-10-22",
    title: "Desktop app: automatic updates and a splash screen",
    changes: [
      "The desktop app (1.1 and newer) shows a splash screen while it starts, and checks for updates first: if there is one it downloads and installs it before opening Huddle.",
      "While it's open it keeps checking, and tells you when an update is ready (Restart now). Huddle → Check for updates… checks on demand.",
    ],
  },
  {
    version: "4.6",
    date: "2026-10-22",
    title: "Server emoji and stickers",
    changes: [
      "Servers can have their own emoji (up to 50) and stickers (up to 20). People with the new Manage emoji and stickers permission add them in Settings → Emoji & stickers.",
      "Use custom emoji in messages (type : and the name) and as reactions. Stickers are sent from the sticker button next to the message box. They only work in the server they belong to.",
    ],
  },
  {
    version: "4.5",
    date: "2026-10-22",
    title: "Verified servers and audit logs",
    changes: [
      "Servers Huddle has verified show a check mark next to their name, on invites and in mutual servers.",
      "A server's Activity tab now covers joins and leaves, channel changes, icon changes and role changes, can be filtered by type, and loads older entries.",
      "Huddle Admins get an audit log of everything they have done, and can verify servers from their panel.",
    ],
  },
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
