# Sentrifugo-FE-Boilerplate

Frontend boilerplate for Sentrifugo applications.

## Tech Stack

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | >= 22.20.0 | Runtime |
| Vite | 8.x | Build tool + dev server |
| React | 19.x | UI framework |
| TypeScript | 5.9.x | Type safety (strict mode) |
| Tailwind CSS | 4.x | Utility-first styling |
| shadcn/ui | Radix / Nova | Component library |
| TanStack Query | 5.x | Server state management |
| TanStack Router | 1.x | Type-safe client routing |
| Axios | 1.x | HTTP client |
| ESLint | 9.x | Code linting |

## Prerequisites

- Node.js >= 22.20.0 (use `nvm use` to auto-switch)
- npm >= 10

## Using This Boilerplate

Clone the template, remove its git history, and initialize as your own project:

```bash
git clone https://github.com/org/Sentrifugo-FE-Boilerplate.git my-project
cd my-project
rm -rf .git
git init
git remote add origin https://github.com/org/my-project.git
git add .
git commit -m "Initial commit from Sentrifugo-FE-Boilerplate template"
git pull origin main --allow-unrelated-histories
git push -u origin main
```

Then install dependencies and start the dev server:

```bash
nvm use
npm install
npm run dev
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with HMR |
| `npm run build` | Type-check and build for production |
| `npm run lint` | Run ESLint on all files |
| `npm run preview` | Preview production build locally |

## Environment Variables

Copy `.env.example` to `.env` and update values:

```bash
cp .env.example .env
```

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_BASE_URL` | Backend API base URL | `http://localhost:8000/api` |

> Note: All `VITE_` prefixed variables are embedded in the client bundle and publicly visible. Never put secrets here.

## Project Structure

See [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for the full folder layout and conventions.

## Project Configuration

| File | Purpose |
|------|---------|
| `.nvmrc` | Pins Node version to 22.20.0 |
| `.npmrc` | Enforces engine-strict mode |
| `.env.example` | Documents required environment variables |
| `CLAUDE.md` | AI coding standards (Claude Code, Copilot, Cursor) |
| `components.json` | shadcn/ui configuration (Radix / Nova preset) |
| `vite.config.ts` | Vite + React + Tailwind + `@/` path alias |
| `tsconfig.json` | TypeScript base config with path aliases |
| `eslint.config.js` | ESLint rules for TypeScript + React |

## Build and Test

TODO: Describe and show how to build your code and run the tests.

## Contribute

TODO: Explain how other users and developers can contribute to make your code better.
