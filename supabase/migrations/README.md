# Supabase migrations

The Supabase **GitHub integration** automatically applies every `*.sql` file in
this folder to the production database **when commits land on `main`**. To keep
that automatic apply working, follow these rules.

## Naming — use a UTC timestamp prefix (required for new migrations)

Name every **new** migration:

```
YYYYMMDDHHMMSS_short_description.sql      e.g. 20260608191500_add_driver_flags.sql
```

The 14-digit UTC timestamp is the migration *version*. It **must be later than
the integration baseline `20260606083233`** so the runner applies it. Any real
"now" timestamp satisfies this.

> ⚠️ Do **not** use the legacy `NNN_` numeric prefix (`025_…`) for new
> migrations. Numeric versions (`25`) sort *before* the timestamp baseline, so
> the integration treats them as out-of-order and **refuses the whole push**.

Generate one with:

```bash
date -u +%Y%m%d%H%M%S      # → paste as the filename prefix
# or, if the Supabase CLI is installed:
supabase migration new short_description
```

## Append-only & non-destructive

- Never edit or delete an already-applied migration. To change an object, add a
  **new** migration that `CREATE OR REPLACE`s it or `ALTER`s additively.
- Prefer `IF NOT EXISTS` / `CREATE OR REPLACE` / additive `ALTER` so a migration
  is safe to re-run.
- No destructive statements (`delete from`, `truncate`, `drop table`) against
  tables that may hold production data.

## What lives where

- `supabase/migrations/*.sql` — the **only** files the integration applies. Put
  real migrations here, nothing else (no ad-hoc/manual scripts).
- `supabase/schema.sql` — the original Phase-1 baseline. It is **historical**:
  superseded by the integration baseline `20260606083233` and **not**
  auto-applied. Don't add new schema here.
- `001_…`–`024_…` — the legacy numeric migrations that predate the integration.
  They are already applied to the database; their versions are recorded as
  applied via a one-time `supabase migration repair` so the integration ignores
  them. Do not renumber or re-run them.

## How to ship a schema change

1. Create `supabase/migrations/<timestamp>_<desc>.sql` (timestamp > baseline).
2. Make it append-only / idempotent.
3. Commit and push to `main` → the integration applies it to production.
4. Confirm in Supabase dashboard → Database → Migrations.
