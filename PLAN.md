# PROMPT — Executar a Fase 03 do StreamTube: Upload e Processamento de Vídeos

> Documento gerado a partir de `nestjs-project/DESAFIO.md`, cruzado com a documentação do
> projeto em `docs/`. É um **prompt de execução**: entregue-o a um agente de IA (Claude Code)
> para conduzir a Fase 03 de ponta a ponta, seguindo o workflow em pipeline do projeto.
> Toda informação abaixo é rastreável ao enunciado, ao `docs/project-plan.md` ou ao código.

> **Status (2026-09-01): Fase 03 executada e concluída** na branch `feature/phase-03-videos`
> (2ª execução completa — **10 SIs**, `SI-03.1`…`SI-03.10`; `validation.md` em `clean`; suíte
> verde: **181 unit/integração + 65 e2e**; `tsc` código 0; `smoke` cobrindo o fluxo de vídeo).
> As decisões da §5.1 foram todas mantidas. As armadilhas realmente encontradas nesta rodada
> estão consolidadas na **§11** (a §11.8 é nova, desta execução). Dívida pré-existente e não
> relacionada registrada em `docs/known-issues.md` (KI-1 lint `no-unsafe-*`, KI-2 Prettier/CRLF).

---

## 1. Papel e objetivo

Você é o **maestro** de um processo de desenvolvimento orientado por IA. A IA é a ferramenta
de produção principal e obrigatória; seu trabalho é conduzir o workflow na ordem certa, revisar
criticamente cada saída, refinar prompts quando o resultado vier raso, consultar a documentação
das libs via **context7 (MCP)** antes de implementar e manter os artefatos coerentes entre si.
A presença da IA precisa ser **observável no repositório**: decisões técnicas, artefatos de
planejamento, plano da fase e progresso, tudo gerado pelo fluxo.

**Objetivo:** implementar por completo, num fork público do `mba-ia-greenfield-project`, a
**Fase 03 — Upload e Processamento de Vídeos**, dando continuidade às Fases 01 (configuração base)
e 02 (auth/usuários/canais), já fechadas no backend e no frontend.

Este é um **desafio de backend**. A entrega é a API, o worker, a infraestrutura e os artefatos
do processo. Existe um `next-frontend/` no repositório, mas **a interface de vídeo está fora do
escopo desta fase**.

Ferramenta recomendada: **Claude Code** — toda a fundação de IA (`.claude/` com skills,
sub-agents e rules, `CLAUDE.md`, `.mcp.json`) já vem pronta. Se usar outra ferramenta agêntica,
é sua responsabilidade portar essa fundação para a convenção dela **antes de começar** (arquivo
de instruções equivalente, mecanismo de skills/sub-agents ou condução manual do mesmo workflow,
configuração de MCP para Postgres e context7). O workflow e os artefatos entregues são os mesmos;
só a máquina muda. A escolha da ferramenta **não altera os Critérios de Aceite**.

---

## 2. Documentação do projeto a consultar (contexto obrigatório)

Leia antes de iniciar cada etapa. Estes arquivos são a fonte de verdade do projeto:

| Arquivo | Para quê |
|---|---|
| `docs/project-plan.md` → **Fase 03** (linhas ~67–83) e **§4 Pontos de Atenção** (linhas ~163–171) | Definição canônica do escopo e capacidades da fase; riscos de upload grande, processamento pesado, URLs únicas, armazenamento, streaming |
| `docs/diagrams/software-arch.mermaid` | Arquitetura-alvo C4: já prevê **Video Worker (FFmpeg)**, **Object Storage (S3/MinIO)** e **Message Queue (TBD)** como parte da Fase 03, com as relações `api → queue (publishes job)`, `queue → worker (delivers job)`, `worker → storage/db` |
| `CLAUDE.md` (raiz) | Regras do projeto: Environment & Phase Health, **Definition of Done (Técnica)**, Git Conventions (Git Flow), Testing Policy, Scope Limits, Library Documentation Lookup |
| `nestjs-project/CLAUDE.md` | Comandos **dentro do container**, convenções de teste (`*.spec` / `*.integration-spec` / `*.e2e-spec`), Jest config, Build Assets (`nest-cli.json` → `assets` para arquivos não-`.ts`), convenções REST, `.env` shell-safe |
| `docs/decisions/technical-decisions-phase-02-auth.md` | **Formato** dos documentos de decisão (TD-NN: Scope, Capability, Context, Options A/B/C, Pros/Cons, Recommendation, Decision) |
| `docs/decisions/technical-decisions-phase-01-configuracao-base.md` | Decisões herdadas da fundação (Docker, Postgres, migrations, seeds) — **hard constraints, não reabrir** |
| `docs/phases/phase-02-auth/` (`context.md`, `validation.md`, `phase-02-auth.md`, `progress.md`) | **Referência de formato da pasta da fase.** Use como molde para `docs/phases/phase-03-videos/` |
| `docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md` | Formato canônico do artefato final: Step Implementations + Technical Specifications + Dependency Map + Deliverables |
| `docs/known-issues.md` | Único jeito sancionado de diferir dívida pré-existente (entrada escopada por arquivo/regra + follow-up). Não silenciar regra inteira |
| `.claude/skills/plan-pipeline/SKILL.md` | Topologia do pipeline, convenções compartilhadas, staleness via `sources_mtime`, gate `status: clean\|dirty`, IDs de issues |
| `.claude/skills/research/SKILL.md` | O que conta como Technical Decision; formato e frontmatter do documento de decisões |
| `.claude/rules/` (nestjs-*, typeorm-*) | Convenções de camadas, controllers, DTOs, entities, modules, services, testing, migrations, queries — carregadas automaticamente ao editar os arquivos correspondentes |
| Skills de best-practices: `nestjs-best-practices`, `typeorm`, `testing-guide-nestjs-project` | Padrões de arquitetura, repository pattern, filas/eventos, transações, o que testar em cada nível |

**Estado atual do código** (Fases 01–02 fechadas):

- Backend NestJS 11 + TypeORM + PostgreSQL 17 em `nestjs-project/`. Módulos: `auth/`, `users/`,
  `channels/`, `mail/`, `common/`, `config/`, `database/`, `swagger/` (OpenAPI).
- Relação **usuário 1:1 canal**, criado no cadastro. **Os vídeos da Fase 03 pertencem a um canal.**
- Guard JWT global, filtro de exceções de domínio, `ValidationPipe` global, rate limiting
  (`@nestjs/throttler`), migrations versionadas e seeds.
- `nestjs-project/compose.yaml` atual: **apenas `nestjs-api`, `db` (Postgres 17) e `mailpit`**.
- Dependências já instaladas: `@nestjs/{common,core,config,jwt,platform-express,swagger,throttler,typeorm}`,
  `argon2`, `class-validator`, `class-transformer`, `typeorm`, `pg`, `joi`, `handlebars`,
  `@nestjs-modules/mailer`.
