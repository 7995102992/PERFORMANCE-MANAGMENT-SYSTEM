import { useMemo, useState } from "react";
import { useLocation, useNavigate, Link } from "@tanstack/react-router";
import {
  ChevronDown,
  HelpCircle,
  LogOut,
  Moon,
  Settings,
  Sun,
  type LucideIcon,
} from "lucide-react";
import logoIcon from "@/assets/logo-icon.svg";
import { cn } from "@/lib/utils";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { sidebarMenuConfig } from "./menu-config";
import { filterMenuByPermissions, gateAnalyticsRoles } from "@/lib/permissions";
import {
  useGetSrAnalyticsRolesQuery,
  useGetRequestsQuery,
  useGetApprovalCountsQuery,
} from "@/store/api/srmApi";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { useAppSelector, useAppDispatch } from "@/store";
import { useLogoutMutation } from "@/store/api/iamApi";
import { resetAllApiState } from "@/store";
import type { MenuBadgeKey, MenuGroup, MenuItem } from "./menu-config";

// Collapsed: shrink to a 36×36 rounded pill centered in the strip.
// Background from ITEM_ACTIVE is preserved so the pill shows for active items.
const COLLAPSED =
  "group-data-[collapsible=icon]:!h-9 " +
  "group-data-[collapsible=icon]:!w-9 " +
  "group-data-[collapsible=icon]:!p-0 " +
  "group-data-[collapsible=icon]:mx-auto " +
  "group-data-[collapsible=icon]:justify-center " +
  "group-data-[collapsible=icon]:items-center " +
  "group-data-[collapsible=icon]:rounded-lg";

// Inactive: clearly muted. Hover: subtle pill. Even more muted in collapsed.
const ITEM_BASE =
  "flex w-full h-9 items-center gap-2 overflow-hidden rounded-lg px-3 text-sm font-medium " +
  "text-sidebar-foreground/55 transition-colors duration-150 " +
  "hover:bg-sidebar-accent/60 hover:text-sidebar-foreground";

// Active: full-width pill in expanded; 36×36 pill in collapsed (via COLLAPSED sizing).
const ITEM_ACTIVE = "!bg-sidebar-accent text-sidebar-foreground";

