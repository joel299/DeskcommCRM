# Tasks: Provider RyzeAPI (`ryze-channel`)

## Task Matrix & Implementation Roadmap

- [x] **Task 0: Baseline & Scope Lock (F0)**
  - Requisito: RYZE-001, RYZE-019
  - Arquivos: `.specs/features/ryze-channel/context-manifest.json`
  - Verificação: `pnpm typecheck`, `pnpm lint:channels`, `pnpm lint:role-rank`, `pnpm test:unit`
  - Status: COMPLETO (Gate F0 aprovado no Linear issue GRU-31 / DESKCOMM-01)

- [x] **Task 1: SDD + Contrato (F1)**
  - Requisito: RYZE-001 até RYZE-020
  - Arquivos: `.specs/features/ryze-channel/spec.md`, `design.md`, `tasks.md`, `docs/implementation/ryze/*`
  - Mapeamento requisito → teste: Requisitos definidos no spec.md, mapeados no design.md e desacoplados por fase em tasks.md.
  - Hipóteses confirmadas: `POST /api/v1/webhooks/channel/[token]` como rota neutra única; expurgo P0 de `instanceData.token` e bloqueio de SSRF em `instanceData.baseUrl`.
  - Verificação: Mapeamento completo de contratos e premissas CONFIRMED vs INFERRED.
  - Status: COMPLETO (Gate F1 aprovado no Linear issue GRU-32 / DESKCOMM-02)

- [x] **Task 2: Vocabulário + Schema + Invariantes (F2)**
  - Requisito: RYZE-001, RYZE-003, RYZE-004
  - Arquivos: `lib/channels/types.ts`, `lib/channels/capabilities.ts`, `lib/channels/session-ref.ts`, `lib/channels/templates-fonte.ts`, `lib/channels/index.ts`, `scripts/lint-channels.pattern.ts`, `supabase/migrations/20260910180000_0210_canal_ryze_vocabulario.sql`, `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`, `tests/unit/canal-ryze-vocabulario.test.ts`, `tests/invariants/ryze-provider-schema.test.ts`
  - Verificação: `pnpm typecheck`, `pnpm lint:channels`, `pnpm lint:role-rank`, `pnpm test:db` (PASS 6/6), `tests/invariants/ryze-provider-schema.test.ts`
  - Status: COMPLETO (Gate F2 aprovado no Linear issue GRU-33 / DESKCOMM-03)

- [x] **Task 3: Adapter Outbound (F3)**
  - Requisito: RYZE-002, RYZE-005, RYZE-006, RYZE-014
  - Arquivos: `lib/channels/adapters/ryze.ts`, `lib/channels/ryze/credentials.ts`, `lib/channels/ryze/control-plane.ts`, `lib/channels/index.ts`, `tests/unit/canal-ryze-outbound.test.ts`, `tests/invariants/ryze-provider-schema.test.ts`, `.specs/features/ryze-channel/tasks.md`
  - Verificação: `pnpm typecheck`, `pnpm lint:channels`, `pnpm lint:role-rank`, `pnpm vitest run tests/unit/canal-ryze-outbound.test.ts tests/unit/canal-ryze-vocabulario.test.ts tests/unit/channel-capability-matrix.test.ts` (PASS 30/30), `bash scripts/test-db.sh tests/invariants/ryze-provider-schema.test.ts` (PASS 7/7), incluindo contract-test dedicado de `POST /api/instance/new` com método, URL, header TokenAccount, body `{name}`, resposta non-JSON fail-closed, persistência real pelo seam `persistRyzeSession`, recuperação pós-falha por LIST e zero CREATE no retry.
  - Fontes de contrato: `https://docs.ryzeapi.cloud/pt/api/instance/create.md`, `https://docs.ryzeapi.cloud/pt/api/instance/list.md`, `https://docs.ryzeapi.cloud/pt/guide/authentication.md`
  - Status: COMPLETO (implementação e correções do gate F3 concluídas; GRU-34 aprovada e marcada Done)

- [ ] **Task 4: Inbound + Sanitização P0 + Idempotência (F4)**
  - Requisito: RYZE-007, RYZE-008, RYZE-009, RYZE-010, RYZE-011, RYZE-012, RYZE-013
  - Arquivos: `lib/channels/ryze/webhook.ts`, `lib/channels/ryze/envelope.ts`, `lib/channels/ryze/ingest.ts`, `lib/channels/inbound.ts`, `lib/channels/arquivo-de-webhook.ts`, `app/api/v1/webhooks/channel/[token]/route.ts`, `supabase/migrations/20260910220000_0211_ryze_webhook_log.sql`, `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`, `.specs/features/ryze-channel/context-manifest.json`, `tests/unit/ryze-f4-contract.test.ts`, `tests/unit/contrato-do-webhook-zernio.test.ts`, `tests/unit/ryze-webhook-archive.test.ts`, `tests/unit/ryze-webhook-route.test.ts`, `tests/unit/ryze-inbound-real.test.ts`, `tests/invariants/ryze-provider-schema.test.ts`, `.specs/features/ryze-channel/fixtures/message-status.redacted.json`, `supabase/migrations/20260910233000_0212_ryze_event_idempotency.sql`
  - Verificação: `pnpm typecheck`, lint direcionado, contrato F4 + regressão Zernio + rota + arquivamento + inbound real (41/41 nessa camada), suíte consolidada F4/Ryze 69/69, invariantes Postgres Ryze 9/9, baseline INSTALL/UPDATE e `git diff --check`.
  - Claim/reclaim: RPC transacional com `claim_token` e fencing na finalização; testes cobrem concorrência de dois workers e falha de finalização.
  - Contrato `message.status`: fixture sanitizada em `.specs/features/ryze-channel/fixtures/message-status.redacted.json`, derivada do envelope comunitário público documentado pelo review externo; valores de instância, mensagem e entrega foram redigidos e o wire é tratado como contrato pendente de confirmação oficial antes de produção. `lib/channels/ryze/ingest.ts` processa `incoming`, reconcilia `outgoing` sem inserir e atualiza `message.status` sem criar mensagem; dedupe persistente usa estado recuperável `processing|processed|failed` com lease; efeitos pós-entrada são recuperáveis no caminho duplicate.
  - Testes adicionais: `tests/unit/channel-ingest-ryze.test.ts` cobre incoming, duplicate 23505 com recuperação, dedupe por `data.id`, outgoing sem regressão, status sem insert e identidade sem fallback em `to`; `tests/unit/ryze-webhook-archive.test.ts` prova sanitização antes do arquivamento; `tests/unit/ryze-webhook-route.test.ts` cobre o mapeamento HTTP; `tests/unit/ryze-inbound-real.test.ts` atravessa parser/Bearer/handler reais; fixture sanitizada fixa o wire de `message.status`.
  - Correções do checkpoint: sanitização root/nested de `instanceData`, comprimento mínimo do Bearer, eventos não suportados respondem `200 ignored`, chaves de evento/mensagem/status separadas e governança reconciliada para GRU-35.
  - Status: IMPLEMENTAÇÃO F4 CONCLUÍDA; aprovação externa permanece necessária antes de mover a issue para Done.

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