- Scripts relevantes: `migration:generate`, `migration:run`, `migration:create`, `seed`,
  `test`, `test:e2e`, `test:integration`, `lint:ci`, `format:check`, `env:check`, `smoke`,
  `openapi:export`.

**O que NÃO existe e você vai construir:** módulo de vídeo, tabela de vídeos, serviço de object
storage, fila de processamento e worker de vídeo (FFmpeg).

---

## 3. Regras invioláveis (do `CLAUDE.md` — valem para esta fase)

1. **Definition of Done (Técnica)** — a fase só está pronta quando **tudo** passa:
   1. Suíte de testes relevante (unit + integração + e2e afetados).
   2. Suíte completa verde antes de encerrar.
   3. `npx tsc --noEmit` sai com **código 0** (dentro do container). Erros de compilação nunca
      viram dívida.
   4. `npm run lint:ci` **e** `npm run format:check` limpos para todo arquivo tocado — checados
      a cada SI, não deixados para uma passada única no fim.
   5. Onde há superfície observável em runtime, `npm run smoke` (ou equivalente do subprojeto)
      passa contra o app real rodando.
   - Exceção única: falha **pré-existente e não relacionada** → registrar em `docs/known-issues.md`
     (entrada escopada + follow-up), nunca corrigir fora de escopo nem ignorar em silêncio.
2. **Docker** — tudo roda em containers. Todo `npm`/`npx`/`node`/`tsc`/teste roda **dentro do
   container** (`docker compose exec nestjs-api ...`). Use sempre o **nome do serviço do Compose**
   como host (ex.: `db`), **nunca** `localhost`/`127.0.0.1`. Suítes de integração e e2e compartilham
   um único banco de teste → rodar com `--runInBand`.
3. **Documentação de libs** — antes de implementar com **qualquer** biblioteca (fila, SDK de
   storage, FFmpeg wrapper, streaming), consulte a doc oficial via **context7 (MCP)** e siga a
   **versão instalada**. Se a doc retornada não bater com a versão, sinalize a discrepância antes
   de prosseguir.
4. **Git Flow** — duas branches longevas: `main` (estável) e `dev` (integração). `dev` deve estar
   atualizada com `main` antes de ramificar. Branches `feature/*` saem de **`dev`** e voltam para
   **`dev`** — nunca de outra feature, nunca de `main`, **nunca commit direto na `main`**. `main`
   só recebe merge de `dev` quando `dev` está estável. Commits curtos, descritivos, focados no
   "porquê"; **um commit por SI/feature** depois que seus testes e lint passam — não batch, não
   deixar trabalho testado sem commit atravessando sessão.
5. **Testes** — todo change é testado. Durante o dev, só os testes do código alterado; antes de
   encerrar, a suíte completa. Sufixos: `*.spec.ts` (unit, tudo mockado, **proibido** DB/I/O),
   `*.integration-spec.ts` (DB/serviços reais, ao lado do fonte), `*.e2e-spec.ts` (HTTP via
   `supertest`, em `nestjs-project/test/`). **Não mocke o que dá para testar de verdade com a
   infra do Compose.**
6. **Scope Limits** — uma feature/fix/refactor por vez; nada de mudanças cosméticas junto com
   funcionais. Achou algo fora de escopo → registre como tarefa separada, não faça agora.
7. **Environment & Phase Health** — antes de planejar/implementar, rode `nestjs-project/scripts/env-check.sh`
   (ou `npm run env:check`) no host e um `npm run lint:ci` advisory. Dívida pré-existente vai
   para `docs/known-issues.md`, não para um config permissivo.
8. **Rastreabilidade** — toda informação nos artefatos rastreável ao plano ou ao código. **Não
   invente requisitos, decisões ou comportamentos sem origem identificável.**
9. **Docker build assets** — qualquer asset de runtime não-`.ts` (templates, JSON, config) deve
   ser declarado em `nest-cli.json` → `compilerOptions.assets` (com `watchAssets: true`).

---

## 4. Escopo da Fase 03 (capacidades a entregar)

Definição completa em `docs/project-plan.md`, Fase 03. Entregar:

1. **Object storage** para arquivos de vídeo e thumbnails.
2. **Fila de processamento** em segundo plano + um **worker** que a consome.
3. **Upload de vídeos de até 10GB sem travar o sistema** — sem segurar a API durante o envio.
4. **Pré-cadastro automático do vídeo como rascunho** ao iniciar o upload.
5. **Processamento automático após o upload:** extração de duração e metadados.
6. **Geração automática de thumbnail** a partir de um frame do vídeo.
7. **URL única por vídeo**, sem conflito com outros.
8. **Reprodução via streaming** — sem exigir download completo do arquivo.
9. **Download do vídeo** pelo usuário.

**Entregáveis (do plano original):** upload de até 10GB funcional, processamento automático do
vídeo, streaming funcionando e URLs únicas geradas.

**Persistência** — uma entidade/tabela de vídeos ligada ao **canal**, com pelo menos:
identificação, dono (canal), título, **status** (ex.: `rascunho → processando → pronto/erro`),
chaves de storage do arquivo e do thumbnail, duração e metadados, e o identificador da URL única.
O modelo exato é definido no plano (Data Model), não neste prompt.

**Fora de escopo:** interface de vídeo no `next-frontend/`; edição de informações do vídeo,
visibilidade público/unlisted, painel do canal e página pública (Fase 04); player e página de
visualização (Fase 05); likes/comentários/inscrições (Fase 06).

---

## 5. Decisões que o `research` precisa tomar e justificar

Estas decisões são o **coração da etapa de research**. Pesquise opções, registre trade-offs e a
escolha em `docs/decisions/technical-decisions-phase-03-videos.md`.

> A execução anterior desta fase já fechou todas estas decisões — a tabela completa (com
> recomendação, escolha efetivada e libs) está na **§5.1**. Consulte-a ao rodar o `research`:
> quando as mesmas opções aparecerem, pré-marque a escolha da execução anterior e só diverja com
> motivo registrado.

1. **Tecnologia de fila** — o `project-plan.md` a deixa explicitamente **"TBD"**. É a **principal
   decisão de stack da fase**. Pesquise alternativas (ex.: BullMQ/Redis, RabbitMQ, pg-boss,
   SQS-compatível), com trade-offs de operação em Docker, garantias de entrega, retry/back-off,
   DLQ, observabilidade e ajuste ao NestJS.
2. **Estratégia de upload de 10GB sem travar** — ex.: upload **direto ao storage via URL
   pré-assinada** (PUT simples ou multipart), em vez de passar o arquivo pela API. Definir como a
   API entra no fluxo (inicia o pré-cadastro, emite credenciais/URL, confirma conclusão) sem
   nunca bufferizar o arquivo.
