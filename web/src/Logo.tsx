/** The Huddle mark: a rounded H with a dot on each side of the bar. Inline so it never flashes in and scales with the `height` you give `.mark`. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <svg className={`mark ${className}`.trim()} viewBox="56 46 144 164" aria-hidden="true" focusable="false">
      <g fill="#3556d8">
        <path d="M107 58H85a16 16 0 0 0-16 16v107a16 16 0 0 0 16 16h22z" />
        <path d="M148 58h22a16 16 0 0 1 16 16v107a16 16 0 0 1-16 16h-22z" />
        <rect x="104" y="104" width="46" height="31" />
      </g>
      <circle cx="92" cy="119.5" r="12.5" fill="#fff" />
      <circle cx="164" cy="119.5" r="12.5" fill="#fff" />
    </svg>
  );
}
