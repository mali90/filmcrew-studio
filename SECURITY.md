# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's **[Report a vulnerability](https://github.com/mali90/filmcrew-studio/security/advisories/new)**
(Security → Advisories on the repository). We'll acknowledge your report, investigate, and coordinate a
fix and disclosure with you.

## Scope

Filmcrew Studio runs entirely on your own machine and writes a local video file — it does not host a
service or store your data. The most relevant concerns are therefore:

- **Your keys.** `FAL_KEY` and your LLM provider key live only in your local `.env` (git-ignored). Never
  commit real keys. If a key is exposed, rotate it at the provider immediately.
- **Third-party services.** Rendering calls fal.ai and planning calls your chosen LLM provider; review
  their terms for how your prompts and assets are handled.
- **Dependencies.** Vulnerabilities in npm dependencies are in scope — please report them.

## Supported versions

This is a young project; security fixes are applied to the latest release on `main`.
