# Frontend structure and dynamic menus

How the Sentrifugo frontend (`Sentrifugo-FE`) is laid out, how its sidebar menu is built from the logged-in user's
permissions, and how to add a new menu entry.

Written for: developers adding or changing screens and menu entries in `Sentrifugo-FE`.

---

## 1. The idea in one line

> **Menu = a static config tree, filtered by the logged-in user's permissions, then rendered by the sidebar.**

The menu is **not** fetched from an API. Its shape lives in code. What the server controls is *who may see each entry*:
it sends a permission map for the logged-in user, and the frontend hides every entry the user does not hold a
permission for.

```
 menu-config.ts            /me (IAM)               permissions.ts            AppSidebar.tsx
 ┌──────────────┐        ┌───────────────┐        ┌──────────────────┐      ┌──────────────┐
 │ full menu    │        │ permission    │        │ filterMenuBy-    │      │ renders what │
 │ (static)     │──┐     │ grid for the  │──┐     │ Permissions()    │─────▶│ survived     │
 └──────────────┘  │     │ user          │  │     └──────────────────┘      └──────────────┘
                   └────▶│ use-auth.ts   │──┘
                         └───────────────┘
```

---

## 2. Folder layout (`src/`)

| Folder / file | What it holds |
|---|---|
| `main.tsx` | App entry: providers, store, router. |
| `router.tsx` | **Every route**: URL path → page component. Routes sit under a layout route. |
| `layouts/` | `AdminLayout.tsx` (page frame), `AppSidebar.tsx` (the sidebar), `menu-config.ts` (the menu). |
| `pages/` | One folder per module (`pms/`, `leave-management/`, `hr/` ...). The screens. |
| `components/ui/` | shadcn/ui primitives (button, dialog, table, tabs ...). |
| `components/shared/` | Reusable project components (`PageHeader`, `PageLoader`, ...). |
| `store/` | Redux store: `slices/authSlice.ts` (token and user), `api/*.ts` (RTK Query per backend). |
| `hooks/` | `use-auth.ts` turns the `/me` payload into the permission object the menu uses. |
| `lib/` | `permissions.ts` (menu and screen permission rules), `toast.ts`, utilities. |
| `types/` | TypeScript shapes for API payloads. |
| `providers/` | React context providers (confirm dialog, theme ...). |

PMS screens live in `src/pages/pms/` (`cycle/`, `configuration/`, `goal-setting/`, ...). Their routes are declared in
`router.tsx` with the `pmsRoute` helper.

---

## 3. How the menu is built, step by step

### Step 1: The menu is declared once, as data

File: `src/layouts/menu-config.ts`.

It exports one array, `sidebarMenuConfig`, with three levels:

```
MenuSection   "Main", "Modules", ...
  └─ MenuGroup   "HR", "PMS Cycle", "Leave Setup" ...        icon + moduleKey
       └─ MenuItem   "My Goals", "Team Goal Setting" ...      path + permission
            └─ MenuItem (children)   e.g. PMS > Configuration > KRA Master
```

Fields:

| Field | On | Meaning |
|---|---|---|
| `key` | all | Unique id. Also the default permission module for a group. |
| `label` | all | Text shown in the sidebar. |
| `icon` | group, item | A `lucide-react` icon component. |
| `path` | item | Route to open. Can be computed (`/pms/my-goals/${currentFinancialYear()}`). |
| `moduleKey` | group, item | The permission **module** to check, e.g. `performance_management`. An item's `moduleKey` overrides its group's. Defaults to `key`. |
| `permission` | group, item | The permission **action** to check, e.g. `team_goals`. Omit it and the entry is always visible. |
| `anyPermission` | item | Visible if the user holds **any** of these actions. |
| `minRole` / `requiredRole` | item / section, group | Role gate: `employee` < `manager` < `admin` < `superadmin`. |
| `hideForAdmin` | group | Hide it from admins. |
| `forceExpand` | group | Always show the children expanded. |
| `badge` | item | A live count beside the label (fetched by `AppSidebar`). |
| `children` | group, item | Nested entries. A group with one child and no `forceExpand` renders as a plain link. |

The PMS group is one entry in that array:

```ts
{
  key: "pms",
  label: "PMS Cycle",
  icon: CalendarRange,
  children: [
    {
      key: "pms-my-goals",
      label: "My Goals",
      path: `/pms/my-goals/${currentFinancialYear()}`,
      icon: Target,
      moduleKey: "performance_management",
      permission: "my_goals",
    },
    // ...more items, and a nested "Configuration" item with its own children
  ],
}
```

### Step 2: The server says what this user may do

