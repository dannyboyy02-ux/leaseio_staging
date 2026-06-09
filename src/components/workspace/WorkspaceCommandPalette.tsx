import { useEffect, useMemo, useState } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useAppTranslation } from "@/hooks/useAppTranslation";
import { useApp, type WorkspaceBasic } from "@/contexts/AppContext";
import { WorkspaceAvatar } from "./WorkspaceAvatar";

// Slack-style universal workspace picker. Opened by Cmd/Ctrl+K (or by tapping
// the "Search workspaces…" row in the sidebar dropdown on mobile, where the
// keyboard shortcut is unreachable).
//
// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.1 + §P2.11 (Cmd+K rules).
//
// Order: active workspace marker → recent (last 3 switched-to, when the user
// owns/membership ≥ 5 total workspaces, else suppressed as noise) → alpha → a
// pinned "+ New workspace" entry when the caller is create-eligible.

const RECENTS_KEY = "lease:recentWorkspaces";
const RECENT_THRESHOLD = 5;

interface WorkspaceCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True iff the current user is eligible to create a new workspace. */
  canCreate: boolean;
  onCreate: () => void;
}

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function pushRecentWorkspace(id: string) {
  // Side-effect helper used by the sidebar's switch action. Keeps the recent
  // list bounded at 3 with newest first.
  try {
    const current = readRecents();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, 3);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — silently no-op */
  }
}

export function clearRecentWorkspaces() {
  try {
    localStorage.removeItem(RECENTS_KEY);
  } catch {
    /* noop */
  }
}

export function WorkspaceCommandPalette({
  open,
  onOpenChange,
  canCreate,
  onCreate,
}: WorkspaceCommandPaletteProps) {
  const { t } = useAppTranslation();
  const { workspace, availableWorkspaces, switchWorkspace } = useApp();
  const [recents, setRecents] = useState<string[]>([]);

  // Refresh the recent list when the palette opens (not on every render).
  useEffect(() => {
    if (open) setRecents(readRecents());
  }, [open]);

  const totalCount = availableWorkspaces.length;
  const byId = useMemo(() => {
    const m = new Map<string, WorkspaceBasic>();
    for (const w of availableWorkspaces) m.set(w.id, w);
    return m;
  }, [availableWorkspaces]);

  const recentWorkspaces: WorkspaceBasic[] =
    totalCount >= RECENT_THRESHOLD
      ? recents
          .map((id) => byId.get(id))
          .filter((w): w is WorkspaceBasic => Boolean(w) && w!.id !== workspace?.id)
      : [];
  const recentIds = new Set(recentWorkspaces.map((w) => w.id));

  const alphaWorkspaces = [...availableWorkspaces]
    .filter((w) => w.id !== workspace?.id && !recentIds.has(w.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  function handleSelect(workspaceId: string) {
    void switchWorkspace(workspaceId);
    pushRecentWorkspace(workspaceId);
    onOpenChange(false);
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={t("workspace.create.search_placeholder")} />
      <CommandList>
        <CommandEmpty>{t("common.no_results", { defaultValue: "No results." })}</CommandEmpty>

        {workspace ? (
          <CommandGroup heading={t("workspace.create.search_placeholder")}>
            <CommandItem disabled value={`current-${workspace.id}`}>
              <WorkspaceAvatar id={workspace.id} name={workspace.name} size="sm" className="mr-2" />
              <span className="flex-1 truncate">{workspace.name}</span>
              <span className="text-xs text-muted-foreground">●</span>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {recentWorkspaces.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent">
              {recentWorkspaces.map((w) => (
                <CommandItem key={w.id} value={w.name} onSelect={() => handleSelect(w.id)}>
                  <WorkspaceAvatar id={w.id} name={w.name} size="sm" className="mr-2" />
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.subscription_status === "incomplete" || w.subscription_status === "incomplete_expired" ? (
                    <span className="text-xs text-muted-foreground">
                      {t("workspace.create.pending_badge")}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {alphaWorkspaces.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="All workspaces">
              {alphaWorkspaces.map((w) => (
                <CommandItem key={w.id} value={w.name} onSelect={() => handleSelect(w.id)}>
                  <WorkspaceAvatar id={w.id} name={w.name} size="sm" className="mr-2" />
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.subscription_status === "incomplete" || w.subscription_status === "incomplete_expired" ? (
                    <span className="text-xs text-muted-foreground">
                      {t("workspace.create.pending_badge")}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {canCreate ? (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__new_workspace__"
                onSelect={() => {
                  onOpenChange(false);
                  onCreate();
                }}
              >
                <span className="flex-1">{t("workspace.create.cta_palette")}</span>
              </CommandItem>
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
