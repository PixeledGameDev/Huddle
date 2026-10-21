import { nameOfUser } from "./util";

/** A person's display name, drawn in the font they picked. */
export function Name({ user, className = "" }: { user: { username: string; displayName: string | null; nameFont?: string }; className?: string }) {
  const f = user.nameFont && user.nameFont !== "default" ? ` nf-${user.nameFont}` : "";
  return <span className={`${className}${f}`.trim() || undefined}>{nameOfUser(user)}</span>;
}
