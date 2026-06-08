# Claude Instructions

## Git Workflow

- Never create new git branches. All work must be committed directly to the current branch (`main`).
- Do not run `git checkout -b`, `git switch -c`, or any command that creates a new branch.
- Do not switch branches unless explicitly instructed by the user.

## Supabase migrations

The Supabase GitHub integration auto-applies `supabase/migrations/*.sql` to the
production database on push to `main`. To keep that working:

- **Name new migrations with a 14-digit UTC timestamp prefix**:
  `YYYYMMDDHHMMSS_description.sql` (later than the integration baseline
  `20260606083233`). Never use the legacy `NNN_` numeric prefix for new
  migrations — numeric versions sort before the baseline and the integration
  refuses the push.
- Migrations are append-only and non-destructive: use `CREATE OR REPLACE`,
  `IF NOT EXISTS`, additive `ALTER`. Never edit or delete an already-applied
  migration; supersede it with a new one.
- Only real migrations go in `supabase/migrations/` (no ad-hoc/manual scripts).
  `supabase/schema.sql` is the historical baseline and is not auto-applied.
- See `supabase/migrations/README.md` for the full convention.
