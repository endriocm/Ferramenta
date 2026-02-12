# Ferramenta (PWR Endrio) — Resumo Completo do Projeto

> **Propósito deste documento:** Permitir que outra IA entenda o projeto inteiro sem ler nenhum arquivo. Todo detalhe de arquitetura, fluxo, regras de negócio, convenções e dependências está aqui.

---

## 1  Visão Geral

"Ferramenta" é uma **aplicação desktop para Windows** feita com **Electron + React**. Ela é usada por um escritório de assessoria de investimentos (PWR Endrio) para:

1. **Importar e consolidar receitas** vindas de planilhas Excel de três origens: Bovespa, BMF e Estruturadas, além de entradas manuais.
2. **Gerenciar operações estruturadas** (vencimentos): importar posições consolidadas de Excel, buscar cotações de mercado (Yahoo Finance / Brapi), calcular resultado financeiro (payoff de opções, barreiras, cupons, dividendos, bonificação).
3. **Dashboard analítico** com KPIs, gráficos de receita por mês/dia, ranking de assessores, distribuição por origem.
4. **Tags de clientes** (código → nome → assessor → broker) via importação de arquivo Tags.xlsx, usada para enriquecer linhas importadas.
5. **Controle de acesso / billing** com Firebase Auth, Firestore, e pagamentos via Mercado Pago (assinatura anual de R\$499,90).

---

## 2  Estrutura do Repositório

```
Ferramenta/                     (raiz — CJS, package.json root)
├── electron/                   Main process + preload
│   ├── main.js                 BrowserWindow, IPC handlers, auto-updater
│   └── preload.js              contextBridge → window.electronAPI
├── pwr/                        React SPA (ESM, Vite v7)
│   ├── src/
│   │   ├── main.jsx            Entry point React
│   │   ├── App.jsx             Auth + routing + layout
│   │   ├── Login.jsx           Login (email/pw + Google)
│   │   ├── SignupWizard.jsx    Cadastro multi-step
│   │   ├── AccessGate.jsx      Paywall / license key gate
│   │   ├── firebase.js         Firebase init + callable funcs
│   │   ├── index.css           CSS completo (2491 linhas, tema escuro)
│   │   ├── components/         UI genéricos reutilizáveis
│   │   ├── contexts/           GlobalFilterContext
│   │   ├── data/               navigation.js, dashboard.js, revenue.js, tags.js, vencimento.js
│   │   ├── hooks/              useHashRoute, useToast
│   │   ├── lib/                entitlement, periodTree, tagResolver, tagsStore, reprocessRejected
│   │   ├── pages/              Dashboard, Revenue*, Vencimento, Tags, admin/*, account/*, billing/*
│   │   ├── services/           Toda lógica de I/O, parsers, caches, storage
│   │   └── utils/              dateKey, format
│   ├── vite.config.js          proxy /api → localhost:4170
│   └── package.json            react 19, vite 7
├── server/                     Express dev server (porta 4170)
│   └── index.js                Routes: /api/health, /api/quotes, /api/dividends,
│                                /api/vencimentos/parse, /api/receitas/*/import
├── api/                        Vercel Serverless Functions (prod)
│   ├── health.js               GET → { ok: true }
│   ├── quotes.js               GET → cotação (Brapi fallback Yahoo)
│   ├── dividends.js            GET/POST → dividendos (batch via POST)
│   └── lib/
│       ├── bovespaParser.js    Parser Excel Bovespa/BMF
│       ├── estruturadasParser.js  Parser Excel Estruturadas
│       └── dividends.js        Provider chain: StatusInvest → Brapi → Yahoo
├── functions/                  Firebase Cloud Functions v2
│   ├── index.js                7 funções (checkout MP, admin CRUD, webhook)
│   └── package.json            firebase-functions 4, mercadopago 2
├── scripts/
│   ├── release-win.ps1         Bump version + build + upload Vercel Blob
│   ├── publish-updates.ps1     Upload artefatos pro Blob
│   ├── cleanup-blob-updates.mjs  Limpa versões antigas no Blob
│   ├── clean.js / verify-clean.js
│   └── atualiza_vencimentos_e_mark.py
├── docs/
│   └── ARCHITECTURE.md         Resumo curto de arquitetura
├── firebase.json               Config: functions source, firestore rules, emulator port 5001
├── firestore.rules             Regras: users, entitlements, mpPayments
├── vercel.json                 { "framework": "vite" }
├── .firebaserc                 { "projects": { "default": "pwr-endrio" } }
└── package.json                Root: electron-builder config, scripts, deps
```

---

## 3  Stack Tecnológica

