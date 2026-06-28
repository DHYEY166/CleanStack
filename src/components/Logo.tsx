import type { SVGProps } from "react";

/**
 * CleanStack brand colors
 * - indigo  #4F46E5  (primary)
 * - emerald #10B981  (accent)
 * - slate   #0F172A  (dark background)
 */
const INDIGO = "#4F46E5";
const EMERALD = "#10B981";
const SLATE = "#0F172A";

/* -------------------------------------------------------------------------- */
/*  Icon                                                                      */
/* -------------------------------------------------------------------------- */

type CleanStackIconProps = SVGProps<SVGSVGElement> & {
  /** Pixel size for width & height. Defaults to 32. */
  size?: number;
  /** Color of the top "messy" data bars. Defaults to brand indigo. */
  messyColor?: string;
  /** Color of the bottom "clean" data bars. Defaults to brand emerald. */
  cleanColor?: string;
};

/**
 * Standalone CleanStack mark: a stack of horizontal data layers.
 * The top layers are fragmented/jagged (dirty data) and resolve into
 * solid, uniform bars at the bottom (clean data).
 *
 * Uses solid fills only — no gradients — so it stays crisp at any size
 * and reproduces reliably on both dark and light backgrounds.
 */
export function CleanStackIcon({
  size = 32,
  messyColor = INDIGO,
  cleanColor = EMERALD,
  ...props
}: CleanStackIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="CleanStack"
      {...props}
    >
      {/* Top layer — messy / fragmented (dirty data) */}
      <rect x="6" y="5" width="9" height="5" rx="2" fill={messyColor} />
      <rect x="17" y="5" width="5" height="5" rx="2" fill={messyColor} />
      <rect x="24" y="5" width="10" height="5" rx="2" fill={messyColor} />

      {/* Second layer — still messy */}
      <rect x="6" y="13" width="6" height="5" rx="2" fill={messyColor} />
      <rect x="14" y="13" width="11" height="5" rx="2" fill={messyColor} />
      <rect x="27" y="13" width="7" height="5" rx="2" fill={messyColor} />

      {/* Third layer — clean / uniform */}
      <rect x="6" y="21" width="28" height="5" rx="2.5" fill={cleanColor} />

      {/* Fourth layer — clean / uniform */}
      <rect x="6" y="29" width="28" height="5" rx="2.5" fill={cleanColor} />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Favicon / app-icon (square with rounded background)                       */
/* -------------------------------------------------------------------------- */

type CleanStackAppIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
  /** Rounded-square background color. Defaults to brand slate. */
  background?: string;
};

/**
 * Square, self-contained icon for favicons and app icons. Wraps the mark in a
 * rounded slate tile so it stays legible on any surface (light or dark).
 */
export function CleanStackAppIcon({
  size = 64,
  background = SLATE,
  ...props
}: CleanStackAppIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="CleanStack"
      {...props}
    >
      <rect width="64" height="64" rx="14" fill={background} />
      <g>
        {/* messy top layers (dirty data) */}
        <rect x="14" y="10" width="15" height="8" rx="3" fill={INDIGO} />
        <rect x="32" y="10" width="8" height="8" rx="3" fill={INDIGO} />
        <rect x="43" y="10" width="7" height="8" rx="3" fill={INDIGO} />

        <rect x="14" y="22" width="10" height="8" rx="3" fill={INDIGO} />
        <rect x="27" y="22" width="17" height="8" rx="3" fill={INDIGO} />
        <rect x="47" y="22" width="3" height="8" rx="1.5" fill={INDIGO} />

        {/* clean bottom layers (clean data) */}
        <rect x="14" y="34" width="36" height="8" rx="4" fill={EMERALD} />
        <rect x="14" y="46" width="36" height="8" rx="4" fill={EMERALD} />
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Full logo lock-up (icon + wordmark)                                       */
/* -------------------------------------------------------------------------- */

type CleanStackLogoProps = {
  /** Icon size in px (the wordmark scales with font size). Defaults to 32. */
  iconSize?: number;
  /** Extra classes for the wrapping element. */
  className?: string;
  /** Tailwind text-size class for the wordmark. Defaults to "text-xl". */
  wordmarkClassName?: string;
};

/**
 * Horizontal lock-up: mark on the left, "CleanStack" wordmark on the right.
 *
 * The wordmark uses `currentColor` for "Clean" so it adapts to dark or light
 * surfaces, with "Stack" set in brand indigo for a subtle two-tone accent.
 * Set the surrounding text color (e.g. `text-white` or `text-slate-900`) to
 * control the adaptive half.
 */
export function CleanStackLogo({
  iconSize = 32,
  className = "",
  wordmarkClassName = "text-xl",
}: CleanStackLogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <CleanStackIcon size={iconSize} />
      <span className={`font-bold tracking-tight leading-none ${wordmarkClassName}`}>
        <span style={{ color: "currentColor" }}>Clean</span>
        <span style={{ color: INDIGO }}>Stack</span>
      </span>
    </span>
  );
}

export default CleanStackLogo;
