---
kind: task
name: task-nestjs-lint-strictness
test_specs_aware: true
sources_mtime:
  docs/tasks/task-nestjs-lint-strictness/context.md: "2026-09-01T14:11:50-03:00"
  docs/decisions/technical-decisions-nestjs-lint-strictness.md: "2026-09-01T14:05:27-03:00"
  docs/decisions/technical-decisions-workflow-hardening-guardrails.md: "2026-08-31T21:46:55-03:00"
  docs/phases/phase-03-videos/context.md: "2026-08-31T21:46:55-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-19T18:32:39-03:00"
---

# task-nestjs-lint-strictness

## Objective

Close KI-1 (no-unsafe-* lint violations in phase 01-02 test files) and KI-2 (Prettier CRLF failures) from docs/known-issues.md so the backend is fully and correctly typed with zero lint errors/warnings on the affected files

---

## Step Implementations

### SI-1 — Infra: instalar `@golevelup/ts-jest`

**Description:** Traz a dependência de dev decidida em `nestjs-lint-strictness/TD-01` para o `nestjs-project/` — fundação que SI-2 a SI-6 consomem para retipar os mocks de Jest.

**Technical actions:**

1. Adicionar `@golevelup/ts-jest` como dev dependency em `nestjs-project/package.json` (per `nestjs-lint-strictness/TD-01`) e instalar dentro do container (`docker compose exec nestjs-api npm install`).

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose exec nestjs-api npm ls @golevelup/ts-jest` resolve sem erro.
- `docker compose exec nestjs-api npx tsc --noEmit` continua saindo com código `0` após a instalação (sem regressão de compilação).

### SI-2 — Retipar test doubles do módulo auth (`createMock<T>()`)

**Description:** Retipa os mocks de `useValue`/`jest.fn()` em `auth.service.spec.ts` e `auth.service.integration-spec.ts` com `createMock<T>()`, fechando 52 das ~147 violações de `no-unsafe-*` do KI-1.

**Technical actions:**

1. Retipar os mocks de `src/auth/auth.service.spec.ts` com `createMock<T>()` de `@golevelup/ts-jest` (per `nestjs-lint-strictness/TD-01`) — 45 violações.
2. Retipar os mocks de `src/auth/auth.service.integration-spec.ts` da mesma forma — 7 violações.

**Tests:** _(empty — este SI retipa test doubles já existentes; a suíte de testes já existente para estes arquivos é a verificação, não há autoria de novos testes)_

**Dependencies:** SI-1

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint:ci` reporta zero violações `@typescript-eslint/no-unsafe-*` em `src/auth/auth.service.spec.ts` e `src/auth/auth.service.integration-spec.ts`.
- `docker compose exec nestjs-api npm test -- src/auth/auth.service.spec.ts` passa com as mesmas asserções de antes da retipagem.
- `docker compose exec nestjs-api npm test -- src/auth/auth.service.integration-spec.ts --runInBand` passa com as mesmas asserções de antes da retipagem.

---

### SI-3 — Retipar test double do módulo channels + corrigir guard de erro Postgres

**Description:** Retipa o mock de `channels.service.spec.ts` com `createMock<T>()` e corrige o cast `as any` em `channels.service.ts` usando o padrão de guard já canônico do projeto — fecha 21 das ~147 violações do KI-1, sem precisar de uma nova TD para o segundo item.

**Technical actions:**

1. Retipar os mocks de `src/channels/channels.service.spec.ts` com `createMock<T>()` (per `nestjs-lint-strictness/TD-01`) — 15 violações.
2. Corrigir `src/channels/channels.service.ts`'s `const e = err as any;` usando o guard `err instanceof`-narrowed já implementado em `src/common/database/postgres-error.ts` (per `.claude/rules/typescript-strict.md` → "Typing External/Driver Boundaries" — padrão já canônico, sem TD dedicada) — 6 violações.

**Tests:** _(empty — este SI retipa um test double e estreita um cast de erro já existente; a suíte de testes já existente é a verificação)_

**Dependencies:** SI-1

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint:ci` reporta zero violações `@typescript-eslint/no-unsafe-*` em `src/channels/channels.service.spec.ts` e `src/channels/channels.service.ts`.
- `docker compose exec nestjs-api npm test -- src/channels/channels.service.spec.ts` passa com as mesmas asserções de antes da retipagem.
- O comportamento de retry em colisão de nickname único em `createChannel` permanece inalterado (coberto pela suíte de testes já existente).

---

### SI-4 — Retipar test double do módulo mail

**Description:** Retipa o mock de `mail.service.integration-spec.ts` com `createMock<T>()`, fechando 16 das ~147 violações do KI-1.

**Technical actions:**

1. Retipar os mocks de `src/mail/mail.service.integration-spec.ts` com `createMock<T>()` (per `nestjs-lint-strictness/TD-01`) — 16 violações.

**Tests:** _(empty — este SI retipa um test double já existente; a suíte de integração já existente é a verificação)_

**Dependencies:** SI-1

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint:ci` reporta zero violações `@typescript-eslint/no-unsafe-*` em `src/mail/mail.service.integration-spec.ts`.
- `docker compose exec nestjs-api npm test -- src/mail/mail.service.integration-spec.ts --runInBand` passa com as mesmas asserções de antes da retipagem.

---

### SI-5 — Retipar test doubles dos exception filters

**Description:** Retipa os mocks de `domain-exception.filter.spec.ts` e `validation-exception.filter.spec.ts` com `createMock<T>()`, fechando 9 das ~147 violações do KI-1.

