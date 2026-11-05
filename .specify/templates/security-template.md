# Security Standard

<!--
  Produced by /speckit-start (Security step) and amended via
  /speckit-update-standards. REQUIRED for EVERY project, including backend-only
  ones. This is an enforceable standard: its existence is gated, and its
  content is checked for conformance by /speckit-comply and the pull-time
  review.

  NON-NEGOTIABLE (constitution article VIII): never write real credentials in
  this file. Reference secrets by the NAME of the environment variable or
  secret-store key only (e.g. `DATABASE_URL`, `kv://prod/api-key`).
-->

**Project**: [PROJECT NAME]
**Established**: [DATE]
**Last amended**: [DATE]

## 1. Authentication

- **Mechanism**: [e.g. OAuth2 / OIDC provider, session cookies, API keys, mTLS]
- **Identity source**: [e.g. Entra ID, Auth0, in-house]
- **Session/token policy**: [lifetime, refresh, revocation]
- **MFA**: [required for which roles / flows]

## 2. Authorization & Access Control

- **Model**: [RBAC / ABAC / ownership-based]
- **Roles & permissions**: [list the roles and what each may do]
- **Default posture**: deny-by-default; least privilege
- **Enforcement points**: [where authz is checked — middleware, gateway, service]

## 3. Data Protection

- **In transit**: [TLS version floor, HSTS, cert management]
- **At rest**: [encryption for DB / object storage / backups]
- **PII / sensitive data**: [what is collected, classification, retention, deletion]
- **Data residency**: [regions / compliance constraints, if any]

## 4. Secrets Management

- **Source of truth**: environment variables and/or a secret store
  (e.g. Azure Key Vault). NEVER hardcoded. Local dev values live only in
  `.env` (gitignored) with placeholders in `.env.example`.
- **Variables in use**: [list variable NAMES only, never values]
  - `EXAMPLE_API_KEY` — [what it is for]
  - `DATABASE_URL` — [what it is for]
- **Rotation policy**: [cadence; who rotates; how]

## 5. Input Handling & Common Vulnerabilities

- **Validation**: [where/how untrusted input is validated & encoded]
- **Injection**: [parameterized queries / ORM; no string-built SQL/commands]
- **Output encoding / XSS**: [templating auto-escape, CSP]
- **CSRF / SSRF / file upload**: [protections in place]

## 6. Dependency & Supply-Chain Posture

- **Dependency policy**: [pinning, lockfiles, allowed sources]
- **Vulnerability scanning**: [tooling & cadence]
- **Update cadence**: [how security patches are adopted]

## 7. Logging, Audit & Incident Response

- **Security events logged**: [authn failures, authz denials, admin actions]
- **No secrets/PII in logs**: [redaction approach]
- **Incident response**: [who to notify; rotation-on-leak per article VIII]

## 8. Threat Notes (framework-specific)

- [Threats relevant to the chosen frameworks and how they are mitigated]

## Conformance Notes

- Changes are reviewed against this standard by `/speckit-comply` and the
  pull-time review. Deviations must be justified or the standard amended via
  `/speckit-update-standards`.
