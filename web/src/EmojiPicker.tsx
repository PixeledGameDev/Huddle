import { Emoji } from "./Rich";
import { EMOJI_GROUPS } from "./util";

export default function EmojiPicker({ onPick, className = "" }: { onPick: (emoji: string) => void; className?: string }) {
  return (
    <div className={`picker ${className}`} role="menu" onClick={(e) => e.stopPropagation()}>
      {EMOJI_GROUPS.map((g) => (
        <div key={g.label}>
          <div className="picker-label">{g.label}</div>
          <div className="picker-grid">
            {g.emojis.map((e) => (
              <button key={e} role="menuitem" aria-label={e} onClick={() => onPick(e)}><Emoji emoji={e} /></button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