| Camada | Tecnologia | Versão |
|--------|-----------|--------|
| Desktop shell | Electron | 33.2.1 |
| Packaging | electron-builder (NSIS) | 24.13.3 |
| Auto-update | electron-updater + Vercel Blob Storage | 6.1.7 |
| Frontend | React | 19.2.0 |
| Bundler | Vite | 7.2.4 |
| Auth | Firebase Auth (email/pw + Google) | — |
| Database | Cloud Firestore | — |
| Backend functions | Firebase Cloud Functions v2 | 4.5.0 |
| Pagamento | Mercado Pago SDK | 2.0.0 |
| Excel I/O | SheetJS (xlsx) — CDN no browser, npm no server | 0.20.3 (CDN) / 0.18.5 (npm) |
| API dev | Express + multer | 4.19 |
| API prod | Vercel Serverless Functions | — |
| CSS | CSS puro (index.css, 2491 linhas), tema dark | — |
| Routing | Hash-based custom hook (`useHashRoute`) | — |
| Storage local | localStorage + IndexedDB (tags) + Electron native files | — |

---

## 4  Electron — Main Process (`electron/main.js`)

### 4.1  Janela
- `BrowserWindow` 1300×820, `minWidth` 900, `minHeight` 600, fundo `#0b0f17`.
- Carrega `pwr/dist/index.html` (build) ou `VITE_DEV_SERVER_URL` (dev).
- Preload: `electron/preload.js` expõe `window.electronAPI`.

### 4.2  DevTools Debug
- Se `process.env.OPEN_DEVTOOLS === '1'`: abre DevTools detached ao iniciar e registra atalhos F12 / Ctrl+Shift+I para toggle.

### 4.3  IPC Handlers

| Canal | Direção | Descrição |
|-------|---------|-----------|
| `app:getVersion` | invoke | Retorna `app.getVersion()` |
| `select-folder` / `resolve-folder` | invoke | Dialog de pasta |
| `read-file` / `save-file` | invoke | Lê/grava arquivo no disco |
| `storage:get/set/remove` | invoke | Persistência em JSON no `userData`. Keys permitidas: `pwr.receita.bovespa`, `pwr.receita.bmf`, `pwr.receita.estruturadas`, `pwr.receita.manual`, `pwr.market.cache` |
| `config:get/set/selectWorkDir` | invoke | Config persistida em `userData/config.json`: `workDir`, `updateBaseUrl`, `license`, `auth` |
| `updates:*` | invoke/on | Auto-updater: check, download, install, getStatus, getUrls, setUrl, resetUrl. Eventos: `onStatus`, `onProgress`, `onState` |

### 4.4  Auto-Updater
- Provider: `generic`, URL base: `https://xeo22it86oecxkxw.public.blob.vercel-storage.com/updates/win/`.
- Artefatos publicados: `latest.yml`, `Ferramenta Setup X.Y.Z.exe`, `.blockmap`, `Ferramenta Setup Latest.exe` (link fixo).
- Scripts: `release-win.ps1` faz bump → build → cleanup blob → upload.

---

## 5  Frontend React (`pwr/src/`)

### 5.1  Entry Point & Auth Flow

```
main.jsx → StrictMode → App.jsx
```

`App.jsx`:
1. `onAuthStateChanged` — monitora usuário Firebase.
2. Se não logado → `<Login />`.
3. Se logado → `<AccessGate />` verifica entitlement (admin passa direto).
4. Se autorizado → shell: `<Sidebar />` + `<Topbar />` + página lazy por rota.

### 5.2  Routing (Hash-based)

Hook `useHashRoute()` lê `window.location.hash` (ex: `#/receita/bovespa`). Não usa react-router.

Rotas disponíveis:

| Hash | Página | Descrição |
|------|--------|-----------|
| `#/` | Dashboard | KPIs, gráficos, rankings |
| `#/receita/estruturadas` | RevenueStructured | Import Excel estruturadas |
| `#/receita/bovespa` | RevenueBovespa | Import Excel bovespa |
| `#/receita/bmf` | RevenueBmf | Import Excel BMF |
| `#/receita/manual` | RevenueManual | Entradas manuais |
| `#/vencimento` | Vencimento | Gestão de operações estruturadas |
| `#/tags` | Tags | Hierarquia cliente→assessor→broker |
| `#/account/access` | AccessStatus | Status da assinatura |
| `#/admin/access` | AdminAccess | Painel admin |
| `#/billing/success` | BillingSuccess | Pós-pagamento OK |
| `#/billing/pending` | BillingPending | Pagamento pendente |
| `#/billing/failure` | BillingFailure | Pagamento falhou |

### 5.3  Contexto Global de Filtros (`GlobalFilterContext`)

Provê filtros compartilhados entre todas as páginas:

