import { cn } from "@/lib/utils";

// Slack-style workspace initials avatar. No upload UI in v1 — just a rounded
// square with the workspace's initials on a deterministic background color
// hashed from its id, so the same workspace always looks the same.
//
// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.1 (initials avatar; eight
// muted Tailwind tones; accessible foreground contrast).

// Eight muted Tailwind palette tones. Each row pairs a background class with a
// foreground class that's been visually checked for accessible contrast.
const PALETTE = [
  { bg: "bg-blue-200",    fg: "text-blue-900" },
  { bg: "bg-emerald-200", fg: "text-emerald-900" },
  { bg: "bg-amber-200",   fg: "text-amber-900" },
  { bg: "bg-rose-200",    fg: "text-rose-900" },
  { bg: "bg-violet-200",  fg: "text-violet-900" },
  { bg: "bg-cyan-200",    fg: "text-cyan-900" },
  { bg: "bg-orange-200",  fg: "text-orange-900" },
  { bg: "bg-fuchsia-200", fg: "text-fuchsia-900" },
];

function hashStringToIndex(s: string, mod: number): number {
  // Cheap and deterministic. Identical ids => identical color across renders
  // and sessions.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % mod;
}

function deriveInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // Pull initials from the first two whitespace-separated tokens; fallback to
  // the first two characters. Length is locale-aware via Array.from so emoji
  // and multi-byte glyphs survive cleanly.
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    return (Array.from(tokens[0])[0] ?? "") + (Array.from(tokens[1])[0] ?? "");
  }
  const chars = Array.from(tokens[0]);
  return (chars[0] ?? "") + (chars[1] ?? "");
}

export interface WorkspaceAvatarProps {
  id: string;
  name: string | null | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_CLASSES = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-9 w-9 text-sm",
} as const;

export function WorkspaceAvatar({ id, name, size = "sm", className }: WorkspaceAvatarProps) {
  const initials = deriveInitials(name ?? "").toUpperCase();
  const color = PALETTE[hashStringToIndex(id, PALETTE.length)];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold uppercase",
        SIZE_CLASSES[size],
        color.bg,
        color.fg,
        className,
      )}
    >
      {initials}
    </span>
  );
}
