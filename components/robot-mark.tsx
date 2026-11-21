export function RobotMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="3.5" y="8" width="17" height="10" rx="2.5" />
      <path d="M12 8V4.5" />
      <circle cx="12" cy="3.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12.5" r="1.4" />
      <circle cx="15" cy="12.5" r="1.4" />
      <path d="M9.5 15.5h5" />
      <path d="M1.5 11v4M22.5 11v4" />
    </svg>
  );
}
