import { useState } from "react";
import type { Attachment } from "./types";
import { fmtSize } from "./util";

/**
 * A video attachment, played right in the chat with the browser's own controls (play, seek, volume, fullscreen).
 * Only the start of the file is fetched until you press play. Some videos use a format this browser can't play
 * (for example phone recordings in HEVC on Chrome or Firefox); then it falls back to a download link.
 */
export function VideoPlayer({ a, onLayout }: { a: Attachment; onLayout: () => void }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/files/${a.id}`;

  if (failed)
    return (
      <div className="vid-fail">
        <a className="file" href={src} download={a.name}>
          <span className="file-ext">{a.name.includes(".") ? a.name.split(".").pop()!.slice(0, 4).toUpperCase() : "VIDEO"}</span>
          <span className="file-info"><strong>{a.name}</strong><small>{fmtSize(a.size)}</small></span>
        </a>
        <small className="muted">This browser can't play this video. Download it to watch.</small>
      </div>
    );

  return (
    <div className="vid">
      {/* #t=0.001 makes iPhones show the first frame instead of a black box */}
      <video src={`${src}#t=0.001`} controls preload="metadata" playsInline aria-label={a.name} onLoadedMetadata={onLayout} onError={() => setFailed(true)} />
      <div className="vid-meta">
        <span title={a.name}>{a.name} · {fmtSize(a.size)}</span>
        <a href={src} download={a.name}>Download</a>
      </div>
    </div>
  );
}
