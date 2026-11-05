# Data Model — V6 SSRF and Egress Policy

Most of this feature is behaviour, not storage. One column is added.

## Persisted

### `datasources` — one new nullable column

| Column | Type | Notes |
|---|---|---|
| `credential_can_write` | boolean, **nullable** | R12 / FR-015–FR-016. `null` = not yet determined. |

**The nullability is the design.** Three states, not two:

| Value | Meaning | Surface |
|---|---|---|
| `null` | not determined — never checked, or the check could not run | "not checked" — never rendered as if it were read-only |
| `false` | determined read-only | stated as determined, with when |
| `true` | determined writable | stated prominently; refused for **new** registrations (spec Q2 resolution B) |

A boolean-without-null collapses "we do not know" into "it is fine", which is the
unearned signal Article XV exists to keep out. Half the value of this column is
its ability to say *nothing is known yet*.

A companion `credential_checked_at` timestamptz is included for the same reason: a
determination with no age is a determination that will be trusted long after the
credential changed.

**No migration to backfill.** Existing rows stay `null` until checked — that is
the honest value, and backfilling to `false` would assert a fact nobody
established.

## Not persisted

### Egress policy inputs

| Input | Source | Shape |
|---|---|---|
| scheme allowlist | code constant | `http`, `https` for URLs; the driver schemes for DSNs |
| reserved-address denylist | code constant | the CIDR set in research R4 |
| permitted-internal list | configuration (FR-003) | `host:port` entries, **derived by default** from `stubPublicBase`, `dbHostForScripts` and the Tether base (research R3) |

**Entries are host *and* port.** Permitting `host.docker.internal:4000` must not
permit `host.docker.internal:5432`. An exception that widens to a whole host is how
an exception list becomes a bypass.

### Egress decision

```
{ permitted: true }
| { permitted: false, reason: "bad_scheme" | "reserved_literal"
                            | "resolves_to_reserved" | "unresolvable",
    detail: string }
```

Four reasons, because the operator's next action differs for each (research R5),
and one reason for all four is the Article V failure this feature is partly fixing.

`detail` is for the operator and **must never carry the credential portion of a
connection string** (FR-014). Where the input is a DSN, `detail` names the host,
never the string.

### Address classification

Pure, no I/O — this is what makes research R4's encoding cases exhaustively
testable without a resolver:

```
classify(address) → "public" | "loopback" | "private" | "link_local"
                  | "cgnat" | "unique_local" | "unspecified"
```

Everything other than `public` is reserved and refused unless the host+port is on
the permitted-internal list.

## Type changes

### `triggers.config` — from `z.record(z.any())` to a discriminated union (D6, FR-011)

| `type` | Validated config |
|---|---|
| `poll` | `url` (scheme + egress policy checked), `intervalSeconds` bounded |
| `schedule` | `intervalMinutes` bounded |
| `webhook` | nothing the system reads |
| `manual` | nothing the system reads |

This is a **behaviour-narrowing change to an existing endpoint**. FR-021 applies:
survey the keys actually present in live rows and actually read by code
(research R6) before writing the union. A key that is stored and read must
survive; a key that is stored and unread should be *shown* unread, not assumed so.

### `EgressRefusal` on the client

Surfaced on the trigger and datasource shapes so a refused address is visible
where it was registered, rather than only in a server log. Carries the reason and
the detail, never a credential.
