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
