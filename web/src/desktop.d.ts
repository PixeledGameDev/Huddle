/** What the Huddle desktop app (see /desktop) adds to the page. Absent in a normal browser. */
interface HuddleDesktopBridge {
  isDesktop: true;
  platform: string;
  version: string;
  notify(n: { title: string; body: string; tag?: string; target?: { serverId: string; channelId: string } }): void;
  setBadge(count: number, iconDataUrl: string | null): void;
  /** Present from desktop app 1.9 on: the app's version, and the version it was just updated from (once, the first time the page loads after an update). */
  getUpdateInfo?(): Promise<{ version: string; justUpdatedFrom: string | null } | null>;
  /** Present from desktop app 1.7 on: lets the app keep popups working while its page is unloaded to save memory. */
  syncNotifyPrefs?(prefs: object): void;
  pageReady?(): void;
  /** Present from desktop app 1.4 on: reply to or mark read from a notification popup. */
  onNotificationReply?(cb: (r: { id: number; target: { serverId: string; channelId: string }; text: string }) => void): () => void;
  replyResult?(id: number, ok: boolean, error?: string): void;
  onNotificationMarkRead?(cb: (target: { serverId: string; channelId: string }) => void): () => void;
  onNotificationClick(cb: (target: { serverId: string; channelId: string } | null) => void): () => void;
  /** Present from desktop app 1.2 on: Huddle draws its own title bar and the logo opens the Huddle menu. */
  titleBar?: { height: number; openMenu(x: number, y: number): void; setColors(color: string, symbolColor: string): void };
  /** Present from desktop app 1.1 on (older installs don't have them). */
  getUpdateState?(): Promise<DesktopUpdateState | null>;
  onUpdateState?(cb: (state: DesktopUpdateState) => void): () => void;
  checkForUpdates?(): Promise<DesktopUpdateState | null>;
  installUpdate?(): void;
  /** Present from desktop app 1.3 on. */
  getStartup?(): Promise<{ supported: boolean; launch: boolean; background: boolean } | null>;
  setStartup?(v: { launch: boolean; background: boolean }): Promise<{ supported: boolean; launch: boolean; background: boolean } | null>;
  /** Present from desktop app 1.9.2 on: showing as Idle to others after time away from the computer (or a locked screen). `idle` is true right now. */
  getIdleSettings?(): Promise<DesktopIdleSettings | null>;
  /** Present from desktop app 1.9.4 on: global shortcuts that work from any program (see HotkeySettings.tsx). */
  getHotkeys?(): Promise<import("./hotkeys").DesktopHotkeys | null>;
  setHotkeys?(hotkeys: Record<import("./hotkeys").HotkeyAction, string>): Promise<import("./hotkeys").DesktopHotkeys | null>;
  pauseHotkeys?(paused: boolean): void;
  /** A shortcut asks the page to open the quick switcher or jump to the next unread message. */
  onCommand?(cb: (command: "switcher" | "unread") => void): () => void;
  /** Present from desktop app 1.9.3 on: progress (0 to 1, or -1 for none) on the taskbar button while files upload. */
  setProgress?(fraction: number): void;
  setIdleSettings?(v: { enabled: boolean; minutes: number }): Promise<DesktopIdleSettings | null>;
  onIdleChange?(cb: (idle: boolean) => void): () => void;
}
interface DesktopIdleSettings { enabled: boolean; minutes: number; idle: boolean }
interface DesktopUpdateState { status: "idle" | "checking" | "downloading" | "ready" | "error" | "unsupported"; version?: string; percent?: number; message?: string; upToDate?: boolean }
interface Window {
  huddleDesktop?: HuddleDesktopBridge;
}