3. **Como o worker roda** — processo/container separado; como consome a fila; como extrai
   duração/metadados e gera o thumbnail (**FFmpeg/ffprobe**). Definir empacotamento (imagem com
   FFmpeg), concorrência e idempotência.
4. **Estratégia de URL única** — como gerar um identificador curto e único que nunca conflite
   (ex.: nanoid/base62, slug + colisão-retry, ULID). Onde entra na rota pública.
5. **Estratégia de streaming** — ex.: requisições **Range / `206 Partial Content`**; se a API faz
   proxy do storage ou redireciona para URL pré-assinada; cabeçalhos (`Accept-Ranges`,
   `Content-Range`, `Content-Type`).
6. **Ciclo de status do vídeo e falhas** — estados, transições válidas, o que acontece em falha
   de processamento (retry, status `erro`, limpeza de storage órfão).

**Object storage NÃO é decisão em aberto.** O projeto já aponta para **S3 (compatível)** — na
prática **MinIO local em Docker** (mesma API do S3), trocável por S3 em produção. O que você
decide aqui é **como usá-lo**: organização de buckets/chaves, upload pré-assinado. A decisão de
stack genuinamente aberta é a **fila**.

---

## 5.1. Decisões da execução anterior da Fase 03 (referência — pré-marcar no `research`)

> Já houve **duas** execuções completas desta fase na branch `feature/phase-03-videos` — a 1ª com
> 8 SIs, a 2ª (2026-09-01) com **10 SIs** (`abandoned-upload-cleanup` virou o `SI-03.9` próprio e
> a documentação/OpenAPI/smoke o `SI-03.10`). Ambas com suíte verde e `validation.md` em `clean`.
> As decisões abaixo saíram da 1ª rodada e **foram todas reconfirmadas** na 2ª.
> **Instrução para o `research`:** ao levantar as opções de cada decisão, se as **mesmas opções**
> surgirem, **pré-marque a coluna "Escolha"** com o valor da execução anterior indicado aqui — e
> só reabra se a pesquisa atual trouxer um motivo concreto para divergir (registre o motivo no
> TD). Onde a execução anterior **divergiu da própria recomendação**, isso está sinalizado com ⚠️
> e o motivo — decida conscientemente qual caminho seguir.

**Documentos de decisão gerados:** `docs/decisions/technical-decisions-phase-03-videos.md`
(TD-01…TD-08) + `docs/decisions/technical-decisions-abandoned-upload-cleanup.md` (TD-01, ad-hoc,
`related_phases: [3]` — criado pelo `plan-resolve` para fechar o issue **MD-1** do `validate`:
"nenhum TD trata upload abandonado/nunca concluído").

| TD | Decisão | Recomendação do research anterior | **Escolha efetivada na execução anterior** | Libs |
|---|---|---|---|---|
| **TD-01** | Tecnologia de fila | BullMQ + Redis | ⚠️ **pg-boss** (fila nativa em PostgreSQL — divergiu da recomendação: evita subir Redis, reusa o Postgres já no stack, agenda cron nativo p/ o sweep do TD-01 de cleanup) | `pg-boss` |
| **TD-02** | Estratégia de upload até 10GB | Multipart S3 com URLs pré-assinadas por parte (client→storage direto) | **Multipart S3 com URLs pré-assinadas por parte** (API só no control-plane: cria o multipart, emite `UploadPart` URLs, confirma). PUT único pré-assinado **excluído** (limite 5GB, sem resume). Proxy pela API **excluído** (reprova automática) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| **TD-03** | Detecção de conclusão + gatilho de processamento | Endpoint de conclusão confirmado pelo cliente + verificação server-side (`HeadObject`) | **Endpoint `POST /videos/:id/complete-upload`** → `CompleteMultipartUpload` + `HeadObject` → flip p/ `processing` → enfileira job. (MinIO bucket notification fica como evolução futura) | — |
| **TD-04** | Organização de buckets/chaves | Bucket único, chaves com prefixo por vídeo | **Bucket único `streamtube`**, chaves `videos/{id}/original.<ext>` e `videos/{id}/thumbnail.jpg` | — |
| **TD-05** | Toolchain do worker de vídeo | Invocação direta de `ffmpeg`/`ffprobe` CLI via `child_process`/`execa` | **CLI direto via `execa`** + binários `ffmpeg-static`/`ffprobe-static`. `fluent-ffmpeg` **excluído** (arquivado em 2025); `mediaforge` **excluído** (imaturo). ⚠️ **`execa` fixado em `^5.1.1`** (último major CommonJS — v10 é ESM-only com cadeia que quebra o Jest, ver §11) | `execa@5`, `ffmpeg-static`, `ffprobe-static` |
| **TD-06** | Estratégia de URL única | Usar o UUID (PK) do vídeo direto na URL | ⚠️ **Slug curto separado via `nanoid`** (`varchar(10)`, coluna única, retry-on-conflict espelhando o padrão de nickname do `ChannelsService` — divergiu da recomendação: URL pública amigável) | `nanoid@5` |
| **TD-07** | Streaming e download | Redirect para GET pré-assinado | **`302` redirect p/ presigned `GetObject`** (streaming e download). Download acrescenta `response-content-disposition=attachment`. Range/`206` é servido nativamente pelo storage no follow-up do cliente — o endpoint não lê nem repassa o header. Proxy pela API **excluído** | `@aws-sdk/s3-request-presigner` |
| **TD-08** | Ciclo de status e falhas | Enum de 4 estados + retry/backoff nativo da fila | **`draft → processing → ready \| error`**; falhas transientes absorvidas pelo retry do pg-boss (`retryLimit: 3`, `retryDelay: 5`, `retryBackoff: true`); esgotado o retry → `error` + `error_reason`. Sem DLQ/reprocesso manual nesta fase | — |
| **cleanup/TD-01** | Limpeza de upload abandonado (fecha MD-1) | Job agendado (pg-boss `schedule()`) + `AbortMultipartUpload` explícito | **Cron horário `0 * * * *`** varre `videos WHERE status='draft' AND created_at < now() - 24h`, chama `AbortMultipartUpload` com o `upload_id` salvo, flipa p/ `error` (`error_reason: upload_abandoned_ttl_exceeded`). TTL 24h e cadência = constantes | `pg-boss`, `@aws-sdk/client-s3` |

