/** What the Huddle desktop app (see /desktop) adds to the page. Absent in a normal browser. */
interface HuddleDesktopBridge {
  isDesktop: true;
  platform: string;
  version: string;
  notify(n: { title: string; body: string; tag?: string; target?: { serverId: string; channelId: string } }): void;
  setBadge(count: number, iconDataUrl: string | null): void;
  onNotificationClick(cb: (target: { serverId: string; channelId: string } | null) => void): () => void;
  /** Present from desktop app 1.2 on: Huddle draws its own title bar and the logo opens the Huddle menu. */
  titleBar?: { height: number; openMenu(x: number, y: number): void; setColors(color: string, symbolColor: string): void };
  /** Present from desktop app 1.1 on (older installs don't have them). */
  getUpdateState?(): Promise<DesktopUpdateState | null>;
  onUpdateState?(cb: (state: DesktopUpdateState) => void): () => void;
  checkForUpdates?(): Promise<DesktopUpdateState | null>;
  installUpdate?(): void;
}
interface DesktopUpdateState { status: "idle" | "checking" | "downloading" | "ready" | "error" | "unsupported"; version?: string; percent?: number; message?: string; upToDate?: boolean }
interface Window {
  huddleDesktop?: HuddleDesktopBridge;
}
