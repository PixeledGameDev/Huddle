import { useEffect, useState } from "react";
import { hue } from "./util";

export function Avatar({ id, name, version, accent, size = 38 }: { id: string; name: string; version: number; accent?: string | null; size?: number }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [version]);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (version > 0 && !bad) {
    return <img className="avatar" style={style} src={`/api/users/${id}/avatar?v=${version}`} alt="" onError={() => setBad(true)} />;
  }
  return (
    <span className="avatar" style={{ ...style, background: accent ?? `hsl(${hue(name)} 45% 42%)` }} aria-hidden="true">
      {name[0]?.toUpperCase()}
    </span>
  );
}