**Data Model efetivado (`videos`)** — `id uuid PK` · `channel_id uuid FK→channels not null` ·
`slug varchar(10) unique not null` · `title varchar(255) null` ·
`status enum(draft|processing|ready|error) not null default draft` · `error_reason varchar(255) null` ·
`storage_key varchar(512) not null` · `thumbnail_key varchar(512) null` · `upload_id varchar(255) null` ·
`duration_seconds integer null` · `metadata jsonb null` · `created_at`/`updated_at timestamptz`.
Índices: unique `slug`, index `channel_id`, index `status` (usado pela query do sweep).
Migration: `nestjs-project/src/database/migrations/<timestamp>-CreateVideos.ts`.

**Endpoints efetivados:** `POST /videos` (201; body `title?`, `fileName`, `fileSize`, `contentType`;
resp `id`, `slug`, `status`, `uploadId`, `parts[]`) · `POST /videos/:id/complete-upload`
(200; body `parts[{partNumber, eTag}]`; resp `id`, `status: processing`) ·
`GET /videos/:slug` (200; auth opcional) · `GET /videos/:slug/stream` (302) ·
`GET /videos/:slug/download` (302). Envelope de erro herdado de `phase-02-auth/TD-07`.
Error Catalog: `VIDEO_FILE_TOO_LARGE` 400 · `VIDEO_NOT_FOUND` 404 · `VIDEO_NOT_OWNED` 403 ·
`VIDEO_UPLOAD_ALREADY_COMPLETED` 409 · `VIDEO_UPLOAD_VERIFICATION_FAILED` 502.
**Authorization Matrix:** `POST` exige owner; reads são públicas p/ vídeos `ready`, e vídeo
não-`ready` retorna **`404` (nunca `403`)** p/ não-owner (regra anti-enumeração). Guard novo:
`OptionalJwtAuthGuard` (`src/auth/guards/`) usado junto com `@Public()` nas três rotas de leitura.

**Infra efetivada no `nestjs-project/compose.yaml`:** serviços `minio` (portas 9000/9001,
`MINIO_ROOT_USER/PASSWORD=streamtube`, healthcheck em `/minio/health/live`, volume `minio-data`),
`minio-init` (one-shot `minio/mc` que faz `mc mb --ignore-existing local/streamtube`),
`video-worker` (mesmo `Dockerfile.dev`/bind-mount da API, dormindo por padrão, entrypoint
`npm run start:worker` → `src/worker/main.ts`). Fila = pg-boss na **mesma instância Postgres**
(schema `pgboss`), sem container próprio. `.env.example` ganhou bloco `# Object Storage (MinIO...)`
com `STORAGE_ENDPOINT=http://minio:9000`, `STORAGE_REGION=us-east-1`, `STORAGE_BUCKET=streamtube`,
`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY=streamtube`. Configs: `src/config/storage.config.ts`,
`src/config/queue.config.ts` (connection string derivada das `DB_*`). Script novo: `start:worker`.
`test:e2e` passou a incluir `--runInBand`.

**Estrutura de código efetivada** (2ª execução): `src/videos/` (`videos.module.ts`,
`videos.controller.ts`, `videos.service.ts` — carrega upload, complete-upload, as 3 leituras E o
sweep de abandonados —, `storage.service.ts`, `entities/video.entity.ts`,
`dto/create-video.dto.ts`, `dto/complete-upload.dto.ts`, `videos.constants.ts`) · `src/queue/`
(`queue.module.ts`, **`queue.service.ts`** — dono do ciclo de vida do cliente pg-boss —,
`queue.constants.ts`) · `src/worker/` (`main.ts`, `worker.module.ts` — **standalone auto-contido**,
com `ConfigModule.forRoot` + `TypeOrmModule.forRootAsync` próprios —, `video-processing.worker.ts`,
`abandoned-upload-cleanup.worker.ts`) · `src/auth/guards/optional-jwt-auth.guard.ts` ·
`src/common/database/postgres-error.ts` (guard tipado de erro Postgres) ·
`src/types/ffprobe-static.d.ts`. **É referência, não contrato** — a estrutura final é decisão do
plano da nova execução; a menos que o objetivo seja reproduzir, use isto para acelerar, não para
copiar cegamente.

**Frontmatter do documento de decisões (anterior):** `scope_type: phase`, `related_phases: [3]`,
`status: decided`, `date: 2026-08-25`.

---

## 6. Lista de atividades — passo a passo

Execute na ordem. Cada etapa do pipeline é uma skill do projeto e gera um artefato. Revise
criticamente cada saída antes de avançar. **Plano frouxo gera implementação frouxa — gaste tempo
no planejamento.**

### Etapa 0 — Setup e verificação do ambiente

- [x] 0.1 Garantir que está no fork do `mba-ia-greenfield-project` (não criar repo novo).
- [x] 0.2 `git fetch` + comparar: `dev` deve conter tudo que `main` tem. Criar a branch de
      trabalho **a partir do tip de `dev`**: `git checkout dev && git pull && git checkout -b feature/phase-03-videos`.
      Nunca commitar direto na `main`.
- [x] 0.3 `cd nestjs-project && docker compose up -d` — subir **apenas infraestrutura**
      (`db`, `mailpit`), **não** o servidor NestJS a menos que explicitamente pedido.
- [x] 0.4 `docker compose ps` — todos os serviços `running`. `docker compose exec db pg_isready -U streamtube`
      → `accepting connections`.
- [x] 0.5 `docker compose exec nestjs-api npm install` (se primeira vez) e
      `docker compose exec nestjs-api npm run migration:run`.
- [x] 0.6 Rodar `npm run env:check` (host) e confirmar a **suíte atual verde**:
      `docker compose exec nestjs-api npm test -- --runInBand` e `npm run test:e2e`.
      `npx tsc --noEmit` e `npm run lint:ci` limpos.
- [x] 0.7 Registrar em `docs/known-issues.md` qualquer dívida pré-existente e não relacionada
      (escopada por arquivo/regra + follow-up). Se estiver tudo limpo, seguir em silêncio.
- [x] 0.8 Se for usar outra ferramenta que não o Claude Code: **portar a fundação de IA**
      (`CLAUDE.md` → arquivo equivalente; skills/sub-agents → mecanismo equivalente ou condução
      manual; `.mcp.json`/MCP Postgres+context7 → config da ferramenta) **antes** de continuar.

### Etapa 1 — Research (decisões técnicas)

- [x] 1.1 Invocar a skill **`research`** para a Fase 03 (`/research phase 03` ou equivalente).
- [x] 1.2 Ler o contexto: `docs/project-plan.md` (Fase 03 + Pontos de Atenção),
      `docs/diagrams/software-arch.mermaid`, decisões das Fases 01–02 (hard constraints — não
      reabrir), `nestjs-project/CLAUDE.md`.
- [x] 1.3 Para **cada** decisão da §5 deste prompt: pesquisar opções (consultar doc oficial das
      libs candidatas via **context7**), registrar trade-offs, escrever `Recommendation` e
      `Decision` no formato TD-NN dos documentos existentes.
