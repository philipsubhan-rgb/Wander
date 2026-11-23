/**
 * MarcoAvatar — Marco's face in conversation (design Decision 7).
 *
 * A small inline SVG mark, no image assets: a globe in the app's Blue
 * Ocean primary with a coral destination dot — the same motif as the
 * app icon (globe + route + pin) and Marco's globe character, drawn to
 * stay legible at chat-bubble sizes.
 */

interface MarcoAvatarProps {
  /** Tailwind size classes for the disc, e.g. "h-7 w-7". */
  className?: string;
}

export default function MarcoAvatar({ className = "h-7 w-7" }: MarcoAvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-[72%] w-[72%]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="8.2" />
        <ellipse cx="12" cy="12" rx="3.6" ry="8.2" />
        <path d="M3.8 12h16.4" />
        <path d="M5.2 6.9c4.3 1.9 9.3 1.9 13.6 0" />
        <path d="M5.2 17.1c4.3-1.9 9.3-1.9 13.6 0" />
        <circle cx="17.6" cy="6.2" r="1.5" fill="#ff7a59" stroke="none" />
      </svg>
    </span>
  );
}