- `selectedBroker` (array) — filtro de broker
- `selectedAssessor` (array) — filtro de assessor
- `clientCodeFilter` (array) — filtro de código de cliente
- `apuracaoMonths` — `{ all: boolean, months: string[] }` — meses de apuração
- `brokerOptions`, `assessorOptions`, `apuracaoOptions` — computados dos dados carregados
- `selectedClientCodes` — computado da interseção de filtros

Rebuild dos dados: quando receita muda, recalcula opções de broker/assessor/meses usando `buildTagIndex()`.

### 5.4  Navegação (`data/navigation.js`)

Seções do sidebar:
- **Visão Geral**: Dashboard
- **Receitas**: Estruturadas, Bovespa, BMF, Manual
- **Operações**: Vencimento
- **Configurações**: Tags

### 5.5  Componentes UI

| Componente | Descrição |
|-----------|-----------|
| `Sidebar` | Navegação lateral com seções, marca PWR Endrio, `DesktopControls` no footer |
| `Topbar` | Breadcrumbs, título, filtros globais (MultiSelect de broker/assessor/apuração), menu de conta (logout, criar senha, admin) |
| `DataTable` | Tabela genérica com colunas/render customizado |
| `SyncPanel` | Painel de importação: file picker, stepper animado, progress bar, resultados (importados/duplicados/rejeitados/avisos), export CSV de rejeitados/duplicados, reprocessar rejeitados |
| `Modal` | Overlay com ESC para fechar |
| `ReportModal` | Modal detalhado de operação: resultado, barreiras, pernas, componentes, warnings |
| `OverrideModal` | Modal para override manual de barreiras (alta/baixa), cupom manual, bonificação |
| `PageHeader` | Título + subtítulo + meta + actions |
| `MultiSelect` | Dropdown multi-seleção com busca e "selecionar tudo" |
| `TreeSelect` | Dropdown hierárquico (árvore) com checkboxes |
| `SelectMenu` | Dropdown single-select com busca |
| `Badge` | Pill colorida (cyan/green/amber/red/violet) |
| `Icon` | SVG icons inline (grid, layers, trend, pulse, pen, clock, link, user, search, eye, sliders, filter, sync, download, upload, plus, doc, spark, menu, close, arrow-up, arrow-down, info, warning, check, x) |
| `ToastProvider` | Sistema de toast notifications via contexto |
| `DesktopControls` | Controle de atualização do app (check/download/install) no sidebar footer |

### 5.6  Design System (CSS)

- **Tema:** Dark mode exclusivo, fundo `#070b0f` com gradientes radiais (cyan, violet, amber).
- **Fontes:** Manrope (body), Syne (display), Space Mono (mono).
- **Cores:** `--cyan: #28f2e6`, `--violet: #a66bff`, `--amber: #ffb454`, `--blue: #4da3ff`, `--green: #34f5a4`, `--red: #ff4d6d`.
- **Layout:** CSS Grid (`sidebar 260px | main`), flex para pages. Responsivo com media queries para mobile.
- **Componentes CSS:** `.panel`, `.data-table`, `.badge`, `.btn`, `.select-wrap`, `.modal-overlay`, `.toast-stack`, `.progress-bar`, `.sync-panel`, `.chart-*`, etc.

---

## 6  Páginas — Fluxos de Negócio

### 6.1  Dashboard (`pages/Dashboard.jsx`)

- **Dados:** Carrega receita estruturada (`loadStructuredRevenue()`), bovespa e BMF (`loadRevenueByType()`), receita manual. Filtra por `apuracaoMonths` e tags (broker/assessor/client).
- **KPIs:** Total Estruturadas, Total Bovespa, Total BMF, soma total.
- **Gráficos:** Barras de receita mensal (ou diário se 1 mês selecionado), distribuição por origem (Estruturadas / Bovespa / BMF / Manual).
- **Rankings:** Top 7 assessores por receita; top 7 brokers por receita.
- **Métricas extras:** Clientes únicos, assessores ativos.

### 6.2  Revenue Pages (Bovespa / BMF / Estruturadas)

Todas seguem o mesmo padrão:
1. **SyncPanel** para selecionar arquivo Excel e importar.
2. Parser no server (`/api/receitas/*/import`) ou client-side (`services/revenueImport.js`) normaliza linhas.
3. Dedup por chave composta (codigoCliente + data + corretagem + volume para Bovespa/BMF; codigoCliente + dataEntrada + ativo + estrutura + comissão para Estruturadas).
4. Enriquecimento com tags (assessor, broker, nomeCliente).
5. Persistência em `localStorage` (chave por userKey: `pwr.receita.bovespa.{userKey}`).
6. **DataTable** com paginação, busca, filtros globais.
7. Exportar rejeitados/duplicados como CSV.
8. Reprocessar rejeitados (re-enriquecer com tags atualizadas).