- [x] 1.3a **Cruzar com a §5.1** (decisões da execução anterior): para cada TD, se as opções
      levantadas coincidirem, pré-marcar `Decision` com a escolha efetivada anteriormente. Prestar
      atenção aos ⚠️ (TD-01 pg-boss, TD-05 `execa@5`, TD-06 `nanoid` — pontos onde a execução
      anterior divergiu da recomendação ou teve de ajustar versão). Divergir só com motivo escrito
      no TD. Não esquecer o TD ad-hoc **`abandoned-upload-cleanup`** (fecha o MD-1 do `validate`).
- [x] 1.4 Cada TD traça para um bullet de capacidade da Fase 03 (campo `Capability:`).
- [x] 1.5 Salvar em **`docs/decisions/technical-decisions-phase-03-videos.md`** com frontmatter
      (`scope_type: phase`, `related_phases: [3]`, `status`, `date`, `scope_description`).
- [x] 1.6 **Revisão crítica:** as decisões de fila, upload, worker, URL única, streaming e ciclo
      de status estão todas cobertas e justificadas? A escolha de fila tem trade-offs reais
      documentados?

### Etapa 2 — Planejamento (pipeline `context → validate → resolve → build`)

- [x] 2.1 **`plan-context`** (`/plan-context 03` ou `/plan-context phase-03-videos`) →
      `docs/phases/phase-03-videos/context.md`. Consolida project-plan + decisões da fase +
      fases anteriores + testing guide. Usar `docs/phases/phase-02-auth/context.md` como molde.
- [x] 2.2 **`plan-validate`** (`/plan-validate 03`) → `docs/phases/phase-03-videos/validation.md`.
      Gera issues por categoria (Inconsistencies, Ambiguities, Missing Decisions, Dependency Gaps,
      Inherited Constraint Conflicts, Unresolved Open Questions) e um veredito `status: clean|dirty`.
- [x] 2.3 **`plan-resolve`** (`/plan-resolve 03`) → resolve as pendências apontadas (atualiza o
      documento de decisões + `context.md` + marca issues resolvidas) e gera
      **`docs/phases/phase-03-videos/library-refs.md`** com as libs novas **confirmadas via
      context7** (esperado nesta fase: SDK de storage, cliente de fila, wrapper FFmpeg/ffprobe).
- [x] 2.4 **Iterar `plan-validate` ↔ `plan-resolve`** até `validation.md` fechar em
      **`status: clean`**. Não implementar antes disso.
- [x] 2.5 **`plan-build`** (`/plan-build 03`) → **`docs/phases/phase-03-videos/phase-03-videos.md`**,
      com:
      - **Step Implementations** `SI-03.1`, `SI-03.2`, … (bem fatiados).
      - **Technical Specifications:** Data Model, API Contracts, Authorization Matrix,
        Error Catalog **e Events/Messages** (obrigatório — por causa da fila).
      - **Dependency Map** e **Deliverables**.
- [x] 2.6 **`plan-test-specs`** (opcional) — só se o build emitiu placeholders de spec.
- [x] 2.7 **Revisão crítica do plano:** os contratos de API e os eventos da fila estão definidos?
      O Data Model cobre canal-dono, status, chaves de storage, duração/metadados, id da URL única?
      Os SIs isolam infra (Compose), migration, serviço de storage, endpoints de upload, worker,
      streaming e download? A estratégia de upload **não** passa o arquivo de 10GB pela API?

### Etapa 3 — Implementação (skill `implement`, SI a SI)

Conduzir pela skill **`implement`**, um SI por vez, rodando os testes a cada passo e só avançando
com a suíte do SI **verde**. Ordem sugerida dos SIs (a estrutura concreta de arquivos é decisão
do **seu plano**, não deste prompt; use `auth/` como referência de forma). **Antes de cada SI,
cruzar com a §5.1** (infra/endpoints/estrutura já efetivados na execução anterior) **e a §11**
(problemas já mapeados para aquele SI). A ordem e o fatiamento abaixo já bateram com os SIs
`SI-03.1`…`SI-03.8` da execução anterior:

- [x] 3.1 **Infra nova no `nestjs-project/compose.yaml`:** serviços de **object storage** (MinIO),
      **fila** e **worker**, subindo junto com a stack do backend. Hosts = nomes de serviço do
      Compose. Healthchecks e `depends_on` como no padrão atual.
- [x] 3.2 **Config namespaces** (`@nestjs/config`) para storage (endpoint, credenciais, buckets),
      fila e worker. Atualizar `.env`/`.env.example` **shell-safe** (aspas em valores com
      caracteres especiais).
- [x] 3.3 **Migration** criando a **tabela de vídeos** (`<timestamp>-CreateVideos.ts` via
      `npm run migration:generate`), entidade **ligada ao canal**. Testes `*.integration-spec.ts`
      da entidade.
- [x] 3.4 **Módulo `videos/`**: entidade, DTOs, repository, service, controller — seguindo as
      rules (`.claude/rules/nestjs-*`, `typeorm-*`): separação de camadas, repository pattern,
      transações, uso de fila/eventos. Registrar em `AppModule`.
- [x] 3.5 **Serviço de object storage** (cliente S3-compatível): criação/organização de
      buckets/chaves, geração de **URL pré-assinada** para upload direto. Testes de integração
      contra o MinIO do Compose (não mockar).
- [x] 3.6 **Endpoint de início de upload:** pré-cadastra o vídeo como **rascunho** ligado ao
      canal do usuário autenticado, gera o **id da URL única**, devolve a(s) credencial(is)/URL
      pré-assinada. Sem bufferizar arquivo na API.
- [x] 3.7 **Endpoint de confirmação de upload:** valida que o objeto chegou ao storage, muda
      status para `processando` e **publica o job na fila** (Events/Messages do plano).
- [x] 3.8 **Worker de vídeo** (processo/container separado): consome a fila, baixa/lê do storage,
      roda **ffprobe** (duração/metadados) e **FFmpeg** (thumbnail de um frame), grava thumbnail
      no storage, atualiza o registro (duração, metadados, chave do thumbnail) e status →
      `pronto`. Em falha: retry/observabilidade e status → `erro`. Idempotente.
- [x] 3.9 **Streaming:** endpoint público que serve o vídeo por **Range / `206 Partial Content`**
      (`Accept-Ranges`, `Content-Range`), sem exigir download completo. Vídeos só acessíveis
      conforme a Authorization Matrix do plano.
- [x] 3.10 **Download:** endpoint que entrega o arquivo do vídeo ao usuário.
- [x] 3.11 **Documentação OpenAPI** (`@nestjs/swagger`) dos novos endpoints; rodar
       `npm run openapi:export` se aplicável.
