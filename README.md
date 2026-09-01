# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.
- [FC Tube sem padrão.fig](./FC%20Tube%20sem%20padrao.fig) — arquivo-fonte puro, sem tokens, cores, tipografia e espaçamento.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails, upload/leitura de vídeos e acesso ao banco.
- **Database** (PostgreSQL 17) — usuários, canais, vídeos e tokens de autenticação. Hospeda também a fila de jobs (schema `pgboss`).
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Video Worker** (FFmpeg via `ffmpeg-static`/`ffprobe-static`) — container separado que consome a fila, extrai duração/metadados, gera o thumbnail e faz a limpeza horária de uploads abandonados *(Fase 03)*.
- **Object Storage** (MinIO, S3-compatível) — arquivos de vídeo (`videos/{id}/original.<ext>`) e thumbnails (`videos/{id}/thumbnail.jpg`); trocável por S3 em produção *(Fase 03)*.
- **Message Queue** (pg-boss, sobre o PostgreSQL existente) — fila de processamento de vídeos e o cron de limpeza; sem broker dedicado *(Fase 03)*.

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Mailpit + MinIO + Video Worker)

```bash
cd nestjs-project

# Sobe API, banco, Mailpit, MinIO (+ minio-init) e o video-worker
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

> O `video-worker` roda `npm run start:worker` (contexto Nest standalone que consome as filas
> `video-processing` e `abandoned-upload-sweep`). Para exercitar o pipeline de ponta a ponta,
> use `npm run smoke` no host.

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (db/user/senha: `streamtube`) — inclui o schema `pgboss` da fila |
| Mailpit (UI de e-mails) | http://localhost:8025 |
| MinIO (API S3 / console) | http://localhost:9000 / http://localhost:9001 (user/senha: `streamtube`) |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test               # unitários + integração
docker compose exec nestjs-api npm run test:e2e       # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov       # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco real), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base** e **Fase 02 — Autenticação** estão concluídas (backend + frontend).
**Fase 03 — Upload e Processamento de Vídeos** está concluída no backend.

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

### Upload e Processamento de Vídeos (Fase 03 — backend)

Upload de vídeos de **até 10 GB** direto ao object storage (o arquivo **nunca passa pela API**), processamento assíncrono em fila e leitura pública com regra de visibilidade anti-enumeração.

- **Upload:** `POST /videos` pré-cadastra o vídeo como `draft` no canal do usuário e devolve URLs **pré-assinadas de multipart** (uma por parte de 64 MiB). O cliente faz `PUT` de cada parte no storage e chama `POST /videos/:id/complete-upload` com os `ETag`s — a API verifica o objeto (`HeadObject`), muda o status para `processing` e **enfileira o job** (tudo numa transação).
- **Worker** (`video-worker`): baixa o original, roda `ffprobe` (duração + metadados) e `ffmpeg` (thumbnail de um frame), grava o thumbnail e finaliza como `ready` — ou `error` + `error_reason` quando o retry do pg-boss se esgota (`retryLimit: 3`, backoff).
- **URL única:** `slug` de 10 caracteres (`nanoid`, coluna única, retry-on-conflito).
- **Leitura:** `GET /videos/:slug` (metadados), `/stream` e `/download` respondem `302` para uma URL pré-assinada de curta duração (o storage serve `Range`/`206` no follow-up). Com `OptionalJwtAuthGuard`: um vídeo não-`ready` só é visível ao dono do canal — para os demais retorna **`404` (nunca `403`)**.
- **Ciclo de status:** `draft → processing → ready | error`. Um cron horário (pg-boss `schedule`) reclama `draft`s com mais de 24 h — aborta o multipart órfão e marca `error` (`upload_abandoned_ttl_exceeded`).

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /videos` | Inicia o upload (cria `draft`, retorna `uploadId` + `parts[]` pré-assinadas) |
| `POST /videos/:id/complete-upload` | Confirma o upload, verifica o objeto e enfileira o processamento |
| `GET /videos/:slug` | Metadados públicos do vídeo (auth opcional) |
| `GET /videos/:slug/stream` | `302` para a URL pré-assinada de streaming |
| `GET /videos/:slug/download` | `302` para a URL pré-assinada com `Content-Disposition: attachment` |

Infra: `minio` + `minio-init` (cria o bucket `streamtube`) e `video-worker` no `compose.yaml`; a fila é **pg-boss** no schema `pgboss` do PostgreSQL existente (sem broker dedicado).

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── decisions/                       # Decisões técnicas por fase (TD-NN)
│   ├── known-issues.md                  # Dívida técnica rastreada (KI-N)
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-videos/             # Upload e processamento de vídeos
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── videos/                      # Upload, complete-upload, leitura/stream/download, sweep
│   │   ├── queue/                       # Cliente pg-boss (QueueService) e nomes de fila
│   │   ├── worker/                      # Contexto standalone do video-worker (processamento + cleanup)
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── common/                      # Filtros, pipes, exceptions de domínio e guard de erro Postgres
│   │   ├── config/                      # Configs namespaced (Joi) — inclui storage e queue
│   │   └── database/                    # data-source, migrations e seeds
│   ├── test/                            # Testes e2e
│   ├── compose.yaml                     # Docker Compose (API + PostgreSQL + Mailpit + MinIO + video-worker)
│   └── Dockerfile.dev
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── DESAFIO.md                           # Enunciado do desafio da Fase 03
├── PLAN.md                              # Prompt de execução da Fase 03 (+ decisões/armadilhas)
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída (backend) |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars) |
| Banco de Dados | PostgreSQL 17 |
| Fila / Jobs | pg-boss (sobre o PostgreSQL) |
| Object Storage | MinIO (S3-compatível), AWS SDK v3 (`@aws-sdk/client-s3` + presigner) |
| Processamento de vídeo | FFmpeg / ffprobe (`ffmpeg-static`, `ffprobe-static`) via `execa` |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