export function AppSidebar() {
  const location = useLocation();
  const user = useAuth();
  const isActive = (path: string) => location.pathname === path;

  // SR analytics persona items (tagged `analyticsRole`) are gated by backend
  // entitlement (grant OR derived), not static permissions — see gateAnalyticsRoles.
  const { data: srRoles } = useGetSrAnalyticsRolesQuery();
  const srEntitled = useMemo(
    () => new Set((srRoles?.roles ?? []).map((r) => r.role)),
    [srRoles],
  );

  const filteredMenu = useMemo(
    () =>
      gateAnalyticsRoles(
        filterMenuByPermissions(sidebarMenuConfig, user),
        srEntitled,
        !!srRoles,
      ),
    [user, srEntitled, srRoles],
  );

  const hasActiveDescendant = (
    children: { path?: string; children?: { path?: string }[] }[],
  ) => {
    return children.some(
      (c) =>
        (c.path && isActive(c.path)) ||
        (c.children && hasActiveDescendant(c.children)),
    );
  };

  const defaultOpen = useMemo(() => {
    for (const section of filteredMenu) {
      for (const group of section.groups) {
        if (hasActiveDescendant(group.children)) return group.key;
      }
    }
    return "dashboard";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [openKey, setOpenKey] = useState<string | null>(defaultOpen);

  // Sub-groups (e.g. PMS > Configuration) that contain the current page start open.
  const [openSubKeys, setOpenSubKeys] = useState<Set<string>>(() => {
    const keys = new Set<string>();
    for (const section of filteredMenu) {
      for (const group of section.groups) {
        for (const child of group.children) {
          if (child.children && hasActiveDescendant(child.children)) keys.add(child.key);
        }
      }
    }
    return keys;
  });

  const toggleSubKey = (key: string) => {
    setOpenSubKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white">
                  <img src={logoIcon} alt="Sentrifugo" className="size-6" />
                </div>
                <div className="flex flex-col text-left leading-tight">
                  <span className="text-lg font-bold text-sidebar-foreground">
                    Sentrifugo
                  </span>
                  <span className="text-[10px] leading-snug text-sidebar-foreground/40">
                    Innovate . Automate . Empower
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {filteredMenu.map((section, idx) => (
          <SidebarGroup
            key={section.sectionTitle}
            className={cn(idx > 0 && "pt-0")}
          >
            {section.sectionTitle !== "Main" && (
              <div className="mx-3 mb-2 flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/35 group-data-[collapsible=icon]:hidden">
                  {section.sectionTitle}
                </span>
                <div className="h-px flex-1 bg-sidebar-border group-data-[collapsible=icon]:hidden" />
              </div>
            )}
            <SidebarMenu className="gap-1">
              {section.groups.map((group) =>
                group.children.length === 1 && !group.forceExpand ? (
                  <SingleMenuItem
                    key={group.key}
                    group={group}
                    isActive={isActive}
                  />
                ) : (
                  <MultiMenuItem
                    key={group.key}
                    group={group}
                    isActive={isActive}
                    openKey={openKey}
                    setOpenKey={setOpenKey}
                    openSubKeys={openSubKeys}
                    toggleSubKey={toggleSubKey}
                  />
                ),
              )}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="pb-1">
        <UtilityFooter />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

// ─── Single-child nav item ────────────────────────────────────────────────────

function SingleMenuItem({
  group,
  isActive,
}: {
  group: MenuGroup;
  isActive: (path: string) => boolean;
}) {
  const child = group.children[0];
  const active = isActive(child.path);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={group.label}
        className={cn(ITEM_BASE, active && ITEM_ACTIVE, COLLAPSED)}
      >
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Link to={child.path as any}>
          <group.icon className="size-4 shrink-0" />
          <span className="flex-1 group-data-[collapsible=icon]:hidden">
            {group.label}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// ─── Multi-child nav item ─────────────────────────────────────────────────────
// Expanded  → collapsible accordion inline
// Collapsed → floating popover to the right of the sidebar

function MultiMenuItem({
  group,
  isActive,
  openKey,
  setOpenKey,
  openSubKeys,
  toggleSubKey,
}: {
  group: MenuGroup;
  isActive: (path: string) => boolean;
  openKey: string | null;
  setOpenKey: (key: string | null) => void;
  openSubKeys: Set<string>;
  toggleSubKey: (key: string) => void;
}) {
  const { state: sidebarState } = useSidebar();
  const isCollapsed = sidebarState === "collapsed";
  const hasActiveChild = group.children.some(
    (c) =>
      (c.path && isActive(c.path)) ||
      c.children?.some((sc) => sc.path && isActive(sc.path)),
  );
  const isOpen = openKey === group.key;
  const [popoverOpen, setPopoverOpen] = useState(false);

  // ── Collapsed: floating popover ──────────────────────────────────────────
  if (isCollapsed) {
    return (
      <SidebarMenuItem>
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <Tooltip open={popoverOpen ? false : undefined}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    ITEM_BASE,
                    COLLAPSED,
                    hasActiveChild ? ITEM_ACTIVE : "text-sidebar-foreground/40",
                  )}
                >
                  <group.icon className="size-4 shrink-0" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">{group.label}</TooltipContent>
          </Tooltip>

          <PopoverContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-52 border-sidebar-border bg-sidebar p-1 shadow-xl gap-1"
          >
            <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
              {group.label}
            </p>

            {group.children.map((child) => {
              if (child.children) {
                return (
                  <div key={child.key}>
                    <p className="px-3 pt-2 pb-0.5 text-[11px] font-semibold text-sidebar-foreground/60">
                      {child.label}
                    </p>
                    {child.children.map((sub) => {
                      const active = sub.path ? isActive(sub.path) : false;
                      return (
                        <Link
                          key={sub.key}
                          to={sub.path as never}
                          onClick={() => setPopoverOpen(false)}
                          className={cn(
                            "flex w-full items-center rounded-md px-3 pl-5 py-1.5 text-sm transition-colors duration-150",
                            active
                              ? "bg-sidebar-accent font-medium text-sidebar-foreground"
                              : "font-normal text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                          )}
                        >
                          {sub.label}
                        </Link>
                      );
                    })}
                  </div>
                );
              }
              const active = child.path ? isActive(child.path) : false;
              return (
                <Link
                  key={child.key}
                  to={child.path as never}
                  onClick={() => setPopoverOpen(false)}
                  className={cn(
                    "flex w-full items-center rounded-md px-3 py-1.5 text-sm transition-colors duration-150",
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-foreground"
                      : "font-normal text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                >
                  {child.label}
                  {child.badge && <NavBadge badge={child.badge} />}
                </Link>
              );
            })}
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
    );
  }

  // ── Expanded: collapsible accordion ──────────────────────────────────────
  return (
    <Collapsible
      open={isOpen}
      onOpenChange={(open) => setOpenKey(open ? group.key : null)}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger
          asChild={false}
          className={cn(ITEM_BASE, "text-left", hasActiveChild && ITEM_ACTIVE)}
        >
          <group.icon className="size-4 shrink-0" />
          <span className="flex-1 truncate">{group.label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-sidebar-foreground/35 transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
        </CollapsibleTrigger>

        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
          <NavChildList>
            {group.children.map((child, idx) => {
              if (child.children) {
                return (
                  <NavSubGroup
                    key={child.key}
                    item={child}
                    isActive={isActive}
                    isOpen={openSubKeys.has(child.key)}
                    onToggle={() => toggleSubKey(child.key)}
                    isFirst={idx === 0}
                    isLast={idx === group.children.length - 1}
                  />
                );
              }
              const active = child.path ? isActive(child.path) : false;
              return (
                <NavChildItem
                  key={child.key}
                  to={child.path as never}
                  active={active}
                  isFirst={idx === 0}
                  isLast={idx === group.children.length - 1}
                  icon={child.icon}
                >
                  {child.label}
                  {child.badge && <NavBadge badge={child.badge} />}
                </NavChildItem>
              );
            })}
          </NavChildList>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

// ─── Live nav counts ──────────────────────────────────────────────────────────

/**
 * The count next to "To Execute": unassigned tickets the caller could pick up.
 *
 * Deliberately mounted by the item itself rather than fetched once at the top of
 * the sidebar — the item only renders after `filterMenuByPermissions`, so a user
 * without `execute_request` never fires the query. RTK Query dedupes the two
 * render sites (collapsed popover / expanded accordion) into one request.
 *
 * The two branches mirror RequestQueue's own pair exactly, so the badge and the
 * page can never disagree:
 *   - regular user -> `for_my_department`, which resolves server-side to the
 *     categories they are rostered on (the parameter name predates the roster
 *     and no longer means department — see the note on RequestQueue).
 *   - super admin  -> unscoped, matching the page's `executor_user_id:
 *     undefined` branch, where `_scoped_filter` hands them the whole org.
 *
 * `page_size: 1` because only `total` is read; the row that comes back is
 * discarded.
 */
function usePendingAssignmentCount(): number {
  const currentUserId = useAppSelector((s) => s.auth.user?.id ?? "");
  const isSuperAdmin = useAppSelector(
    (s) => s.auth.user?.is_super_admin ?? false,
  );
  const { data } = useGetRequestsQuery(
    {
      status: "pending_assignment",
      ...(isSuperAdmin ? {} : { for_my_department: true }),
      page_size: 1,
    },
    // `auth.user` is not persisted, so on a hard refresh this is "" for the
    // first render — skip rather than fire an unscoped query as nobody.
    { skip: !currentUserId },
  );
  return data?.total ?? 0;
}

/**
 * The count next to "Team Tickets": approvals the caller can act on right now.
 *
 * `awaiting_me` and not `all`, because the other five cards behind that page
 * (team, approved, escalated, urgent, all) are context rather than a to-do
 * list. Their union includes every ticket the caller's reports have ever
 * raised, so a badge on it would never reach zero — and a number that never
 * clears is one people stop reading.
 *
 * Its own endpoint, so this costs one small call and not a page of rows: the
 * backend computes all six totals in a single reporting-tree walk, and the
 * count it returns for `awaiting_me` is by construction the same `total` the
 * page's card shows.
 */
function useAwaitingApprovalCount(): number {
  const { data } = useGetApprovalCountsQuery();
  return data?.awaiting_me ?? 0;
}

function CountPill({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
        "bg-sidebar-primary/15 text-sidebar-foreground tabular-nums",
      )}
      // A bare number in a nav reads as decoration; say what it counts.
      aria-label={label}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function PendingAssignmentBadge() {
  const count = usePendingAssignmentCount();
  return (
    <CountPill
      count={count}
      label={`${count} ticket${count === 1 ? "" : "s"} waiting to be picked up`}
    />
  );
}

function AwaitingApprovalBadge() {
  const count = useAwaitingApprovalCount();
  return (
    <CountPill
      count={count}
      label={`${count} ticket${count === 1 ? "" : "s"} awaiting your approval`}
    />
  );
}

/**
 * Dispatches to one component per key rather than calling every hook and
 * discarding the rest. Hooks cannot be called conditionally, so a single
 * component holding both would fire the approvals count for "To Execute" and
 * the ticket query for "Team Tickets" — two wasted calls per item, one of them
 * for an endpoint the caller may have no permission on.
 */
function NavBadge({ badge }: { badge: MenuBadgeKey }) {
  switch (badge) {
    case "sr_pending_assignment":
      return <PendingAssignmentBadge />;
    case "sr_awaiting_my_approval":
      return <AwaitingApprovalBadge />;
    default:
      return null;
  }
}

// ─── Child list + item (expanded accordion only) ──────────────────────────────

export function NavChildList({ children }: { children: React.ReactNode }) {
  return <div className="ml-7 pb-0.5">{children}</div>;
}

function NavSubGroup({
  item,
  isActive,
  isOpen,
  onToggle,
  isFirst,
  isLast,
}: {
  item: MenuItem;
  isActive: (path: string) => boolean;
  isOpen: boolean;
  onToggle: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const hasActiveChild =
    item.children?.some((c) => c.path && isActive(c.path)) ?? false;

  if (item.icon) {
    const Icon = item.icon;
    return (
      <div>
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "my-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
            hasActiveChild
              ? "font-medium text-sidebar-foreground"
              : "font-normal text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
          )}
        >
          <Icon className="size-4 shrink-0" />
          <span className="flex-1 text-left">{item.label}</span>
          <ChevronDown
            className={cn(
              "size-3 shrink-0 text-sidebar-foreground/35 transition-transform duration-200",
              isOpen && "rotate-180",
            )}
          />
        </button>
        {isOpen && item.children && (
          <div className="ml-[18px] border-l border-sidebar-border/60 pl-2">
            {item.children.map((sub, idx) => (
              <NavChildItem
                key={sub.key}
                to={sub.path as never}
                active={sub.path ? isActive(sub.path) : false}
                isFirst={idx === 0}
                isLast={idx === item.children!.length - 1}
                icon={sub.icon}
              >
                {sub.label}
              </NavChildItem>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Vertical connector line — top half */}
      {!isFirst && (
        <div className="absolute left-0 top-0 h-4 w-px bg-sidebar-border/60" />
      )}
      {/* Vertical connector line — bottom half */}
      {(!isLast || isOpen) && (
        <div className="absolute left-0 top-4 bottom-0 w-px bg-sidebar-border/60" />
      )}
      {/* Dot */}
      <div
        className={cn(
          "absolute top-[13px] z-10 rounded-full transition-all duration-150",
          hasActiveChild
            ? "size-[9px] left-[-4px] bg-sidebar-foreground"
            : "size-[7px] left-[-3px] border border-sidebar-foreground/30 bg-transparent",
        )}
      />

      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-full items-center py-1.5 pl-5 pr-1 text-sm transition-colors duration-150",
          hasActiveChild
            ? "font-medium text-sidebar-foreground"
            : "font-normal text-sidebar-foreground/50 hover:text-sidebar-foreground",
        )}
      >
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-sidebar-foreground/35 transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && item.children && (
        <div className="ml-5">
          {item.children.map((sub, idx) => {
            const active = sub.path ? isActive(sub.path) : false;
            return (
              <NavChildItem
                key={sub.key}
                to={sub.path as never}
                active={active}
                isFirst={idx === 0}
                isLast={idx === item.children!.length - 1}
                icon={sub.icon}
              >
                {sub.label}
              </NavChildItem>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function NavChildItem({
  to,
  active,
  isFirst,
  isLast,
  children,
  icon: Icon,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  to: any;
  active: boolean;
  isFirst: boolean;
  isLast: boolean;
  children: React.ReactNode;
  /** When set the row renders as an icon + pill (PMS) instead of the dotted tree line. */
  icon?: LucideIcon;
}) {
  if (Icon) {
    return (
      <Link
        to={to}
        className={cn(
          "my-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-foreground"
            : "font-normal text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span className="flex-1 truncate">{children}</span>
      </Link>
    );
  }
  return (
    <Link
      to={to}
      className={cn(
        // `pr-2` keeps a right-aligned badge off the nav's edge; harmless for
        // the items without one, whose content is left-aligned.
        "relative flex items-center py-1.5 pl-5 pr-2 text-sm transition-colors duration-150",
        active
          ? "font-medium text-sidebar-foreground"
          : "font-normal text-sidebar-foreground/50 hover:text-sidebar-foreground",
      )}
    >
      {!isFirst && (
        <div className="absolute left-0 top-0 h-1/2 w-px bg-sidebar-border/60" />
      )}
      {!isLast && (
        <div className="absolute left-0 top-1/2 bottom-0 w-px bg-sidebar-border/60" />
      )}
      <div
        className={cn(
          "absolute top-1/2 -translate-y-1/2 z-10 rounded-full transition-all duration-150",
          active
            ? "size-[9px] left-[-4px] bg-sidebar-foreground"
            : "size-[7px] left-[-3px] border border-sidebar-foreground/30 bg-transparent",
        )}
      />
      {children}
    </Link>
  );
}

// ─── Utility footer ───────────────────────────────────────────────────────────

function UtilityFooter() {
  const navigate = useNavigate();
  const { isDark, toggle: toggleDarkMode } = useTheme();
  const user = useAppSelector((s) => s.auth.user);
  const refreshToken = useAppSelector((s) => s.auth.refreshToken);
  const dispatch = useAppDispatch();
  const [logout] = useLogoutMutation();

  const isAdmin = !!(user?.is_org_admin || user?.is_super_admin);

  const initials = user
    ? `${user.first_name?.[0] ?? ""}${user.last_name?.[0] ?? ""}`.toUpperCase()
    : "?";
  const fullName = user ? `${user.first_name} ${user.last_name}` : "";

  const handleLogout = async () => {
    await logout({ refresh_token: refreshToken });
    resetAllApiState(dispatch);
    navigate({ to: "/login" as never });
  };

  const utilityItems = [
    {
      icon: HelpCircle,
      label: "Help & Support",
      onClick: () =>
        window.open(
          `${import.meta.env.BASE_URL}UserGuide/userGuide.html`,
          "_blank",
          "noopener,noreferrer",
        ),
    },
    ...(isAdmin
      ? [
          {
            icon: Settings,
            label: "Settings",
            onClick: () => navigate({ to: "/settings/organisation" }),
          },
        ]
      : []),
    {
      icon: isDark ? Sun : Moon,
      label: isDark ? "Light Mode" : "Dark Mode",
      onClick: toggleDarkMode,
      rightSlot: (
        <div
          className={cn(
            "ml-auto flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-200",
            isDark ? "bg-primary" : "bg-sidebar-foreground/25",
          )}
        >
          <div
            className={cn(
              "size-3.5 rounded-full bg-white shadow-sm transition-transform duration-200",
              isDark ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-1">
      <div className="mb-1 h-px bg-sidebar-border group-data-[collapsible=icon]:hidden" />

      {utilityItems.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.onClick}
          className={cn(
            ITEM_BASE,
            COLLAPSED,
            "group-data-[collapsible=icon]:text-sidebar-foreground/40",
          )}
        >
          <item.icon className="size-4 shrink-0" />
          <span className="flex-1 text-left group-data-[collapsible=icon]:hidden">
            {item.label}
          </span>
          {item.rightSlot && (
            <span className="group-data-[collapsible=icon]:hidden">
              {item.rightSlot}
            </span>
          )}
        </button>
      ))}

      <div className="my-1 h-px bg-sidebar-border" />

      <div className="flex w-full items-center gap-3 rounded-lg px-3 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
        <button
          type="button"
          onClick={() => navigate({ to: "/profile" as never })}
          className="flex min-w-0 flex-1 items-center gap-3 transition-opacity duration-150 hover:opacity-80 group-data-[collapsible=icon]:justify-center"
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary text-xs font-bold">
            {initials}
          </div>
          <div className="flex min-w-0 flex-1 flex-col text-left group-data-[collapsible=icon]:hidden">
            <span className="truncate text-xs font-semibold text-sidebar-foreground">
              {fullName}
            </span>
            <span className="truncate text-[10px] text-sidebar-foreground/40">
              {user?.email}
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={handleLogout}
          title="Log out"
          className="shrink-0 rounded-xl p-1 text-sidebar-foreground/40 transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/80 group-data-[collapsible=icon]:hidden"
        >
          <LogOut className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
