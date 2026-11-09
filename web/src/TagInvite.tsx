import { useEffect, useState } from "react";
import { api } from "./api";
import { InviteEmbed } from "./Invites";
import { Modal } from "./Modals";
import type { ServerSummary } from "./types";

/** Opens when someone clicks a server tag that offers an invite and you aren't in that server yet: shows the server's invite card. */
export function TagInviteModal({ serverId, tag, onClose, onJoin, onOpen }: {
  serverId: string;
  tag: string;
  onClose: () => void;
  onJoin: (code: string) => Promise<ServerSummary | null>;
  onOpen: (serverId: string) => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setCode(null);
    setError(null);
    api<{ code: string }>(`/servers/${serverId}/tag-invite`, "POST").then(
      (r) => live && setCode(r.code),
      (e) => live && setError(e instanceof Error ? e.message : "Couldn't load this server's invite.")
    );
    return () => { live = false; };
  }, [serverId]);
  return (
    <Modal title={`${tag} server`} onClose={onClose}>
      {error ? <p className="muted">{error}</p> : code ? (
        <InviteEmbed code={code} onJoin={onJoin} onOpen={(id) => { onOpen(id); onClose(); }} />
      ) : <p className="muted">Loading invite…</p>}
    </Modal>
  );
}
