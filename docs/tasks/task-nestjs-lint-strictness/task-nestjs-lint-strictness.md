---
kind: task
name: task-nestjs-lint-strictness
test_specs_aware: true
sources_mtime:
  docs/tasks/task-nestjs-lint-strictness/context.md: "2026-08-28T13:42:42-03:00"
  docs/tasks/task-nestjs-lint-strictness/library-refs.md: "2026-08-28T13:42:25-03:00"
  docs/decisions/technical-decisions-nestjs-lint-strictness.md: "2026-08-28T13:40:22-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-25T19:34:19-03:00"
---

# Task — nestjs-project Lint Strictness & `any` Elimination

## Objective

Remove blanket ESLint/tsconfig suppressions in nestjs-project and refactor every file with type-safety lint issues, without config shortcuts.

Concretely (measured 2026-08-28, `tsc --noEmit` green): `npm run lint` fails with **504 problems (400 errors, 104 warnings) across 16 files**. Suppression is 100% config-level (zero `// eslint-disable` / `@ts-ignore` in the tree): three rule overrides in `nestjs-project/eslint.config.mjs` (`no-explicit-any: off`, `no-floating-promises: warn`, `no-unsafe-argument: warn`) plus `nestjs-project/tsconfig.json` laxity (`noImplicitAny: false`, `strictBindCallApply: false`, `strict` unset). 12 errors are in production code (`channels.service.ts`, `videos.service.ts` — the `err as any` PG-error idiom); the other 492 are in test files (four repeated anti-patterns: `any` mock factories, `new QueryFailedError(...) as any`, `res.body.*` on supertest's `any` body, `(service as any).privateMember`).

**Affected subprojects:** `nestjs-project/` (backend source + all spec/integration-spec/e2e-spec suites) and repo-wide tooling (`nestjs-project/eslint.config.mjs`, `nestjs-project/tsconfig.json`, the `lint` npm script, the missing CI lint gate). No frontend surface.

---

## Step Implementations

### SI-1 — Instalar dev dependencies de lint e mocking

**Description:** Adicionar as duas bibliotecas novas exigidas pelas decisões (linter de testes e mocking tipado) antes de qualquer mudança de configuração ou de código.

**Technical actions:**

1. Instalar `eslint-plugin-jest` como `devDependency` em `nestjs-project/package.json` — versão compatível com ESLint 9 flat-config + `typescript-eslint@8` (`^28` ou superior) (per `nestjs-lint-strictness/TD-04`)
2. Instalar `@golevelup/ts-jest` como `devDependency` — companheiro de `@nestjs/testing` para `createMock<T>()` (per `nestjs-lint-strictness/TD-05`)
3. Rodar a instalação dentro do container (`docker compose exec nestjs-api npm install`) e commitar `package.json` + `package-lock.json`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `nestjs-project/package.json` lista `eslint-plugin-jest` e `@golevelup/ts-jest` em `devDependencies`
- `docker compose exec nestjs-api npm ci` conclui sem erro de peer-dependency
- `package-lock.json` reflete as duas novas entradas

---

### SI-2 — Reconfigurar ESLint: strictTypeChecked + bloco de testes com eslint-plugin-jest

**Description:** Substituir `recommendedTypeChecked` por `strictTypeChecked` e remover as três overrides que hoje mascaram os erros de type-safety; adicionar um bloco dedicado a arquivos de teste que troca `unbound-method` pela versão jest-aware.

**Technical actions:**

1. `nestjs-project/eslint.config.mjs`: trocar `...tseslint.configs.recommendedTypeChecked` por `...tseslint.configs.strictTypeChecked` na cadeia de `extends` (per `nestjs-lint-strictness/TD-01`)
2. `nestjs-project/eslint.config.mjs`: remover as três overrides do bloco `rules` — `@typescript-eslint/no-explicit-any: 'off'`, `@typescript-eslint/no-floating-promises: 'warn'`, `@typescript-eslint/no-unsafe-argument: 'warn'` (mantendo `prettier/prettier`) (per `nestjs-lint-strictness/TD-01`)
3. `nestjs-project/eslint.config.mjs`: importar `eslint-plugin-jest` e acrescentar um bloco `files: ['**/*.spec.ts', '**/*.integration-spec.ts', 'test/**/*.ts']` com `extends: [jestPlugin.configs['flat/recommended']]` (per `nestjs-lint-strictness/TD-04`)
4. No mesmo bloco de testes: `'@typescript-eslint/unbound-method': 'off'` e `'jest/unbound-method': 'error'` (per `nestjs-lint-strictness/TD-04`)

**Tests:** _(empty — Infra; a config é validada via `--print-config` nos Acceptance criteria)_

**Dependencies:** SI-1 — `eslint-plugin-jest` precisa estar instalado

**Acceptance criteria:**

- `nestjs-project/eslint.config.mjs` não contém mais nenhuma das três chaves `no-explicit-any` / `no-floating-promises` / `no-unsafe-argument` como override
- `docker compose exec nestjs-api npx eslint --print-config src/main.ts` reporta `@typescript-eslint/no-explicit-any` e `@typescript-eslint/no-unsafe-argument` como `"error"`
- `docker compose exec nestjs-api npx eslint --print-config src/videos/videos.service.spec.ts` reporta `jest/unbound-method` como `"error"` e `@typescript-eslint/unbound-method` como `"off"`

---

### SI-3 — Ativar `strict` no tsconfig + definite-assignment assertions nas entities

**Description:** Ligar o conjunto `strict` do compilador (incluindo `noImplicitAny`, `strictBindCallApply`, `useUnknownInCatchVariables`) e ajustar as declarações de coluna das entities TypeORM para o idioma padrão de strict-mode.

**Technical actions:**

1. `nestjs-project/tsconfig.json`: adicionar `"strict": true`; remover as linhas `"noImplicitAny": false` e `"strictBindCallApply": false` (per `nestjs-lint-strictness/TD-02`)
2. Adicionar `!` (definite-assignment assertion) a toda propriedade de coluna/relação sem inicializador em `src/**/*.entity.ts` (`Video`, `Channel`, `User` e demais) — as colunas são sempre populadas após load, então a assertion é correta (per `nestjs-lint-strictness/TD-02`, resolução AMB-1)
3. `nestjs-project/CLAUDE.md` § "Code Conventions" / "ESLint": remover as afirmações "`noImplicitAny` off" e "`no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings" para refletir a nova configuração
4. Resolver erros de compilação `tsc --noEmit` remanescentes introduzidos por `strict` em código de produção que **não** sejam narrowing de bloco `catch` (ex.: `strictBindCallApply`, `strictFunctionTypes`, `noImplicitThis`) — o narrowing de `catch` fica no SI-4

**Tests:** _(empty — mudança de sintaxe TS nas entities e de config; os specs de integração existentes das entities cobrem constraints/defaults e são revalidados nos Deliverables)_

**Dependencies:** none

**Acceptance criteria:**

- `nestjs-project/tsconfig.json` contém `"strict": true` e não contém `"noImplicitAny": false` nem `"strictBindCallApply": false`
- `docker compose exec nestjs-api npx tsc --noEmit` sai com código 0
- `nestjs-project/CLAUDE.md` não menciona mais `noImplicitAny` off nem `no-explicit-any` allowed

---

### SI-4 — Type guard de erro do Postgres + eliminação de `any` no código de produção

**Description:** Criar um guard tipado compartilhado para narrowing de erros do driver Postgres a partir de `unknown` e usá-lo para remover os `err as any` de `channels.service.ts` e `videos.service.ts`, além dos demais `no-unsafe-*` / `no-non-null-assertion` do código de produção.

**Technical actions:**

1. Criar `src/common/database/postgres-error.ts` — guards `isPgError(e: unknown): e is { code: string; detail: string }` e `isUniqueViolation(e: unknown, column: string): boolean` via checagem de `unknown` (`typeof`/`in`), sem `as any` (per `nestjs-lint-strictness/TD-03`)
2. Refatorar `src/channels/channels.service.ts` — substituir `const e = err as any` e a função local `isPgUniqueViolationOnColumn` pelo guard compartilhado (per `nestjs-lint-strictness/TD-03`)
3. Refatorar `src/videos/videos.service.ts` — substituir `const e = err as any` e a função local `isSlugUniqueViolation` pelo guard compartilhado (per `nestjs-lint-strictness/TD-03`)
4. Resolver os `no-unsafe-*` e `no-non-null-assertion` remanescentes em `src/**/*.ts` que não sejam `*.spec.ts` / `*.integration-spec.ts` (ex.: `video.upload_id!`, `res.headers.get('etag')!` → narrowing explícito com throw de exceção de domínio) (per `nestjs-lint-strictness/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `postgres-error.ts` | Unit per testing-guide-nestjs-project § pure-function — guard retorna boolean correto para `QueryFailedError`, objeto com `.code`/`.detail`, `null`, e `unknown` arbitrário | `src/common/database/postgres-error.spec.ts` |

**Dependencies:** SI-3 — `strict` (`useUnknownInCatchVariables`) precisa estar ativo para os blocos `catch` darem `unknown`

**Acceptance criteria:**

- `src/channels/channels.service.ts` e `src/videos/videos.service.ts` não contêm `as any`
- `docker compose exec nestjs-api npx eslint "src/**/*.ts" --no-fix` (ignorando specs) reporta 0 problemas nos arquivos de produção
- `docker compose exec nestjs-api npm test -- channels.service.spec videos.service.spec` continua verde (comportamento preservado)
- O guard rejeita `null` e objetos sem `code` sem lançar exceção

---

### SI-5 — test/contracts + tipagem de response body nos e2e

**Description:** Criar o módulo de contratos de teste com o helper `expectBody<T>()` e retipar os specs e2e para consumir `res.body` tipado, substituindo também os acessos a membros privados por `app.get()`.

**Technical actions:**

1. Criar `test/contracts/` — helper `expectBody<T>(res): T` (seam único de cast) + interfaces de response: reusar `InitiateUploadResult` / `CompleteUploadResult` / `VideoDetailResult` exportadas de `src/videos/videos.service.ts`; declarar os payloads de token de auth e o envelope de erro dos exception filters (per `nestjs-lint-strictness/TD-06`)
2. Refatorar `test/auth.e2e-spec.ts` — tipar `res.body` via `expectBody<T>`; trocar `(authService as any).mailService` por `app.get(MailService)` (singleton) (per `nestjs-lint-strictness/TD-06`)
3. Refatorar `test/videos.e2e-spec.ts` — mesma retipagem de `res.body` + `app.get()` (per `nestjs-lint-strictness/TD-06`)
4. Refatorar `test/app.e2e-spec.ts` e `test/swagger.e2e-spec.ts` — tipar `res.body` onde houver `no-unsafe-*`; corrigir `require-await` / `no-unused-vars` remanescentes (per `nestjs-lint-strictness/TD-06`, `nestjs-lint-strictness/TD-01`)

**Tests:** _(empty — retipagem de specs e2e existentes sem mudança de comportamento; as suítes e2e são revalidadas nos Acceptance criteria e Deliverables)_

**Dependencies:** SI-2 — a config final de ESLint precisa estar ativa para saber quais erros resolver

**Acceptance criteria:**

- Nenhum arquivo em `test/` contém `as any` ou `(x as any).<membro>`
- `docker compose exec nestjs-api npx eslint "test/**/*.ts" --no-fix` reporta 0 problemas
- `docker compose exec nestjs-api npm run test:e2e` passa (comportamento preservado)

---

### SI-6 — Retipar specs de vídeo e workers com createMock

**Description:** Eliminar as factories `function makeX(): any` e os `QueryFailedError ... as any` dos três specs mais pesados (vídeo + workers), usando `createMock<T>()`.

**Technical actions:**

1. `src/videos/videos.service.spec.ts` — substituir `makeVideoRepository` / `makeChannelsService` / `makeStorageService` / `makeBoss` por `createMock<T>()` de `@golevelup/ts-jest`; remover os casts `as ChannelsService` / `as StorageService` (per `nestjs-lint-strictness/TD-05`)
2. `src/videos/videos.service.spec.ts` — substituir `makeUniqueSlugError` (`new QueryFailedError(...) as any` + mutação) por um objeto de erro tipado compatível com o guard de `src/common/database/postgres-error.ts` (per `nestjs-lint-strictness/TD-03`)
3. `src/worker/video-processing.worker.spec.ts` — mesma troca para `createMock<T>()` + erros tipados (per `nestjs-lint-strictness/TD-05`)
4. `src/worker/abandoned-upload-cleanup.worker.spec.ts` — idem (per `nestjs-lint-strictness/TD-05`)
5. Nos três arquivos: resolver `require-await`, `no-unused-vars` e `no-unsafe-*` remanescentes; `unbound-method` agora é resolvido por `jest/unbound-method` (per `nestjs-lint-strictness/TD-04`)

**Tests:** _(empty — retipagem sem mudança de comportamento; as próprias suítes são revalidadas — ver Acceptance criteria + Deliverables)_

**Dependencies:** SI-1 (`@golevelup/ts-jest`), SI-2 (config ESLint), SI-3 (`strict`), SI-4 (guard de erro Postgres usado no spec de vídeo)

**Acceptance criteria:**

- `src/videos/videos.service.spec.ts`, `src/worker/video-processing.worker.spec.ts` e `src/worker/abandoned-upload-cleanup.worker.spec.ts` não contêm `: any`, `as any` nem `function make*(): any`
- `docker compose exec nestjs-api npx eslint src/videos/videos.service.spec.ts src/worker/video-processing.worker.spec.ts src/worker/abandoned-upload-cleanup.worker.spec.ts --no-fix` reporta 0 problemas
- `docker compose exec nestjs-api npm test -- videos.service.spec video-processing.worker.spec abandoned-upload-cleanup.worker.spec` passa sem alteração nas assertivas de comportamento

---

### SI-7 — Retipar specs de auth, channels e mail com createMock

**Description:** Mesmo tratamento de `createMock<T>()` e erros tipados para os specs de auth (unit + integration), channels e mail.

**Technical actions:**

1. `src/auth/auth.service.spec.ts` — substituir factories `any` por `createMock<T>()`; remover casts de serviço (per `nestjs-lint-strictness/TD-05`)
2. `src/auth/auth.service.integration-spec.ts` — remover os `any` remanescentes (tipar `moduleRef.get`, spies) (per `nestjs-lint-strictness/TD-05`, `TD-06`)
3. `src/channels/channels.service.spec.ts` — `createMock<T>()` para o `EntityManager` / `DataSource` mockado; erro de colisão de nickname tipado compatível com o guard (per `nestjs-lint-strictness/TD-05`, `TD-03`)
4. `src/mail/mail.service.integration-spec.ts` — remover `any` (tipar cliente Mailpit / respostas) (per `nestjs-lint-strictness/TD-05`)
5. Nos quatro arquivos: resolver `require-await` / `no-unused-vars` / `no-unsafe-*` remanescentes (per `nestjs-lint-strictness/TD-04`, `TD-01`)

**Tests:** _(empty — retipagem sem mudança de comportamento; suítes revalidadas nos Acceptance criteria + Deliverables)_

**Dependencies:** SI-1, SI-2, SI-3, SI-4 (guard usado no spec de channels)

**Acceptance criteria:**

- `src/auth/auth.service.spec.ts`, `src/auth/auth.service.integration-spec.ts`, `src/channels/channels.service.spec.ts` e `src/mail/mail.service.integration-spec.ts` não contêm `: any` nem `as any`
- `docker compose exec nestjs-api npx eslint src/auth/auth.service.spec.ts src/auth/auth.service.integration-spec.ts src/channels/channels.service.spec.ts src/mail/mail.service.integration-spec.ts --no-fix` reporta 0 problemas
- `docker compose exec nestjs-api npm test -- auth.service channels.service` e `npm run test:integration -- mail.service` passam

---

### SI-8 — Retipar specs de filters, config, users e helper de test data

**Description:** Fechar os arquivos de teste restantes (filters, validação de env, users integration e o helper `create-test-data-source.ts`).

**Technical actions:**

1. `src/common/filters/domain-exception.filter.spec.ts` e `src/common/filters/validation-exception.filter.spec.ts` — `createMock<ArgumentsHost>()` / `createMock<ExecutionContext>()` no lugar dos mocks `any` (per `nestjs-lint-strictness/TD-05`)
2. `src/config/env.validation.integration-spec.ts` — remover os 2 `any` (tipar entrada/saída da validação) (per `nestjs-lint-strictness/TD-01`)
3. `src/users/users.service.integration-spec.ts` — remover o `any` remanescente (per `nestjs-lint-strictness/TD-01`)
4. `src/test/create-test-data-source.ts` — remover o `any` (tipar o array de entities / opções do `DataSource`) (per `nestjs-lint-strictness/TD-01`)
5. Resolver `no-unsafe-function-type` (bare `Function`) e demais resíduos nesses arquivos (per `nestjs-lint-strictness/TD-01`)

**Tests:** _(empty — retipagem sem mudança de comportamento; suítes revalidadas nos Acceptance criteria + Deliverables)_

**Dependencies:** SI-1, SI-2, SI-3

**Acceptance criteria:**

- Nenhum dos cinco arquivos contém `: any`, `as any` ou o tipo `Function` cru
- `docker compose exec nestjs-api npx eslint src/common/filters/domain-exception.filter.spec.ts src/common/filters/validation-exception.filter.spec.ts src/config/env.validation.integration-spec.ts src/users/users.service.integration-spec.ts src/test/create-test-data-source.ts --no-fix` reporta 0 problemas
- As suítes de filters, env-validation e users-integration continuam verdes

---

### SI-9 — Finalização: script lint:ci, hook de pre-push e verificação completa

**Description:** Adicionar a barreira de regressão local (script sem `--fix` + hook opcional) e confirmar que lint, type-check e a suíte completa estão verdes de ponta a ponta.

**Technical actions:**

1. `nestjs-project/package.json`: adicionar script `lint:ci` = `eslint "{src,apps,libs,test}/**/*.ts"` (sem `--fix`); documentá-lo em `nestjs-project/CLAUDE.md` § Commands (per `nestjs-lint-strictness/TD-07`)
2. Adicionar hook opcional de pre-push (husky) rodando `npm run lint:ci` + `npx tsc --noEmit` no `nestjs-project/` (per `nestjs-lint-strictness/TD-07`)
3. Rodar `docker compose exec nestjs-api npm run lint` e confirmar 0 problemas (0 errors, 0 warnings)
4. Rodar `docker compose exec nestjs-api npx tsc --noEmit` e confirmar exit 0
5. Rodar a suíte completa: `docker compose exec nestjs-api npm test -- --runInBand` e `docker compose exec nestjs-api npm run test:e2e` — confirmar verde

**Tests:** _(empty — verificação/finalização; nenhum novo artefato testável)_

**Dependencies:** SI-2, SI-3, SI-4, SI-5, SI-6, SI-7, SI-8

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint` sai com código 0 e reporta `0 problems`
- `docker compose exec nestjs-api npx tsc --noEmit` sai com código 0
- `nestjs-project/package.json` tem o script `lint:ci` sem a flag `--fix`
- `docker compose exec nestjs-api npm test -- --runInBand` e `npm run test:e2e` passam integralmente
- `grep -rn "eslint-disable\|@ts-ignore\|@ts-nocheck\|: any\|as any" src test` (excluindo comentários legítimos) não retorna ocorrências de supressão

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-1 (root) — instalar dev dependencies
└── SI-2 — depends on SI-1 (eslint-plugin-jest instalado)
    └── SI-5 — depends on SI-2 (config final de ESLint ativa)

SI-3 (root) — tsconfig strict + entities
└── SI-4 — depends on SI-3 (strict → catch é unknown)

SI-6 — depends on SI-1, SI-2, SI-3, SI-4 (specs de vídeo + workers)
SI-7 — depends on SI-1, SI-2, SI-3, SI-4 (specs de auth + channels + mail)
SI-8 — depends on SI-1, SI-2, SI-3 (specs de filters + config + users + helper)

SI-9 — depends on SI-2, SI-3, SI-4, SI-5, SI-6, SI-7, SI-8 (verificação final: lint 0, tsc 0, suíte verde)
```

Ordem de execução sugerida: SI-1 → SI-3 (roots, paralelizáveis) → SI-2, SI-4 → SI-5, SI-6, SI-7, SI-8 → SI-9.

---

## Deliverables

- [ ] SI-1 — Instalar dev dependencies de lint e mocking
- [ ] SI-2 — Reconfigurar ESLint: strictTypeChecked + bloco de testes com eslint-plugin-jest
- [ ] SI-3 — Ativar `strict` no tsconfig + definite-assignment assertions nas entities
- [ ] SI-4 — Type guard de erro do Postgres + eliminação de `any` no código de produção
- [ ] SI-5 — test/contracts + tipagem de response body nos e2e
- [ ] SI-6 — Retipar specs de vídeo e workers com createMock
- [ ] SI-7 — Retipar specs de auth, channels e mail com createMock
- [ ] SI-8 — Retipar specs de filters, config, users e helper de test data
- [ ] SI-9 — Finalização: script lint:ci, hook de pre-push e verificação completa

**Full test suites:**

- [ ] Lint limpo (`docker compose exec nestjs-api npm run lint` — sai com código 0, `0 problems`)
- [ ] Type-check limpo (`docker compose exec nestjs-api npx tsc --noEmit` — sai com código 0)
- [ ] Testes unit + integration passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes e2e passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Nenhuma supressão de lint por configuração ou comentário (`no-explicit-any` / `no-unsafe-*` / `no-floating-promises` em `error`; zero `eslint-disable` / `@ts-ignore`)
