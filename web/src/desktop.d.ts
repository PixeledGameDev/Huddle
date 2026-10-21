/** What the Huddle desktop app (see /desktop) adds to the page. Absent in a normal browser. */
interface HuddleDesktopBridge {
  isDesktop: true;
  platform: string;
  version: string;
  notify(n: { title: string; body: string; tag?: string; target?: { serverId: string; channelId: string } }): void;
  setBadge(count: number, iconDataUrl: string | null): void;
  onNotificationClick(cb: (target: { serverId: string; channelId: string } | null) => void): () => void;
}
interface Window {
  huddleDesktop?: HuddleDesktopBridge;
}