**Fórmulas de receita:**
- Bovespa: `corretagem × 0.9335 × 0.8285` (fator de receita)
- BMF: `corretagem × 0.9435 × 0.8285`
- Estruturadas: campo `comissao` direto do Excel

### 6.3  RevenueManual (`pages/RevenueManual.jsx`)

- Exibe entradas manuais persistidas em `pwr.receita.manual.{userKey}`.
- Permite deletar linhas.
- Enriquece com tags para exibição.

### 6.4  Vencimento (`pages/Vencimento.jsx`) — ~1959 linhas

**Fluxo principal:**
1. **Import:** SyncPanel com upload de Excel (posição consolidada). Parse via `services/excel.js` (`parseWorkbook`).
2. **Dados carregados:** Cache em `pwr.vencimento.cache.{userKey}` com timestamp.
3. **Cotação de mercado:** Para cada ativo, busca preço atual via `/api/quotes` (Brapi → Yahoo fallback). Cache local de 30min (`services/marketData.js`).
4. **Dividendos:** Busca dividendos ex-data no período da operação via `/api/dividends`. Batch POST com concorrência controlada.
5. **Barreiras:** `computeBarrierStatus()` verifica se high/low do mercado atingiram barreiras das pernas. Suporta override manual (auto/hit/nohit).
6. **Resultado:** `computeResult()` calcula: venda do ativo, ganho em calls/puts (intrínseco), cupom (fixo ou recorrente, com regras de meses), bonificação, dividendos, rebates, custo total, ganho líquido, percentual.
7. **Overrides:** `services/overrides.js` persiste barreiras manuais, cupom manual, bonificação qty/data/nota por `{userKey}.{operationId}`.
8. **Export:** PDF (via `services/pdf.js` — popup de impressão), Excel (via `services/exportXlsx.js`).
9. **ReportModal:** Exibe detalhes completos de uma operação.
10. **OverrideModal:** Edita batimento manual.

**Regras de cálculo (settlement.js):**

- **Barrier check:** Compara `market.high` / `market.low` contra cada barreira. Tipo KO (knock-out) ou KI (knock-in). Se bateu → `optionsSuppressed: true` para KO.
- **Option payoff:** Call long = `max(0, spot - strike) × qty`. Call short = `- max(0, spot - strike) × qty`. Put long = `max(0, strike - spot) × qty`. Put short = `- max(0, strike - spot) × qty`.
- **Cupom:** Pode ser fixo (`cupomFixoBRL`) ou recorrente (`cupomRecorrente`). Recorrente conta meses de registro até vencimento. Fórmula: `cupomRecorrente × meses × quantidade`.
- **Booster:** Se `boosterFactor` existe, multiplica `qty × boosterFactor` e recalcula.
- **Valor de entrada:** Soma ponderada de stock, options, puts com custo unitário.
- **Dividendo:** Integrado via `dividendTotalBRL`, somado ao resultado.

### 6.5  Tags (`pages/Tags.jsx`)

- Import de `Tags.xlsx` com colunas: Código do cliente, Nome do cliente, Assessor, Broker (+ opcionais).
- Persistência: IndexedDB via `lib/tagsStore.js` (database `pwr-tags`, store `tags`).
- Funções: `buildTagIndex()` cria Map de código → { nomeCliente, assessor, broker }. `enrichRow()` adiciona tags a uma linha de receita.
- Grid: exibe hierarquia, com busca, paginação, e tabela de agregação por assessor.

### 6.6  AccessStatus (`pages/account/AccessStatus.jsx`)

- Mostra status da entitlement do Firestore (`entitlements/{uid}`).
- Exibe: plano, status, data de expiração, dias restantes.
- Botão "Renovar / Estender" chama `createAnnualCheckoutLink()` → redireciona para checkout Mercado Pago.

### 6.7  AdminAccess (`pages/admin/AdminAccess.jsx`)

- Somente admins (`isAdmin === true` no doc `users/{uid}`).
- Buscar usuário por email (`adminFindUserByEmail`).
- Ver entitlement e pagamentos (`adminGetUserAccess`).
- Conceder acesso por N dias (`adminGrantAccess`).
- Revogar acesso (`adminRevokeAccess`).
- Reprocessar pagamento (`adminReprocessPayment`).

### 6.8  Billing Pages

- **BillingSuccess:** Ouve `onSnapshot` na entitlement para confirmar ativação pós-pagamento.
- **BillingPending / BillingFailure:** Mensagens estáticas com link para voltar.

