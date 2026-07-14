import type { ReactNode, SVGProps } from "react";

/**
 * Minimal line-icon set (1.75 stroke, rounded caps) — matches the reference's
 * quiet, premium iconography. All inherit `currentColor`.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 24, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ShieldCheck = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3 5 5.6v5.2c0 4.3 3 7 7 8.7 4-1.7 7-4.4 7-8.7V5.6L12 3Z" />
    <path d="m9 11.5 2 2 4-4" />
  </Base>
);

export const Activity = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 12h3.5L9 5.5l4 12 2.4-5.5H21" />
  </Base>
);

export const Clock = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Base>
);

export const User = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="8.5" r="3.75" />
    <path d="M5 19.5a7 7 0 0 1 14 0" />
  </Base>
);

export const ArrowRight = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12h13.5" />
    <path d="m13 6.5 5.5 5.5-5.5 5.5" />
  </Base>
);

export const ChevronRight = (p: IconProps) => (
  <Base {...p}>
    <path d="m9 5 7 7-7 7" />
  </Base>
);

export const ChevronLeft = (p: IconProps) => (
  <Base {...p}>
    <path d="m15 5-7 7 7 7" />
  </Base>
);

export const Bolt = (p: IconProps) => (
  <Base {...p}>
    <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z" />
  </Base>
);

export const HeartPulse = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 20.5C7 17 3.5 13.9 3.5 9.9A4.4 4.4 0 0 1 12 8a4.4 4.4 0 0 1 8.5 1.9c0 .8-.15 1.55-.42 2.26" />
    <path d="M13.5 12h2.2l1.3-2 2 4 1.5-2H23" />
  </Base>
);

export const MapPin = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 21c4.2-4.1 7-7.2 7-10.5a7 7 0 1 0-14 0C5 13.8 7.8 16.9 12 21Z" />
    <circle cx="12" cy="10.5" r="2.5" />
  </Base>
);

export const Coins = (p: IconProps) => (
  <Base {...p}>
    <ellipse cx="9" cy="7" rx="5.5" ry="2.6" />
    <path d="M3.5 7v4c0 1.44 2.46 2.6 5.5 2.6s5.5-1.16 5.5-2.6V7" />
    <path d="M9 13.5c-.66.34-1 .8-1 1.5 0 1.44 2.46 2.6 5.5 2.6S19 16.44 19 15c0-1.1-1.44-2.05-3.5-2.42" />
  </Base>
);

export const Dot = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  </Base>
);

export const Refresh = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.5 12a7.5 7.5 0 0 1 12.9-5.2L20 9" />
    <path d="M20 4.5V9h-4.5" />
    <path d="M19.5 12a7.5 7.5 0 0 1-12.9 5.2L4 15" />
    <path d="M4 19.5V15h4.5" />
  </Base>
);

export const Lock = (p: IconProps) => (
  <Base {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    <path d="M12 14.5v2" />
  </Base>
);

export const Settings = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.3M17.6 15.2l2.2 1.3M4.2 16.5l2.2-1.3M17.6 8.8l2.2-1.3" />
  </Base>
);

export const Grid = (p: IconProps) => (
  <Base {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.6" />
    <rect x="13" y="4" width="7" height="7" rx="1.6" />
    <rect x="4" y="13" width="7" height="7" rx="1.6" />
    <rect x="13" y="13" width="7" height="7" rx="1.6" />
  </Base>
);

export const AlertTriangle = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4.5 21 19.5H3L12 4.5Z" />
    <path d="M12 10v4" />
    <circle cx="12" cy="16.8" r="0.6" fill="currentColor" stroke="none" />
  </Base>
);

export const Bell = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </Base>
);

export const Wallet = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="6" width="17" height="13" rx="3" />
    <path d="M3.5 9.5h17" />
    <circle cx="16.5" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
  </Base>
);
