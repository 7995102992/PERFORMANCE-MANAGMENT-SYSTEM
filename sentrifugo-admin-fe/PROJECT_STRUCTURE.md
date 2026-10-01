# Project Structure

## Root

```
Sentrifugo-FE-Boilerplate/
├── .nvmrc                    # Node version (22.20.0)
├── .npmrc                    # engine-strict=true
├── .env.example              # Environment variables template
├── .gitignore
├── CLAUDE.md                 # AI coding standards
├── README.md                 # Setup and usage instructions
├── PROJECT_STRUCTURE.md      # This file
├── package.json              # Dependencies and scripts
├── package-lock.json         # Pinned dependency versions
├── vite.config.ts            # Vite + React + Tailwind + @ alias
├── tsconfig.json             # Base TS config with path aliases
├── tsconfig.app.json         # App TS config (strict mode)
├── tsconfig.node.json        # Node TS config (vite.config)
├── components.json           # shadcn/ui config (Radix / Nova)
├── eslint.config.js          # ESLint configuration
├── index.html                # Vite entry HTML
└── src/                      # Application source code
```

## Source (`src/`)

```
src/
├── api/                      # Axios API functions (one file per resource)
├── assets/                   # Static assets (images, icons, fonts)
├── components/
│   ├── ui/                   # shadcn/ui components (auto-generated, editable)
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   ├── dialog.tsx
│   │   ├── input.tsx
│   │   └── table.tsx
│   └── shared/               # Reusable project-specific components
├── hooks/                    # Custom React hooks and TanStack Query hooks
├── layouts/                  # Page layout components (sidebar, header, etc.)
├── lib/
│   ├── axios.ts              # Configured Axios instance with interceptors
│   └── utils.ts              # cn() helper and shared utilities
├── pages/                    # Route-level page components
├── types/                    # Shared TypeScript types and interfaces
├── router.tsx                # TanStack Router route tree and definitions
├── main.tsx                  # App entry point (QueryClient + RouterProvider)
└── index.css                 # Tailwind imports + shadcn Nova theme variables
```

## Folder Responsibilities

| Folder | Purpose | Example Files |
|--------|---------|---------------|
| `src/api/` | HTTP API functions using the Axios instance from `lib/axios.ts` | `users.ts`, `products.ts`, `auth.ts` |
| `src/assets/` | Static files bundled by Vite (images, SVGs, fonts) | `logo.svg`, `placeholder.png` |
| `src/components/ui/` | shadcn/ui components — edit directly for project-wide changes | `button.tsx`, `dialog.tsx` |
| `src/components/shared/` | Reusable components built from shadcn primitives | `DataTable.tsx`, `PageHeader.tsx`, `ConfirmDialog.tsx` |
| `src/hooks/` | Custom hooks for reusable logic and TanStack Query hooks | `useAuth.ts`, `useUsers.ts`, `useDebounce.ts` |
| `src/layouts/` | Layout wrappers that define page structure | `MainLayout.tsx`, `AuthLayout.tsx` |
| `src/lib/` | Utility functions, configured instances, constants | `axios.ts`, `utils.ts`, `constants.ts` |
| `src/pages/` | Top-level page components mapped to routes | `HomePage.tsx`, `LoginPage.tsx`, `UsersPage.tsx` |
| `src/types/` | Shared TypeScript interfaces and type definitions | `user.ts`, `api.ts`, `common.ts` |

## Conventions

- Use `@/` alias for all imports from `src/` (e.g., `import { apiClient } from '@/lib/axios'`)
- One component per file, file name matches component name in PascalCase
- Colocate tests next to source files (e.g., `UserCard.tsx` + `UserCard.test.tsx`)
- Keep the structure flat — avoid deeply nested subdirectories
- Empty folders use `.gitkeep` to ensure they are tracked in git

## Adding New Features

When adding a new feature (e.g., "Users management"):

1. **Types**: Define interfaces in `src/types/user.ts`
2. **API**: Create API functions in `src/api/users.ts` using `apiClient`
3. **Hooks**: Create TanStack Query hooks in `src/hooks/useUsers.ts`
4. **Page**: Create page component in `src/pages/UsersPage.tsx`
5. **Route**: Add route in `src/router.tsx`
6. **Shared components**: Extract reusable pieces to `src/components/shared/`