---

## 7  Services (Lógica de Negócio)

### 7.1  `services/revenueImport.js`

Parser massivo de Excel para receitas Bovespa/BMF/Estruturadas.
- **Chunked processing:** Processa N linhas por vez com `requestAnimationFrame` para não travar a UI.
- **Dedup:** Gera chave de dedup por tipo (ex: `bovespa: codigoCliente|data|corretagem|volume`).
- **Validação:** Colunas obrigatórias por tipo. Rejeita linhas sem campos essenciais.
- **Normalização:** Datas (dd/MM/yyyy → ISO), números (vírgula/ponto BR), strings trimmed.
- **Enriquecimento:** Cruza com `buildTagIndex()` para adicionar assessor/broker/nomeCliente.
- **Integrity check:** Hash SHA-like do estado para verificar consistência.
- **Progress callback:** Reporta progresso via `onProgress({ processed, total })`.
- **Cancel support:** Via `AbortSignal` ou flag `canceled`.

### 7.2  `services/excel.js`

Parser da planilha de posição consolidada (vencimentos).
- Detecta layout "posição consolidada" (colunas Tipo1, QuantidadeAtiva1, etc.) ou layout genérico.
- Parse de até 4 pernas por operação (Call/Put/Stock com strike, barreira, rebate).
- Normaliza datas, números, códigos de cliente.
- Duas estratégias: `parsePosicaoConsolidada()` e fallback genérico com `parseLegs()` / `parseColumnLegs()`.

### 7.3  `services/settlement.js`

Motor de cálculo financeiro:

```
computeBarrierStatus(operation, market)
  → { high: bool|null, low: bool|null, list: Barrier[] }

computeResult(operation, market, options)
  → { vendaAtivo, ganhoCall, ganhoPut, ganhosOpcoes, cupomTotal,
      rebateTotal, dividends, custoTotal, financeiroFinal, ganho, percent,
      valorEntrada, valorEntradaComponents, optionsSuppressed }
```

### 7.4  `services/marketData.js`

- Busca cotação via `/api/quotes?symbol=X&start=Y&end=Z`.
- Cache em memória com TTL de 30 minutos.
- Retorna: `{ close, high, low, dividendsTotal, source }`.

### 7.5  `services/dividends.js`

- Busca dividendos via `/api/dividends`.
- Suporta batch POST (`{ requests: [{ ticker, from, to }] }`).
- Cache local por chave ticker|from|to.

### 7.6  `services/tags.js`

- `loadTags(userKey)` — carrega do IndexedDB.
- `saveTags(userKey, rows)` — persiste no IndexedDB.
- `clearTags(userKey)` — limpa.
- `buildTagIndex(tags)` — Map<codigoCliente, { nomeCliente, assessor, broker }>.
- `enrichRow(row, tagIndex)` — adiciona assessor/broker/nomeCliente à row.
- `parseTagsFile(file)` — parse do Tags.xlsx.

### 7.7  `services/nativeStorage.js`

- `isDesktop()` — detecta se roda no Electron (via `window.electronAPI`).
- `nativeGet(key)` / `nativeSet(key, value)` / `nativeRemove(key)` — bridge para IPC do Electron.
- Keys whitelist: `pwr.receita.bovespa`, `pwr.receita.bmf`, `pwr.receita.estruturadas`, `pwr.receita.manual`, `pwr.market.cache`.

### 7.8  `services/revenueStore.js`

- CRUD de receita em localStorage por userKey.
- `loadRevenueByType(type, userKey)` — `localStorage.getItem('pwr.receita.{type}.{userKey}')`.
- `saveRevenueByType(type, userKey, data)` — `localStorage.setItem(...)`.
- Merge inteligente: não sobrescreve se já existe (usa dedup keys).

### 7.9  `services/revenueStructured.js`

Igual ao revenueStore mas para receita estruturada:
- Chave: `pwr.receita.estruturadas.{userKey}`.
- `loadStructuredRevenue(userKey)`, `saveStructuredRevenue(userKey, data)`, `clearStructuredRevenue(userKey)`.

### 7.10  `services/overrides.js`

- Persiste overrides por operação em localStorage: `pwr.vencimento.overrides.{userKey}`.
- Formato: `{ [operationId]: { high: 'auto'|'hit'|'nohit', low: 'auto'|'hit'|'nohit', manualCouponBRL: number|null, qtyBonus: number, bonusDate: string, bonusNote: string } }`.

### 7.11  `services/exportXlsx.js`

- Gera arquivo XLSX a partir de array de rows.
- Usa SheetJS dinâmico (carregado via CDN).

### 7.12  `services/pdf.js`

