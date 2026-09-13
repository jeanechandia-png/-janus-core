# JANUS Security Rules

## Repository boundary

This repository contains code and public-safe architecture only.

Never commit:

- API tokens, OAuth refresh tokens, passwords or session cookies;
- personal medical, housing, financial or family records;
- private conversation exports;
- production SQLite databases or WAL/SHM files;
- `.env` files;
- Apple/Google/GitHub/Vercel/Hostinger credentials;
- private voice master recordings unless explicitly approved and stored in an appropriate private asset store.

## Secret storage

On a local Janus host, secrets belong in the OS secure credential store (for example macOS Keychain) or another dedicated secret store. SQLite stores references/metadata, never raw long-lived secrets.

## Tool execution

Every external action must have:

1. an explicit tool/action identity;
2. a risk classification;
3. an idempotency key where applicable;
4. an auditable event trail;
5. approval before high-risk or irreversible actions;
6. revalidation before executing queued offline actions after reconnection.

## Observable execution

The UI may expose tool names, targets, progress, results and changed artifacts. It must not expose private model chain-of-thought, hidden prompts, tokens or secrets.

## Current repository visibility

As of 2026-09-13 the GitHub repository is public. Treat that as a hard constraint until visibility is changed. No sensitive Janus state may be added while it remains public.
