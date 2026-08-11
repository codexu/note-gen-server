create table if not exists support_diagnostic_grants (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references support_cases(id) on delete restrict,
  account_id uuid references accounts(id) on delete set null,
  scope_version text not null,
  snapshot_ciphertext text not null,
  snapshot_key_id text not null,
  snapshot_encryption_version integer not null default 1,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  check (length(scope_version) > 0),
  check (snapshot_encryption_version > 0)
);

create index if not exists support_diagnostic_grants_case_idx
  on support_diagnostic_grants(case_id, expires_at);
create index if not exists support_diagnostic_grants_account_idx
  on support_diagnostic_grants(account_id, expires_at);