- Gera PDF via popup de impressão do browser.
- Monta HTML do relatório e chama `window.print()`.

### 7.13  `services/xlsxLoader.js`

- Carrega SheetJS dinamicamente de `https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs`.
- Singleton com cache.

### 7.14  `services/currentUser.js`

- `getCurrentUserKey()` — retorna UID do Firebase Auth ou key do localStorage.
- Usado como namespace para isolar dados de diferentes usuários.

### 7.15  `services/debug.js`

- Helpers de debug: `debugLog()`, `debugWarn()`, `debugTable()`.
- Ativos somente em `import.meta.env.DEV`.

### 7.16  `services/apuracao.js`

- Extrai meses de apuração disponíveis a partir dos dados importados.

### 7.17  `services/vencimentoCache.js`

- Cache de vencimentos importados em localStorage: `pwr.vencimento.cache.{userKey}`.
- Formato: `{ rows, fileName, timestamp }`.

### 7.18  `services/vencimentoLink.js`

- Persiste link/configuração de vencimento: `pwr.vencimento.link.{userKey}`.

---

## 8  Lib (Utilitários de Domínio)

### 8.1  `lib/entitlement.js`
- `getExpiryDate(entitlement)` — retorna Date de expiração.
- `isEntitlementValid(entitlement)` — verifica se não expirou.

### 8.2  `lib/tagResolver.js`
- `normalizeClientCode(code)` — trim, uppercase.
- `resolveTag(code, tagIndex)` — busca tag por código normalizado.

### 8.3  `lib/periodTree.js`
- `buildPeriodTree(dates)` — constrói árvore Ano → Mês para o TreeSelect.

### 8.4  `lib/tagsStore.js`
- Wrapper IndexedDB: database `pwr-tags`, object store `tags`.
- `getTagsFromDB(userKey)`, `saveTagsToDB(userKey, rows)`, `clearTagsFromDB(userKey)`.

### 8.5  `lib/reprocessRejected.js`
- Pega linhas rejeitadas, re-enriquece com tags atualizadas, retorna as que agora são válidas.

---

## 9  Utils

### 9.1  `utils/format.js`
- `formatCurrency(value)` → `R$ 1.234,56`.
- `formatNumber(value)` → `1.234,56`.
- `formatDate(isoDate)` → `dd/mm/aaaa`.
- `formatPercent(value)` → `12,34%`.

### 9.2  `utils/dateKey.js`
- `toDateKey(date)` → `YYYY-MM-DD`.
- `parseISO(str)` → Date.
- `monthKey(isoDate)` → `YYYY-MM`.

---

## 10  Server — Express Dev API (`server/index.js`)

Porta: `4170` (var `PORT`).

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/api/health` | GET | `{ ok: true }` |
| `/api/quotes` | GET | Cotação: tenta Brapi (BR tickers) → fallback Yahoo Finance v8. Retorna `{ symbol, close, high, low, dividendsTotal, source }` |
| `/api/dividends` | GET | Dividendos de um ticker (provider chain: StatusInvest → Brapi → Yahoo) |
| `/api/vencimentos/parse` | POST (multipart) | Recebe Excel, retorna array de operações parseadas |
| `/api/receitas/estruturadas/import` | POST (multipart) | Parse Excel de receitas estruturadas |
| `/api/receitas/bovespa/import` | POST (multipart) | Parse Excel de receitas Bovespa |
| `/api/receitas/bmf/import` | POST (multipart) | Parse Excel de receitas BMF |

### Providers de Cotação (ordem de tentativa):
1. **Brapi** (`brapi.dev/api/quote/{ticker}`) — tickers BR, precisa de `BRAPI_TOKEN`.
2. **Yahoo Finance** (`query1.finance.yahoo.com/v8/finance/chart/{ticker}`) — fallback.

### Providers de Dividendos (ordem de tentativa, BR):
1. **StatusInvest** — scraping HTML de `statusinvest.com.br/{acoes|bdrs|fundos-imobiliarios}/{ticker}`.
2. **Brapi** — `brapi.dev/api/quote/{ticker}?dividends=true`.
3. **Yahoo Finance** — eventos de dividendos do endpoint de chart.

---

## 11  API Vercel Serverless (`api/`)

Mesma lógica do Express, mas como serverless functions na Vercel:
- `api/health.js` — health check.
- `api/quotes.js` — cotação (Brapi → Yahoo).
- `api/dividends.js` — dividendos (GET single ou POST batch com concurrency 4).
- `api/lib/dividends.js` — toda a lógica de providers, cache (6h TTL), normalização.
- `api/lib/bovespaParser.js` — parser Excel Bovespa/BMF.
- `api/lib/estruturadasParser.js` — parser Excel Estruturadas.

---

## 12  Firebase Cloud Functions (`functions/index.js`)

**Projeto Firebase:** `pwr-endrio` (us-central1).

**⚠️ STATUS: NUNCA FORAM DEPLOYED (até o momento da escrita deste doc).**

### Funções:

| Nome | Tipo | Secrets | Descrição |
|------|------|---------|-----------|
| `createAnnualCheckoutLink` | onCall | MP_ACCESS_TOKEN | Cria preferência de checkout Mercado Pago. Preço: `ANNUAL_PRICE_BRL` (env). Redirect URLs: `APP_BASE_URL/billing/{success,failure,pending}`. Salva intent em `mpPayments/{pref.id}` |
| `mercadoPagoWebhook` | onRequest | MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET | Recebe notificação de pagamento. Valida assinatura HMAC-SHA256. Se `status === 'approved'`: cria/atualiza entitlement por 365 dias. Salva em `mpPayments/{payment.id}` e `entitlements/{uid}` |
| `adminFindUserByEmail` | onCall | — | Busca UID por email via Firebase Admin Auth |
| `adminGetUserAccess` | onCall | — | Retorna entitlement + últimos 20 pagamentos do usuário |
| `adminGrantAccess` | onCall | — | Concede entitlement por N dias (default 365) |
| `adminRevokeAccess` | onCall | — | Revoga entitlement (`status: 'revoked'`) |
| `adminReprocessPayment` | onCall | MP_ACCESS_TOKEN | Re-busca pagamento no MP e reprocessa |

### Env Vars necessárias:
- `ANNUAL_PRICE_BRL` — preço da assinatura anual (ex: `499.90`)
- `APP_BASE_URL` — URL base do app (ex: `https://pwr-endrio.vercel.app`)
- `MP_ACCESS_TOKEN` — secret do Mercado Pago
- `MP_WEBHOOK_SECRET` — secret do webhook MP (para validação HMAC)

