# Arquitetura (raiz oficial)

Este repo usa a raiz `C:\Users\endri\Music\Ferramenta` como fonte da verdade.

## Componentes
- Electron: `electron/` (main/preload)
- UI Vite/React: `pwr/` (fontes em `pwr/src`)
- API Express: `server/` usando libs em `api/`

## Como rodar
- UI (dev): `npm run dev:ui`
- API (dev): `npm run dev:api`
- Electron (dev): `npm run dev:electron`
- Build UI: `npm run build:ui`
- Build Electron: `npm run build:electron`

## Observacoes
- Pastas legacy tipo `pages/`, `app/`, `src/` (Next-like) nao sao usadas neste projeto.
- Artefatos gerados devem ficar fora do repo (dist, node_modules, caches, envs locais).