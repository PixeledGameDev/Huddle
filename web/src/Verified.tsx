/** The check mark on servers Huddle has verified. */
export function VerifiedBadge({ className = "" }: { className?: string }) {
  return (
    <svg className={`verified ${className}`.trim()} width="16" height="16" viewBox="0 0 24 24" role="img" aria-label="Verified server" focusable="false">
      <title>Verified server</title>
      <path fill="currentColor" d="M12 1.5l2.6 1.9 3.2-.1 1 3 2.6 1.9-1 3 1 3-2.6 1.9-1 3-3.2-.1L12 22.5l-2.6-1.9-3.2.1-1-3-2.6-1.9 1-3-1-3 2.6-1.9 1-3 3.2.1z" />
      <path fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M7.8 12.4l3 3 5.6-6" />
    </svg>
  );
}

/** The badge on servers that are run by Huddle itself. Only Huddle Admins can give it. */
export function OfficialBadge({ className = "" }: { className?: string }) {
  return (
    <svg className={`official ${className}`.trim()} width="16" height="16" viewBox="0 0 24 24" role="img" aria-label="Huddle Official server" focusable="false">
      <title>Huddle Official</title>
      <path fill="currentColor" d="M12 1.5l2.6 1.9 3.2-.1 1 3 2.6 1.9-1 3 1 3-2.6 1.9-1 3-3.2-.1L12 22.5l-2.6-1.9-3.2.1-1-3-2.6-1.9 1-3-1-3 2.6-1.9 1-3 3.2.1z" />
      <path fill="#fff" d="M12 6.8l1.5 3.2 3.5.4-2.6 2.4.7 3.5-3.1-1.8-3.1 1.8.7-3.5L7 10.4l3.5-.4z" />
    </svg>
  );
}

/** Which badge a server shows. Huddle Official wins over Verified when a server has both, so there's only ever one mark. */
export function ServerBadge({ verified, official }: { verified?: boolean; official?: boolean }) {
  if (official) return <OfficialBadge />;
  if (verified) return <VerifiedBadge />;
  return null;
}

export const serverBadgeLabel = (s: { verified?: boolean; official?: boolean }) => (s.official ? "Huddle Official" : s.verified ? "verified" : "");
