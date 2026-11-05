# Data Model: Builder Delta Intelligence

No new tables. All slices operate on existing structures with narrowed semantics:

## Band partition (derived, not stored)

- **Entity**: Contiguous intervals from stated boundaries + inferred present floor.
- **Fields**: boundaries (number[], ascending), floor (number | inferred), arms (BandArm[] with test/value/then/words).
- **Validation**: `bandArmsConsistent` (ordering coherence, stated-precision tolerance); `bandEmitProves` (structure over vocabulary).
- **State transition**: under-determined (boundaries < weights − 1) → one bounded unclear question; contradictory → refuse with reason; else pinned arms.

## Settled words (existing `settledWords`, frozen见到)

- **Entity**: Quotes the head revision placed — sources/sinks/values/bands/groupings with their placements.
- **Fields**: quote (string), placement (spec path), revision (number), structureHash (string).
- **Validation**: exact-norm match only for settled membership; fuzzy (`sameWords`) excluded.
- **State transition**: settled → (correction touches it) → delta → (rebuilt) → settled. Explicit, never drift.

## Delta (derived per rebuild)

- **Entity**: Goal words minus settled quotes.
- **Fields**: words (string[]), anchors (content keys for `unclearHoleId` / `partQuestion`).
- **Validation**: single settled-membership choke point at question emission; settled-anchored emission rejected in code.
- **State transition**: computed fresh per rebuild from head revision + new message.

## Drafted default (new provenance value, existing slot)

- **Entity**: Model-proposed slot value awaiting confirmation.
- **Fields**: value (string), provenance (`"drafted"`), slot (port id), quote (goal excerpt it derives from).
- **Validation**: confirm gate; reject → open ask; accept → value with drafted provenance recorded.
- **State transition**: drafted → (confirm) → placed | (reject) → asked.

## Patch (existing `carryOut`, scoped)

- **Entity**: Single-step edit applied in place.
- **Fields**: touchedStep (id), change (slot/value), pinnedRevision, pinnedHash.
- **Validation**: slot-fit check + hash match; mismatch → whole rebuild fallback.
- **State transition**: proposed → (hash ok) → applied | (hash stale) → rebuild.