Files: `src/hooks/use-auth.ts`, `src/store/api/iamApi.ts` (`useGetMeQuery`), `src/store/slices/authSlice.ts`.

1. After login the access token is stored in the Redux `auth` slice.
2. `useAuth()` calls `GET /me` on IAM when the user is not loaded yet.
3. `/me` returns a permission grid, module by module:

   ```json
   {
     "permissions": {
       "performance_management": {
         "acl": "editor",
         "actions": { "team_goals": true, "my_goals": true },
         "action_acls": { "team_goals": "editor" }
       }
     },
     "is_org_admin": false
   }
   ```
4. `useAuth()` converts that into an `AuthUser`: `permissions` (`{ module: [action, ...] }`), `moduleAcls`,
   `actionLevels`, `role` and `isOrgAdmin`. A super admin or org admin gets `role = "admin"`.

### Step 3: The config is filtered against the user

File: `src/lib/permissions.ts`, function `filterMenuByPermissions(menu, user)`.

Rules, applied top-down:

1. A section with `requiredRole` is kept only if the user's role is at least that role.
2. A group is kept if it has no `permission`, or the user holds that action in `group.moduleKey ?? group.key`.
3. An item is kept if it has no `permission`, or the user holds it in `item.moduleKey ?? group.moduleKey ?? group.key`.
4. **Admins and super admins bypass the check** and see everything.
5. Groups left with no visible children are removed, then sections left with no groups are removed.

So a user with none of the `performance_management` actions never sees the **PMS Cycle** group.

### Step 4: The sidebar renders what survived

File: `src/layouts/AppSidebar.tsx`.

```ts
const user = useAuth();
const filteredMenu = useMemo(
  () => gateAnalyticsRoles(filterMenuByPermissions(sidebarMenuConfig, user), ...),
  [user, ...],
);
```

`AppSidebar` then maps `filteredMenu` (sections, groups, items) onto the shadcn `Sidebar` components. It also handles
which group is open, the active highlight (`location.pathname === item.path`), nested sub-groups (PMS >
Configuration), and badges.

### Step 5: Where the sidebar lives, and what a click does

Files: `src/layouts/AdminLayout.tsx`, `src/router.tsx`.

- `AdminLayout` renders `<AppSidebar />` beside the page content, so every page under that layout has the sidebar.
- A click navigates to the item's `path`. The page that opens is whatever `router.tsx` maps to that path:

  ```ts
  const pmsRoute = (path, component) =>
    createRoute({ getParentRoute: () => adminLayoutRoute, path, component });

  const pmsMyGoalsRoute = pmsRoute("/pms/my-goals/$fy", () => <MyGoalsPage />);
  ```

**The menu entry and the route are separate.** The menu decides what is *shown*; the route decides what *opens*.
Hiding a menu entry does not protect the page, so pages that need it should also check permissions (see section 6).

---

## 4. Adding a menu entry

### A. A new item in an existing group

Example: add **Team Reports** to the PMS group for users who hold `team_progress`.

**1. Create the page** in `src/pages/pms/reports/TeamReportsPage.tsx`.

**2. Register the route** in `src/router.tsx`:

```tsx
import TeamReportsPage from "./pages/pms/reports/TeamReportsPage";

const pmsTeamReportsRoute = pmsRoute("/pms/team-reports/$fy", () => <TeamReportsPage />);
```

Then add `pmsTeamReportsRoute` to the list passed to `routeTree` (next to the other PMS routes, in
`rootRoute.addChildren([...])`).

**3. Add the menu item** in `src/layouts/menu-config.ts`, inside the PMS group's `children`:

```ts
import { BarChart3 } from "lucide-react";   // import the icon once at the top, if it is not already

{
  key: "pms-team-reports",
  label: "Team Reports",
  path: `/pms/team-reports/${currentFinancialYear()}`,
  icon: BarChart3,
  moduleKey: "performance_management",
  permission: "team_progress",
},
```

**4. Make sure the permission exists and is granted** (section 5). Without it the item is hidden for everyone but
admins.

### B. A nested sub-menu (like PMS > Configuration)

Give an item `children` instead of a `path`:

```ts
{
  key: "pms-reports",
  label: "Reports",
  icon: BarChart3,
  children: [
    { key: "pms-report-team", label: "Team", path: "/pms/reports/team",
      moduleKey: "performance_management", permission: "team_progress" },
    { key: "pms-report-cycle", label: "Cycle", path: "/pms/reports/cycle",
      moduleKey: "performance_management", permission: "pms_cycle" },
  ],
}
```

The parent shows only if at least one child survives the filter.

### C. A whole new top-level group

Add a `MenuGroup` to a section of `sidebarMenuConfig`:

```ts
{
  key: "performance_management",          // also the default permission module
  label: "Performance",
  icon: Target,
  moduleKey: "performance_management",
  children: [ /* items as above */ ],
}
```

### D. Variations

| Need | How |
|---|---|
| Visible to several roles by different permissions | `anyPermission: ["team_goals", "goal_approval"]` |
| Visible to everyone | Leave out `permission`. |
| Managers and above only | `minRole: "manager"` on the item, or `requiredRole` on the section. |
| Hide from admins | `hideForAdmin: true` on the group. |
| Path depends on the year | Use a template string with `currentFinancialYear()`. |
| Open a sub-group by default | It opens automatically when the current page is inside it. |

---

## 5. The permission has to exist on the server

The frontend only *names* a permission; IAM (`Sentrifugo-IAM-Admin-BE`) defines and grants it.

1. **Define the code** in `Sentrifugo-IAM-Admin-BE/src/models.py`:
   - add it to `PermissionCodeEnum`;
   - add it to the module's set in `MODULE_PERMISSIONS`.
2. **Seed the catalog** so it shows in the role grid:
   `python -m scripts.seed_permissions` (run from the IAM repo root, venv active).
3. **Grant it to a role**: tick it in the role editor in the admin portal (Performance Management card), or use a
   grant script such as `scripts/grant_pms_corporate_hr_permissions.py`.
4. **Log out and in again.** Permissions are read from the session when the user logs in.

If the backend service checks the action too (the PMS API uses `@RequirePermission(module, action)`), use the **same
code** on both sides.

> **Check before relying on a code.** Some PMS items in `menu-config.ts` still carry the older `manage_*` names
> (for example `manage_team_goals`), while the PMS API and the IAM catalog use `team_goals`, `my_goals`,
> `team_progress`, `goal_approval` and so on. An item whose `permission` is not a code IAM grants will only ever
> show for admins. Open `menu-config.ts` and the `PermissionCodeEnum` in IAM side by side when you add or
> change an entry. The examples in this guide use the IAM catalog names.

---

## 6. Menu visibility is not page security

Hiding an item only hides the link. Anyone can still open the URL. Protect the page in two ways:

- **Backend** (the real protection): the API rejects the call with `403` when the action is missing.
- **Frontend**: for screens that need a level (viewer / editor / admin), use `hasPermissionLevel(user, module,
  action, min)` from `src/lib/permissions.ts` and render read-only or an "access denied" state.

---

## 7. Checklist for a new menu entry

- [ ] Page component created under `src/pages/...`
- [ ] Route added in `router.tsx` **and** added to `routeTree`
- [ ] `MenuItem` added in `menu-config.ts` (`key` unique, `path` equals the route path)
- [ ] Icon imported from `lucide-react`
- [ ] `moduleKey` and `permission` match a code that exists in IAM
- [ ] Permission seeded and granted to the target role
- [ ] User logged out and in again
- [ ] Tested as a user **without** the permission (the entry must be hidden) and **with** it

---

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Item never shows | The user does not hold `moduleKey` + `permission`; check the `/me` response in DevTools, Network tab. |
| Item shows for admins only | The permission was never granted to the role in IAM. |
| Whole group missing | None of its children passed the filter, so the group was removed. |
| Clicking opens a blank or 404 page | The `path` in the menu does not match a route in `router.tsx`, or the route is not in `routeTree`. |
| Right permission, still hidden | Stale session. Log out and in again. |
| Item highlighted wrongly | `isActive` compares `location.pathname` to `path` exactly; a computed path must equal the URL. |
| TypeScript error on `icon` | Import the icon from `lucide-react` and use the component, not a string. |

---

## 9. Files at a glance

| File | Role in the menu |
|---|---|
| `src/layouts/menu-config.ts` | The menu declaration and its types. |
| `src/layouts/AppSidebar.tsx` | Filters and renders the menu. |
| `src/layouts/AdminLayout.tsx` | Mounts the sidebar. |
| `src/lib/permissions.ts` | `filterMenuByPermissions`, permission levels. |
| `src/hooks/use-auth.ts` | Builds the `AuthUser` from `/me`. |
| `src/store/api/iamApi.ts` | `useGetMeQuery` (`GET /me`). |
| `src/store/slices/authSlice.ts` | Token and user state. |
| `src/router.tsx` | Path to page mapping. |
| `src/pages/**` | The screens the menu opens. |
| `Sentrifugo-IAM-Admin-BE/src/models.py` | Permission codes and modules. |
| `Sentrifugo-IAM-Admin-BE/scripts/seed_permissions.py` | Seeds the permission catalog. |