- [x] 3.12 **Testes por nível a cada SI** — unit (`*.spec.ts`), integração com DB/MinIO/fila
       reais (`*.integration-spec.ts`), e2e HTTP (`*.e2e-spec.ts` em `test/`). Rodar com
       `--runInBand`. **Não mockar o que a infra do Compose permite exercitar de verdade.**
- [x] 3.13 Atualizar **`docs/phases/phase-03-videos/progress.md`** a cada SI (status + testes
       por SI + observações), no formato da Fase 02.
- [x] 3.14 **Commit por SI** depois que testes e lint do SI passam (mensagem curta, foco no
       "porquê"). Branch `feature/phase-03-videos`.

### Etapa 4 — Fechamento e Definition of Done

- [x] 4.1 Rodar a **suíte completa** dentro do container: `npm test -- --runInBand` e
      `npm run test:e2e` — **verdes**.
- [x] 4.2 `npx tsc --noEmit` → **código 0**. `npm run lint:ci` e `npm run format:check` → limpos.
- [x] 4.3 `npm run smoke` (estendido para o fluxo de vídeo: upload → confirmação → processamento
      → streaming/download) contra o app real rodando.
- [x] 4.4 Verificação manual end-to-end: `docker compose up -d` sobe **API + Postgres + Mailpit
      + storage + fila + worker**; um upload real de arquivo grande não trava a API; o worker
      processa e gera thumbnail; a URL única funciona; o streaming responde `206`.
- [x] 4.5 **Atualizar `nestjs-project/CLAUDE.md`** (e/ou `CLAUDE.md` da raiz) com a **seção de
      vídeos**: módulo `videos/`, endpoints, fila/worker, storage, novos serviços do Compose,
      novos comandos. **Documentação que cite arquivos ou comportamentos inexistentes reprova** —
      refletir o estado **real** do código.
- [x] 4.6 Revisar `docs/diagrams/software-arch.mermaid`: se a tecnologia de fila foi decidida,
      trocar `"TBD"` pela escolha real (mudança de doc isolada, commit próprio).
- [x] 4.7 Revisar os **Critérios de Aceite** (§7) item a item antes do push.
- [x] 4.8 Push da branch `feature/phase-03-videos`. PR para **`dev`** (nunca para `main`).

---

## 7. Critérios de Aceite (todos obrigatórios — lista única de avaliação)

**Decisões e planejamento**

- [x] `technical-decisions-phase-03-videos.md` com as decisões em aberto **resolvidas e
      justificadas**: fila, estratégia de upload, streaming, processamento/thumbnail, ciclo de
      status.
- [x] Pasta `docs/phases/phase-03-videos/` com `context.md`, `validation.md` (**`status: clean`**),
      o plano `phase-03-videos.md`, `progress.md` e `library-refs.md` (esperado nesta fase).
- [x] O plano segue o formato do projeto: SIs `SI-03.x`, Technical Specifications (Data Model,
      API Contracts, Authorization Matrix, Error Catalog, **Events/Messages**), Dependency Map e
      Deliverables.

**Implementação — feature**

- [x] Upload de vídeo de **até 10GB sem travar a API**, com pré-cadastro do vídeo como **rascunho**
      ao iniciar.
- [x] Processamento automático após o upload: **extração de duração/metadados** e **geração de
      thumbnail**.
- [x] **URL única por vídeo**, sem conflito.
- [x] **Streaming** funcionando (sem exigir download completo) e **download** do vídeo disponível.
- [x] **Ciclo de status** do vídeo (`rascunho → processando → pronto/erro`) refletido no banco.

**Implementação — infraestrutura e qualidade**

- [x] **Object storage, fila e worker subindo via `docker compose`** junto com o backend.
- [x] **Migration** cria a tabela de vídeos; **entidade ligada ao canal**.
- [x] Testes nos níveis adequados, **verdes** (`npm test` e `npm run test:e2e`).
- [x] **Definition of Done completa:** suíte verde + `npx tsc --noEmit` (código 0) +
      `npm run lint:ci` + `npm run format:check`.
- [x] **Git Flow respeitado** (trabalho em `feature/*` a partir de `dev`, sem commit direto na `main`).

**Documentação e ferramenta**

- [x] `CLAUDE.md` (ou equivalente) atualizado com a seção de vídeos, **coerente com o código**.
- [x] Se usou outra ferramenta que não o Claude Code: fundação de IA portada para a convenção
      dela e artefatos da pasta da fase entregues no mesmo formato.

---

## 8. Reprova automática (evitar a todo custo)

- Pular o workflow: implementar sem as etapas de research, planejamento e implementação (e seus
  artefatos).
- Plano sem SIs ou sem as Technical Specifications, ou `validation.md` que **não fecha em `clean`**.
- **Passar o arquivo de 10GB pela API** de forma que trave o sistema (sem estratégia de upload
  assíncrono/direto).
- **Não ter fila, worker e storage reais subindo no Compose.**
- `tsc` com erro, lint quebrado ou suíte vermelha.
- **Commit direto na `main`.**
- `CLAUDE.md`/equivalente inconsistente com o código.
- Usar outra ferramenta sem portar a fundação para a convenção dela.

---

## 9. Estrutura do entregável (o que é novo/alterado)

```
mba-ia-greenfield-project/
├── docs/
│   ├── decisions/
│   │   └── technical-decisions-phase-03-videos.md        ← research
│   ├── diagrams/
│   │   └── software-arch.mermaid                         ← "TBD" da fila → escolha real
│   └── phases/
│       └── phase-03-videos/                              ← pasta da fase (molde: phase-02-auth/)
│           ├── context.md                                ← plan-context
│           ├── validation.md                             ← plan-validate (status: clean)
│           ├── library-refs.md                           ← plan-resolve (libs via context7)
│           ├── phase-03-videos.md                        ← plan-build (o plano)
│           └── progress.md                               ← implement
├── nestjs-project/
│   ├── CLAUDE.md                                         ← + seção de vídeos
│   ├── compose.yaml                                      ← + object storage, fila, worker
│   ├── .env / .env.example                               ← + namespaces de storage/fila/worker
│   ├── nest-cli.json                                     ← + assets não-.ts do worker, se houver
│   ├── src/
│   │   ├── app.module.ts                                 ← registra VideosModule
│   │   ├── videos/                                       ← novo módulo (forma de referência: auth/)
│   │   │   └── ...                                       ← estrutura definida pelo plano
│   │   └── database/migrations/
│   │       └── <timestamp>-CreateVideos.ts
│   └── (worker de vídeo — local conforme o seu plano)
└── CLAUDE.md                                             ← atualizado se necessário
```

**Repositório base:** https://github.com/devfullcycle/mba-ia-greenfield-project — o fork é a
estrutura de trabalho; você **adiciona/edita** arquivos dentro dele, não cria repo novo.