**Technical actions:**

1. Retipar os mocks de `src/common/filters/domain-exception.filter.spec.ts` com `createMock<T>()` (per `nestjs-lint-strictness/TD-01`) — 7 violações.
2. Retipar os mocks de `src/common/filters/validation-exception.filter.spec.ts` da mesma forma — 2 violações.

**Tests:** _(empty — este SI retipa test doubles já existentes; a suíte de testes já existente é a verificação)_

**Dependencies:** SI-1

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint:ci` reporta zero violações `@typescript-eslint/no-unsafe-*` nos dois arquivos de filter spec.
- `docker compose exec nestjs-api npm test -- src/common/filters` passa com as mesmas asserções de antes da retipagem.

---

### SI-6 — Retipar test double do módulo users

**Description:** Retipa o mock de `users.service.integration-spec.ts` com `createMock<T>()`, fechando a última violação restante do KI-1 fora do e2e.

**Technical actions:**

1. Retipar os mocks de `src/users/users.service.integration-spec.ts` com `createMock<T>()` (per `nestjs-lint-strictness/TD-01`) — 1 violação.

**Tests:** _(empty — este SI retipa um test double já existente; a suíte de integração já existente é a verificação)_

**Dependencies:** SI-1

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint:ci` reporta zero violações `@typescript-eslint/no-unsafe-*` em `src/users/users.service.integration-spec.ts`.
- `docker compose exec nestjs-api npm test -- src/users/users.service.integration-spec.ts --runInBand` passa com as mesmas asserções de antes da retipagem.

---

### SI-7 — Retipar leitura de response bodies em `auth.e2e-spec.ts`

**Description:** Aplica a convenção revisada (`nestjs-lint-strictness/TD-04`) de interface local por shape + cast direto, já estabelecida em `test/videos.e2e-spec.ts`, fechando as 48 violações restantes do KI-1.

**Technical actions:**

1. Declarar uma `interface` local por shape de response usada em `test/auth.e2e-spec.ts` (ex.: respostas de login/register/refresh), seguindo exatamente a convenção de `test/videos.e2e-spec.ts` (per `nestjs-lint-strictness/TD-04`).
2. Substituir cada leitura não tipada `res.body.<campo>` por um cast direto `res.body as <InterfaceName>` em cada call site — 48 violações.

**Tests:** _(empty — este SI retipa leituras de response em um e2e spec já existente; a suíte e2e já existente é a verificação)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint:ci` reporta zero violações `@typescript-eslint/no-unsafe-*` em `test/auth.e2e-spec.ts`.
- `docker compose exec nestjs-api npm run test:e2e` passa com as mesmas asserções de antes da retipagem.

---

### SI-8 — Normalização repo-wide de line endings (`.gitattributes` + Prettier)

**Description:** Fecha o KI-2 na raiz: fixa `.ts` em LF no checkout via `.gitattributes`, renormaliza os arquivos já trackeados, e adiciona `endOfLine: "auto"` ao Prettier como defesa em profundidade (per `nestjs-lint-strictness/TD-03`).

**Technical actions:**

1. Adicionar `*.ts text eol=lf` a `.gitattributes` (per `nestjs-lint-strictness/TD-03`).
2. Rodar `git add --renormalize .` para renormalizar os line endings de todo `.ts` já trackeado em um commit isolado, somente-line-ending (per `CLAUDE.md` → "Scope Limits" — sem mistura com mudança funcional).
3. Adicionar `"endOfLine": "auto"` a `nestjs-project/.prettierrc` (per `nestjs-lint-strictness/TD-03`).

**Tests:** _(empty — mudança de configuração de tooling repo-wide, sem artefato testável)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run format:check` sai com código `0` em `src/**/*.ts` e `test/**/*.ts` (atualmente ~66 arquivos falham).
- `git check-attr text eol -- <arquivo .ts de amostra>` reporta `eol: lf`, confirmando que um novo checkout produz LF independente do `core.autocrlf` do contribuidor.

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-1 (root)
├── SI-2 — depends on SI-1 (precisa de @golevelup/ts-jest instalado)
├── SI-3 — depends on SI-1
├── SI-4 — depends on SI-1
├── SI-5 — depends on SI-1
└── SI-6 — depends on SI-1
SI-7 (root, independente — TD-04, sem nova dependência)
SI-8 (root, independente — KI-2 é um problema distinto do KI-1)
```

---

## Deliverables

- [ ] SI-1 — Infra: instalar `@golevelup/ts-jest`
- [ ] SI-2 — Retipar test doubles do módulo auth (`createMock<T>()`)
- [ ] SI-3 — Retipar test double do módulo channels + corrigir guard de erro Postgres
- [ ] SI-4 — Retipar test double do módulo mail
- [ ] SI-5 — Retipar test doubles dos exception filters
- [ ] SI-6 — Retipar test double do módulo users
- [ ] SI-7 — Retipar leitura de response bodies em `auth.e2e-spec.ts`
- [ ] SI-8 — Normalização repo-wide de line endings (`.gitattributes` + Prettier)

**Full test suites:**

- [ ] Backend unit + integration tests passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Backend e2e tests passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa com zero erros/warnings nos arquivos tocados (`docker compose exec nestjs-api npm run lint:ci`)
- [ ] Prettier passa (`docker compose exec nestjs-api npm run format:check`)
- [ ] `docs/known-issues.md` atualizado: mover KI-1 e KI-2 de `## OPEN` para `## RESOLVED`