---

## 13  Firestore — Coleções e Regras

### Coleções:

| Coleção | Documento | Campos principais |
|---------|-----------|-------------------|
| `users` | `{uid}` | `email`, `displayName`, `isAdmin`, `createdAt` |
| `entitlements` | `{uid}` | `status` (`active`/`revoked`/`expired`), `plan` (`annual`), `grantedAt`, `expiresAt`, `grantedBy`, `mpPaymentId` |
| `licenseKeys` | `{key}` | `maxUses`, `usedBy[]`, `durationDays`, `active` |
| `mpPayments` | `{paymentId}` | `uid`, `status`, `amount`, `createdAt`, `processedAt`, `preference_id`, dados do MP |
| `accessAudits` | `{auto}` | Logs de auditoria de acesso |

### Regras (`firestore.rules`):

- `users/{uid}`: owner lê; owner cria (sem se tornar admin); admin full.
- `entitlements/{uid}`: owner lê; admin escreve.
- `mpPayments/{paymentId}`: apenas admin lê/escreve.

---

## 14  Fluxo de Pagamento (Mercado Pago)

1. Usuário clica "Renovar / Estender" em `AccessStatus.jsx` ou `AccessGate.jsx`.
2. Frontend chama `createAnnualCheckoutLink()` (Firebase callable).
3. Cloud Function cria preferência no MP com redirect URLs e metadata (`{ uid, email }`).
4. Salva intent em Firestore `mpPayments/{preferenceId}`.
5. Usuário é redirecionado para checkout do Mercado Pago.
6. Após pagamento, MP chama webhook `mercadoPagoWebhook`.
7. Webhook valida assinatura HMAC, busca dados do pagamento na API MP.
8. Se aprovado: cria entitlement de 365 dias, atualiza `mpPayments`, auditoria.
9. Frontend em `BillingSuccess` ouve `onSnapshot` na entitlement para confirmar ativação.

---

## 15  Fluxo de Acesso (Entitlement / License Key)

`AccessGate.jsx`:
1. Verifica se usuário é admin → acesso direto.
2. Carrega entitlement do Firestore (`entitlements/{uid}`).
3. Se válido (`isEntitlementValid()`) → acesso ao app.
4. Se não tem entitlement: oferece duas opções:
   a. **License Key:** Digita chave → busca em `licenseKeys/{key}` → se válida e não esgotada, cria entitlement.
   b. **Pagamento anual:** Chama `createAnnualCheckoutLink()` → redirect para MP.

---

## 16  Persistência de Dados — Resumo

