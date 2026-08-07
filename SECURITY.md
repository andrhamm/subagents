# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). Do not open a public issue for
anything exploitable.

## Scope worth knowing about

The delegate executes model-chosen tool calls against a filesystem. The
security-relevant boundaries, in order of interest:

- **Path confinement** — every read resolves through `safePath` (realpath),
  every write through `safeWritePath` (deepest-existing-ancestor realpath).
  An escape from the configured root through either is a vulnerability.
- **Worktree isolation** — write profiles run in a git worktree detached at
  HEAD; the caller's working tree must be unreachable from the delegate.
- **Command execution** — the model never authors command text. `checks`
  commands are caller-authored config; `run_checks` takes zero arguments.
  Any path by which model output becomes an executed command is a
  vulnerability.

Reports demonstrating a breach of any of these get priority.

## Supported versions

Pre-1.0: only the latest release is supported.