---

## 10. Dicas finais

- **A Fase 03 é grande; o plano é o que segura.** Quanto melhores as decisões e o plano (SIs
  bem fatiados, contratos e eventos definidos), mais limpa a implementação.
- **Upload de 10GB é decisão de arquitetura, não de força bruta.** Pesquise a estratégia certa
  antes de codar; passar o arquivo inteiro pela API é o caminho errado.
- **Infra real, testada.** Fila, worker e storage precisam subir no Compose e ser exercitados
  pelos testes: não simule o que dá para rodar de verdade.
- **Continuidade, não retrabalho.** Reuse os padrões do projeto (guard JWT global, filtro de
  exceções de domínio, repository pattern, migrations, rules, ValidationPipe, throttler). Você
  está somando uma fase, não reescrevendo o que já existe.
- **Ferramenta é escolha sua, workflow não.** O encadeamento research → planejamento →
  implementação e os artefatos da fase são os mesmos independentemente da ferramenta.
- **Leia a §11 antes de implementar.** A execução anterior já pagou o custo de descobrir os
  problemas de ESM/Jest, relações TypeORM, `--runInBand` e flakiness de fila — antecipe-os.

---

## 11. Problemas encontrados nas execuções anteriores (antecipe / evite)

Registrados a partir do `progress.md` das SIs `03.1`–`03.10` da branch `feature/phase-03-videos`
(§11.1–§11.7 da 1ª execução; **§11.8 da 2ª, 2026-09-01**). Não são requisitos — são armadilhas já
mapeadas. Trate cada uma como um item de verificação durante o SI correspondente.

### 11.1 ESM vs. Jest (CommonJS) — o maior consumidor de tempo

- **`pg-boss` é ESM-only** e quebrou o Jest em **toda suíte que dá boot no `AppModule` real**
  (`openapi-export.integration-spec.ts`, e2e). Correção: adicionar `transformIgnorePatterns` para
  a cadeia `pg-boss → serialize-error → non-error` **em `package.json` (jest) e em
  `test/jest-e2e.json`**. Latente desde a SI da fila; só apareceu no primeiro full-suite run.
- **`nanoid` v5 também é ESM-only** — mesmo tratamento (adicionar à mesma lista
  `transformIgnorePatterns`, proativamente).
- **`execa` v10 é ESM-only com cadeia de ~15 pacotes**, incluindo `unicorn-magic` cujo
  `package.json#exports` **não tem condição `require` nenhuma** — parede intransponível para
  `transformIgnorePatterns`. Correção: **downgrade para `execa@5.1.1`** (último major CommonJS;
  o TD nomeia a lib, não a versão). Import muda para `import execa from 'execa'` (v5 usa
  `export =`). Reverter os `transformIgnorePatterns` que a v10 tinha exigido.
- **Padrão de decisão:** antes de fixar qualquer lib nova, checar se ela (e a árvore dela) é
  ESM-only e se o projeto (ts-jest/CommonJS) aguenta. Preferir a última major CommonJS quando
  existir. Valor final na `package.json` da execução anterior:
  `"transformIgnorePatterns": ["node_modules/(?!(pg-boss|serialize-error|non-error|type-fest|nanoid)/)"]`.

### 11.2 Relações TypeORM e módulos de teste isolados

- Adicionar `@OneToMany(() => Video, ...)` em `Channel` **quebra o boot do `AppModule`** enquanto
  nenhum módulo registra `Video` via `TypeOrmModule.forFeature`. Estratégia usada: manter
  `Video.channel` como `@ManyToOne` unilateral na SI da migration e **só restaurar a relação
  inversa na SI do `VideosModule`**.
- Ao introduzir a entidade `Video`, vários **module specs pré-existentes** (`auth.module.spec.ts`,
  `channels.module.spec.ts`, `users.module.spec.ts`) e integration specs precisaram de `Video`
  adicionado às suas listas isoladas de entidades — mesma classe de bug de resolução de relação.
- O `WorkerModule` precisou registrar **`Channel` e `User`** via `forFeature` além de `Video`
  (cadeia `Video → Channel → User`).
- Quando `VideosModule` importa `AuthModule` (para reusar o `JwtModule` que ele exporta), isso
  puxa `MailModule`/`ThrottlerModule` transitivamente — o `videos.module.spec.ts` isolado passou
  a precisar de `appConfig`/`authConfig`/`mailConfig` além de `storageConfig`/`queueConfig`.

### 11.3 Testes de integração / e2e e a fila compartilhada

- **`test:e2e` estava sem `--runInBand`** apesar do `CLAUDE.md` afirmar "already configured".
  Workers e2e paralelos dando boot no `AppModule` (agora mais pesado, com conexão pg-boss real)
  causavam timeouts de 5s em hooks. Correção: **corrigir o script** (`--runInBand`) e subir os
  `beforeAll` de `app.e2e-spec.ts`/`auth.e2e-spec.ts`/`swagger.e2e-spec.ts` para **30s**.
- **`moduleRef.close()` incompleto:** integration specs que só chamavam `dataSource.destroy()`
  deixavam a conexão pg-boss aberta → warning "Jest did not exit". Correção: guardar e fechar o
  `TestingModule` inteiro.
- **Backlog na tabela `pgboss.job`:** rodadas repetidas de teste acumulam jobs `created` que
  ninguém drena fora do único integration test do worker → ordem FIFO empurra o job do teste
  para trás e estoura o timeout de 30s. Mitigação: purgar `pgboss.job` via SQL entre sessões;
  o teste do worker só resolve/rejeita no job com o **seu próprio `videoId`** (guarda contra
  contaminação cross-suite).
- **Processo `npm run start:worker` esquecido rodando** no container `video-worker` (de
  verificação manual) corria com o `boss.work()` do teste pelos jobs da fila compartilhada.
  Sempre matar o worker manual antes de rodar a suíte.
- **Corridas em `migrations.integration-spec.ts`:** `DROP TYPE` concorrente com
  `DROP TABLE ... CASCADE` entre conexões pooled, e depois deadlock entre `DROP TABLE CASCADE`
  concorrentes. Correção: sequenciar o cleanup (filhos antes de pais), não paralelizar. Necessário
  assim que o segundo enum (`videos_status_enum`) entrou.
- **Flakiness transitória do MinIO:** warning `Storage resources are insufficient for the write
  operation` (drive ciclando offline/online) fez uma rodada levar 421s em vez de ~10s. Auto-curou
  em poucos minutos; não é bug de código. Ter em mente antes de "consertar" um teste lento.

### 11.4 FFmpeg / worker

- **`ffmpeg -ss 1` falha silenciosamente** (exit 0, não escreve arquivo) para vídeos com menos de
  1 segundo. Nada nos critérios garante duração mínima → usar **`-ss 0`**, que sempre tem frame.
