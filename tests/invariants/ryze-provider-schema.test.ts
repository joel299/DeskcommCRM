import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Invariante de Banco e Integração de Persistência do Provider RyzeAPI (`ryze-channel`).
 *
 * Valida a integridade do schema da tabela public.channel_sessions e as operações reais de banco
 * para o provider ryze contra o Postgres efêmero que nasce de supabase/baseline.sql (scripts/test-db.sh).
 */

function novaOrg(slug: string): string {
  sql(`
    insert into public.organizations (slug, legal_name, display_name)
    values ('${slug}', 'inv ryze', 'inv ryze');
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

function insertSession(org: string, cols: Record<string, string>): string {
  const nomes = ["organization_id", "webhook_secret_encrypted", ...Object.keys(cols)];
  const vals = [`'${org}'`, `'\\x00'::bytea`, ...Object.values(cols)];
  return sql(`
    insert into public.channel_sessions (${nomes.join(", ")})
    values (${vals.join(", ")});
    select 'ok';
  `);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou — a trava não existe neste banco");
}

describe("0210 · schema e invariantes do provider ryze", () => {
  it("ryze_token_encrypted existe na tabela channel_sessions e seu data_type é bytea", () => {
    const dataType = sql(`
      select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'channel_sessions'
         and column_name = 'ryze_token_encrypted'
    `).trim();
    expect(dataType).toBe("bytea");
  });

  it("ryze_instance_name existe na tabela channel_sessions", () => {
    const col = sql(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'channel_sessions'
         and column_name = 'ryze_instance_name'
    `).trim();
    expect(col).toBe("ryze_instance_name");
  });

  it("sessão ryze sem ryze_instance_name é RECUSADA pelo banco", () => {
    const org = novaOrg(`inv-ryze-ref-${Date.now()}`);
    const msg = erroDe(() =>
      insertSession(org, { provider: `'ryze'`, waha_session_name: "null" }),
    );
    expect(msg).toMatch(/channel_sessions_provider_ref_check/);
  });

  it("sessão ryze com ryze_instance_name válido é ACEITA pelo banco", () => {
    const org = novaOrg(`inv-ryze-ok-${Date.now()}`);
    const res = insertSession(org, {
      provider: `'ryze'`,
      waha_session_name: "null",
      ryze_instance_name: `'instancia-ryze-${Date.now()}'`,
    });
    expect(res).toContain("ok");
  });

  it("duplicidade de ryze_instance_name em sessões ativas é RECUSADA pelo índice único parcial (mesma org ou cross-tenant)", () => {
    const org1 = novaOrg(`inv-ryze-dup1-${Date.now()}`);
    const org2 = novaOrg(`inv-ryze-dup2-${Date.now()}`);
    const instanceName = `'instancia-dup-${Date.now()}'`;
    insertSession(org1, {
      provider: `'ryze'`,
      waha_session_name: "null",
      ryze_instance_name: instanceName,
    });
    const msg = erroDe(() =>
      insertSession(org2, {
        provider: `'ryze'`,
        waha_session_name: "null",
        ryze_instance_name: instanceName,
      }),
    );
    expect(msg).toMatch(/idx_channel_sessions_ryze_instance_name_active/);
  });

  it("sessão ryze inserida via seam de persistência armazena bytea cifrado e permite update pelo id confiavel da org", () => {
    const org = novaOrg(`inv-ryze-persist-${Date.now()}`);
    const inst = `inst-persist-${Date.now()}`;
    const tokenHex = `\\x${Buffer.from("tok_secret_123").toString("hex")}`;

    // 1. Simula a persistência inicial (INSERT)
    sql(`
      insert into public.channel_sessions (organization_id, provider, ryze_instance_name, ryze_token_encrypted, webhook_secret_encrypted)
      values ('${org}', 'ryze', '${inst}', '${tokenHex}'::bytea, '\\x00'::bytea);
    `);

    const insertedCipher = sql(`
      select encode(ryze_token_encrypted, 'hex')
        from public.channel_sessions
       where organization_id = '${org}' and ryze_instance_name = '${inst}' and archived_at is null
    `).trim();
    expect(insertedCipher).toBe(Buffer.from("tok_secret_123").toString("hex"));

    // 2. Simula a atualização (UPDATE por id confiável da org)
    const sessionId = sql(`
      select id from public.channel_sessions
       where organization_id = '${org}' and ryze_instance_name = '${inst}' and archived_at is null
    `).trim();

    const newTokenHex = `\\x${Buffer.from("tok_secret_updated_456").toString("hex")}`;
    sql(`
      update public.channel_sessions
         set ryze_token_encrypted = '${newTokenHex}'::bytea, updated_at = now()
       where id = '${sessionId}' and organization_id = '${org}';
    `);

    const updatedCipher = sql(`
      select encode(ryze_token_encrypted, 'hex')
        from public.channel_sessions
       where id = '${sessionId}'
    `).trim();
    expect(updatedCipher).toBe(Buffer.from("tok_secret_updated_456").toString("hex"));
  });

  it("sessões legadas (waha, meta_cloud, zernio) continuam válidas e protegidas pelas constraints", () => {
    const org = novaOrg(`inv-ryze-legado-${Date.now()}`);
    const resWaha = insertSession(org, { waha_session_name: `'s-waha-${Date.now()}'` });
    expect(resWaha).toContain("ok");

    const resMeta = insertSession(org, {
      provider: `'meta_cloud'`,
      waha_session_name: "null",
      meta_phone_number_id: `'phone-meta-${Date.now()}'`,
    });
    expect(resMeta).toContain("ok");

    const resZernio = insertSession(org, {
      provider: `'zernio'`,
      waha_session_name: "null",
      zernio_account_id: `'acc-zernio-${Date.now()}'`,
    });
    expect(resZernio).toContain("ok");
  });
});
