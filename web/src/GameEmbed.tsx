import { useEffect, useRef, useState } from "react";

/**
 * A bot's game, shown under the message its /play command sent. Nothing loads until Play is pressed. The game runs in a
 * sandboxed frame, so it can't see anything about the account or the rest of Huddle.
 */
export function GameEmbed({ botId, botName, onLayout }: { botId: string; botName: string; onLayout: () => void }) {
  const [playing, setPlaying] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const layout = useRef(onLayout);
  layout.current = onLayout;
  useEffect(() => layout.current(), [playing]);
  const src = `/games/${botId}`;

  return (
    <div className="game-embed">
      <div className="game-embed-bar">
        <strong>Game from {botName}</strong>
        <span className="game-embed-actions">
          {playing && <a className="msg-link" href={src} target="_blank" rel="noopener noreferrer">Open in a tab</a>}
          <button type="button" className={playing ? "icon" : "primary"} onClick={() => setPlaying((p) => !p)}>{playing ? "Close" : "Play"}</button>
        </span>
      </div>
      {playing && (
        <iframe
          ref={frame}
          className="game-embed-frame"
          src={src}
          title={`Game from ${botName}`}
          sandbox="allow-scripts allow-popups"
          allow="clipboard-write"
          referrerPolicy="no-referrer"
          onLoad={() => frame.current?.focus()}
        />
      )}
    </div>
  );
}