| Dado | Storage | Chave |
|------|---------|-------|
| Receita Bovespa | localStorage | `pwr.receita.bovespa.{userKey}` |
| Receita BMF | localStorage | `pwr.receita.bmf.{userKey}` |
| Receita Estruturadas | localStorage | `pwr.receita.estruturadas.{userKey}` |
| Receita Manual | localStorage | `pwr.receita.manual.{userKey}` |
| Tags (clientes) | IndexedDB | db `pwr-tags`, store `tags`, key `{userKey}` |
| Vencimentos cache | localStorage | `pwr.vencimento.cache.{userKey}` |
| Vencimentos overrides | localStorage | `pwr.vencimento.overrides.{userKey}` |
| Vencimento link | localStorage | `pwr.vencimento.link.{userKey}` |
| Market cache | localStorage/native | `pwr.market.cache` |
| Filtros globais | localStorage | `pwr.filters.{userKey}` |
| Config Electron | arquivo JSON | `userData/config.json` |
| Native storage | arquivos JSON | `userData/{key}.json` |
| Usuário/Entitlement | Firestore | `users/{uid}`, `entitlements/{uid}` |
| Pagamentos | Firestore | `mpPayments/{id}` |

---

## 17  Build & Deploy

### Dev:
```bash
npm run dev:api      # Express em localhost:4170
npm run dev:ui       # Vite em localhost:5173 (proxy /api → 4170)
npm run dev:electron # Electron apontando para Vite dev server
```

### Build Desktop:
```bash
npm run build:electron   # build:ui + electron-builder --win --x64
```
Saída: `dist_electron/Ferramenta Setup X.Y.Z.exe`

### Release Desktop:
```powershell
.\scripts\release-win.ps1 -Bump patch  # bump version, build, upload Blob
```

### Deploy API (Vercel):
Push para repo → Vercel detecta `vercel.json` com framework vite e deploys serverless em `/api/*`.

### Deploy Functions (Firebase):
```bash
cd functions && npm run deploy   # firebase deploy --only functions
```
⚠️ Requer: `.firebaserc` apontando para `pwr-endrio`, secrets configurados no Firebase.

---

## 18  Variáveis de Ambiente

### `pwr/.env` (Vite):
```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=pwr-endrio
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

### `functions/.env.local`:
```
ANNUAL_PRICE_BRL=499.90
APP_BASE_URL=http://localhost:5173   (precisa ser URL de produção para deploy)
```

### `functions/.secret.local`:
```
MP_ACCESS_TOKEN=               (precisa ser preenchido)
MP_WEBHOOK_SECRET=             (precisa ser preenchido)
```

### `server/`:
```
PORT=4170 (default)
DEBUG_RECEITAS=1 (opcional, loga stats)
BRAPI_TOKEN=... (para API de dividendos/cotação)
```

### Electron:
```
OPEN_DEVTOOLS=1     (abre DevTools ao iniciar)
VITE_DEV_SERVER_URL=http://localhost:5173  (dev mode)
```

---

## 19  Convenções do Código

- **Linguagem:** JavaScript puro (sem TypeScript). ESM no `pwr/`, CJS na raiz/server/api/functions.
- **React:** Functional components only. Hooks. `memo()` em DataTable.
- **State:** Sem Redux/Zustand. Tudo via useState/useContext + localStorage/IndexedDB.
- **Routing:** Hash-based custom hook, sem react-router.
- **CSS:** Single file (index.css), sem CSS modules, sem styled-components. Classes BEM-like.
- **Naming:** camelCase para variáveis/funções. PascalCase para componentes. Nomes em inglês no código, labels em português na UI.
- **Formatação:** Sem Prettier config explícito. ESLint configurado no pwr/.
- **Imports:** Relativos (`../services/tags`). Sem aliases.
- **Error handling:** try/catch com fallback silencioso na maioria dos services. Toast notifications para erros visíveis ao usuário.
- **Sem testes unitários formais.** Existe `pwr/scripts/tests.js` mas é básico.

---

## 20  Pontos de Atenção / Estado Atual

1. **Cloud Functions NÃO estão deployed.** O botão "Renovar / Estender" retorna 404 porque `createAnnualCheckoutLink` não existe no Firebase ainda. É preciso configurar `APP_BASE_URL`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e fazer `firebase deploy --only functions`.

2. **SheetJS dual load:** O server usa `xlsx` do npm (0.18.5) e o frontend carrega dinamicamente do CDN (0.20.3). Versões diferentes podem causar inconsistências.

3. **localStorage como banco principal** de receitas pode atingir o limite de ~5-10MB em browsers/Electron para grandes volumes de dados.

4. **Providers de cotação/dividendos** dependem de APIs externas (Yahoo, Brapi, StatusInvest) que podem mudar ou bloquear scraping.

5. **Auto-updater** depende de Vercel Blob Storage estar acessível e do `latest.yml` estar atualizado.
