# Claude Instructions

## Git Workflow

- Never create new git branches. All work must be committed directly to the current branch (`main`).
- Do not run `git checkout -b`, `git switch -c`, or any command that creates a new branch.
- Do not switch branches unless explicitly instructed by the user.

## Supabase migrations

Migrations are applied to production by **`.github/workflows/db-migrate.yml`**,
which runs `supabase db push` on every push to `main` that touches
`supabase/migrations/**`. Two GitHub repository secrets must exist:

- `SUPABASE_ACCESS_TOKEN` — personal access token from supabase.com → Account → Access tokens
- `SUPABASE_DB_PASSWORD` — from the Supabase dashboard → Settings → Database

To keep the workflow working:

- **Name new migrations with a 14-digit UTC timestamp prefix**:
  `YYYYMMDDHHMMSS_description.sql`. Never use the legacy `NNN_` numeric prefix.
- Migrations are append-only and non-destructive: use `CREATE OR REPLACE`,
  `IF NOT EXISTS`, additive `ALTER`. Never edit or delete an already-applied
  migration; supersede it with a new one.
- Only real migrations go in `supabase/migrations/` (no ad-hoc/manual scripts).
  `supabase/schema.sql` is the historical baseline and is not auto-applied.
- See `supabase/migrations/README.md` for the full convention.
