import { Emoji } from "./Rich";
import { useServerAssets } from "./ServerAssets";
import { EMOJI_GROUPS } from "./util";

export default function EmojiPicker({ onPick, className = "" }: { onPick: (emoji: string) => void; className?: string }) {
  const { emojis } = useServerAssets();
  return (
    <div className={`picker ${className}`} role="menu" onClick={(e) => e.stopPropagation()}>
      {emojis.length > 0 && (
        <div>
          <div className="picker-label">This server</div>
          <div className="picker-grid">
            {emojis.map((e) => (
              <button key={e.id} role="menuitem" aria-label={e.name} title={`:${e.name}:`} onClick={() => onPick(`<:${e.name}:${e.id}>`)}><Emoji emoji={`<:${e.name}:${e.id}>`} /></button>
            ))}
          </div>
        </div>
      )}
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