- **`uploadObject` precisa de `ContentLength` explícito** (via `fs.stat`) — o AWS SDK não infere
  a partir de um `fs.createReadStream` cru e falha com erro críptico de header.
- Vídeo **nunca passa pela API** (TD-02): o worker baixa o objeto do storage
  (`StorageService.downloadObject`), roda ffprobe/ffmpeg contra a cópia local temporária, sobe o
  thumbnail (`StorageService.uploadObject`), limpa o tempdir.
- `handleJob(job)` usa `{ includeMetadata: true }` no `boss.work` e checa
  `job.retryCount >= job.retryLimit` para decidir se **esta** falha é a última antes de setar
  `status: error` — mas **sempre** re-lança, deixando o retry/backoff do pg-boss seguir.
- Verificar o entrypoint real do container (`docker compose exec video-worker npm run start:worker`)
  bootando limpo contra a infra real **antes** de finalizar a SI.

### 11.5 Auth / cobertura

- A Authorization Matrix precisa de **auth opcional** (anônimo permitido, dono vê mais) em
  `GET /videos/:slug`, `/stream`, `/download`. O `JwtAuthGuard` global é binário (`@Public()`
  pula tudo, ou 401). Solução: **`OptionalJwtAuthGuard` novo** (`src/auth/guards/`) — decodifica
  e anexa `request.user` se houver Bearer válido, mas sempre retorna `true`; usado **junto com
  `@Public()`** nas três rotas.
- Vídeo não-`ready` retorna **`404` (nunca `403`)** para anônimo e para autenticado não-dono
  (regra anti-enumeração). Centralizar num único `getVisibleVideoBySlug(slug, userId?)` privado
  para a regra não divergir entre os três call sites.
- A branch `502 VIDEO_UPLOAD_VERIFICATION_FAILED` (`HeadObject` falhando **após**
  `CompleteMultipartUpload` bem-sucedido) só é coberta por **unit test** — forçar essa sequência
  deterministicamente contra o MinIO real não é prático. É o split intencional do plano, não um gap.

### 11.6 Dívida de lint deixada para trás (custou uma branch inteira depois)

- A execução anterior deixou erros **`no-unsafe-*`** em `videos.service.ts`/`videos.service.spec.ts`
  "seguindo o padrão pré-existente de `channels.service.ts`", sob Scope Limits. Isso **depois
  exigiu uma branch dedicada** (`bugfix/nestjs-lint-strictness`, ~9 SIs: eslint
  `strict-type-checked`, `tsconfig` strict, retipagem de specs com `createMock` do
  `@golevelup/ts-jest`, guard tipado de erro Postgres, script `lint:ci`) para zerar sob
  `strictTypeChecked`.
- **Lição para a nova execução:** o `CLAUDE.md` atual já exige `npm run lint:ci` **e**
  `npm run format:check` limpos por arquivo tocado, a cada SI (não no fim). Tipar corretamente
  desde o início (sem `any`/`no-unsafe-*` novo); se algo pré-existente e fora de escopo aparecer,
  **entrada escopada em `docs/known-issues.md` + follow-up**, nunca "segue o padrão e deixa".

### 11.7 Issue de validação que a nova execução também deve esperar

- O `plan-validate` anterior levantou **MD-1**: nenhum TD tratava upload abandonado/nunca
  concluído (rascunho preso em `draft` para sempre + multipart órfão consumindo storage). Foi
  fechado criando o TD ad-hoc **`abandoned-upload-cleanup`** via `plan-resolve`/`/research`, não
  estendendo o TD-08. Espere esse mesmo issue e resolva do mesmo jeito (ou melhor).

### 11.8 Novas armadilhas da 2ª execução (2026-09-01)

- **Git Bash (Windows) reescreve `/tmp/...` passado como argumento cru para `docker compose exec`**
  em caminho de host (`C:/Users/.../Temp/...`) — o `stat /tmp/smoke.mp4` do smoke falhava mesmo
  com o `ffmpeg` tendo gravado o arquivo. Correção: **todo caminho in-container fica dentro de um
  `sh -c '...'` de aspas simples** (protege da conversão MSYS). Vale para o smoke e para qualquer
  script host que chame binário no container com path absoluto.
- **`npm run format:check` reprova o repo inteiro num checkout Windows** — não é indentação, é
  **fim de linha**: `core.autocrlf=true` + `.gitattributes` só fixa `*.sh` como `eol=lf`, então
  todo `.ts` é CRLF em disco e o Prettier (`endOfLine: "lf"`) sinaliza tudo. Arquivo recém
  `prettier --write` passa até o próximo round-trip do git. Rastreado em **KI-2**; o fix real é
  `*.ts text eol=lf` no `.gitattributes` + `git add --renormalize .` + `"endOfLine": "auto"` no
  `.prettierrc` (tarefa `bugfix/nestjs-lint-strictness`, junto da KI-1). Arquivos novos/tocados
  da fase passam individualmente — foi assim que o gate por-arquivo do `CLAUDE.md` foi satisfeito.
- **`WorkerModule` virou standalone auto-contido** — bundla o próprio `ConfigModule.forRoot` +
  `TypeOrmModule.forRootAsync` (espelhando o `AppModule`), porque `src/worker/main.ts` o sobe via
  `NestFactory.createApplicationContext` (sem HTTP). O `worker.module.spec.ts` importa o módulo
  real e conecta no banco real — mesmo precedente `.spec.ts`-toca-DB do `videos.module.spec.ts`.
  `main.ts` faz `boss.work(...)` para `video-processing` e `boss.createQueue` + `boss.schedule` +
  `boss.work` para `abandoned-upload-sweep`; `boss.schedule` é upsert (idempotente no restart).
- **Enfileiramento transacional real**: `completeUpload` passa a opção `db` do pg-boss
  (`{ executeSql }` apoiado no `manager.query` da transação TypeORM) — o `INSERT` do job commita
  atômico com o flip `draft → processing` + `upload_id = null`.
- **`@ApiBearerAuth` no `VideosController`** foi do nível de classe (form sem-arg da 1ª execução,
  que apontava para um scheme `bearer` inexistente) para o nível de método (`'access-token'`,
  o scheme que o `buildSwaggerConfig` de fato define) nos 2 POSTs; as 3 leituras são `@Public()`
  e não levam `@ApiBearerAuth` (regra `nestjs-controllers.md`).
- **`start:worker` é `ts-node`** (não compilado). Deixe o container `video-worker` **parado**
  fora da verificação manual/smoke — um `boss.work()` vivo corre com as suítes pelos jobs de
  `pgboss.job` (a mitigação do smoke é purgar `pgboss.job` antes do cenário de vídeo).
