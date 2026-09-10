# Tasks: Provider RyzeAPI (`ryze-channel`)

## Task Matrix & Implementation Roadmap

- [x] **Task 0: Baseline & Scope Lock (F0)**
  - Requisito: RYZE-001, RYZE-019
  - Arquivos: `.specs/features/ryze-channel/context-manifest.json`
  - Verificação: `pnpm typecheck`, `pnpm lint:channels`, `pnpm lint:role-rank`, `pnpm test:unit`
  - Status: COMPLETO (Gate F0 aprovado no Linear issue GRU-31 / DESKCOMM-00)

- [x] **Task 1: SDD + Contrato (F1)**
  - Requisito: RYZE-001 até RYZE-020
  - Arquivos: `.specs/features/ryze-channel/spec.md`, `design.md`, `tasks.md`
  - Mapeamento requisito → teste: Requisitos definidos no spec.md, mapeados no design.md e desacoplados por fase em tasks.md.
  - Hipóteses confirmadas: `POST /api/v1/webhooks/channel/[token]` como rota neutra única; expurgo P0 de `instanceData.token` e bloqueio de SSRF em `instanceData.baseUrl`.
  - Verificação: Mapeamento completo de contratos e premissas CONFIRMED vs INFERRED.
  - Status: COMPLETO (Documentação entregue e pronta para gate F1)

- [ ] **Task 2: Vocabulário + Schema + Invariantes (F2)**
  - Requisito: RYZE-001, RYZE-003, RYZE-004
  - Arquivos: `lib/channels/types.ts`, `lib/channels/capabilities.ts`, `lib/channels/session-ref.ts`, `lib/channels/templates-fonte.ts`, `lib/channels/index.ts`, `scripts/lint-channels.pattern.ts`, `supabase/migrations/20260910180000_0210_canal_ryze_vocabulario.sql`
  - Verificação: `pnpm test:unit`, `pnpm test:db`, `pnpm lint:channels`

- [ ] **Task 3: Adapter Outbound (F3)**
  - Requisito: RYZE-002, RYZE-005, RYZE-006, RYZE-014
  - Arquivos: `lib/channels/adapters/ryze.ts`, `lib/channels/ryze/credentials.ts`, `lib/channels/index.ts`
  - Verificação: Testes RED/GREEN para envio de texto, mídia, reply e tratamento de erros sem vazamento de tokens.

- [ ] **Task 4: Inbound + Sanitização P0 + Idempotência (F4)**
  - Requisito: RYZE-007, RYZE-008, RYZE-009, RYZE-010, RYZE-011, RYZE-012, RYZE-013
  - Arquivos: `lib/channels/ryze/webhook.ts`, `lib/channels/ryze/envelope.ts`, `lib/channels/ryze/ingest.ts`, `lib/channels/inbound.ts`, `app/api/v1/webhooks/channel/[token]/route.ts`
  - Verificação: Testes RED/GREEN para validação de Bearer, expurgo de `instanceData.token` e gate de direção.

- [ ] **Task 5: E2E + Regressão de Provedores (F5)**
  - Requisito: RYZE-015, RYZE-018
  - Arquivos: `tests/e2e/*ryze*`, `tests/invariants/*`
  - Verificação: `pnpm gov:verify`, `pnpm test:db`, `pnpm test:e2e`, `pnpm build`

- [ ] **Task 6: Shadow Real Controlado (F6)**
  - Requisito: RYZE-016, RYZE-017
  - Verificação: Teste real de webhook shadow, envio outbound e read-back no banco sem exposição de credenciais.

- [ ] **Task 7: Release Candidate & PR (F7)**
  - Requisito: RYZE-019, RYZE-020
  - Verificação: CI verde no GitHub e aprovação do PR.

- [ ] **Task 8: Cutover + Smoke Test (F8)**
  - Requisito: RYZE-020
  - Verificação: Habilitação em staging/produção, smoke test e plano de rollback pronto.
