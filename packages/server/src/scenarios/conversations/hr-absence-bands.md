# HR absence bands — Attendance_DB (real)

Datasource: **`Attendance_DB`** (SQLite) on workspace **HR**.

## Schema used

| Table | Columns |
| :--- | :--- |
| `attendance_day` | `emp_id`, `work_date`, `hours_worked`, `day_model`, `et_start_date`, `et_end_date` |
| `employee` | `emp_id`, `emp_name`, `dept`, `division`, `location`, … |
| `leave_applied` | leave rows (separate from hours-worked bands) |

## Business rule (person’s wording → numbers)

| Hours worked that day | Kind | Weight |
| :--- | :--- | :--- |
| `0` … `4.74` | full-day absence | **1** |
| `4.75` … `9.49` | half-day absence | **0.5** |
| `≥ 9.5` | present (full day worked) | **0** |

Max working day = **9.5** hours.

Per employee return:

- `half_day_absences` — **count** of days in the half band (or sum of 0.5 weights — say which in the goal)
- `full_day_absences` — **count** of days in the full band
- `total_absences` — sum of day-weights = `1×full_count + 0.5×half_count`

⚠ A two-arm rule `hours ≥ 4.75 → 0.5 else 1` is **wrong**: it scores a 9.5h present day as half-day absence. Need a third arm (or upper bound) so `≥ 9.5 → 0`.

## Reference SQL (oracle shape)

```sql
SELECT
  e.emp_id,
  e.emp_name,
  SUM(CASE WHEN a.hours_worked >= 4.75 AND a.hours_worked < 9.5 THEN 1 ELSE 0 END) AS half_day_absences,
  SUM(CASE WHEN a.hours_worked >= 0 AND a.hours_worked < 4.75 THEN 1 ELSE 0 END) AS full_day_absences,
  SUM(
    CASE
      WHEN a.hours_worked >= 4.75 AND a.hours_worked < 9.5 THEN 0.5
      WHEN a.hours_worked < 4.75 THEN 1
      ELSE 0
    END
  ) AS total_absences
FROM main.attendance_day AS a
JOIN main.employee AS e ON e.emp_id = a.emp_id
GROUP BY e.emp_id, e.emp_name
ORDER BY e.emp_id;
```

## Corpus

`hr-absence-bands-corpus.json` — A01–A06 (absence bands) plus simple (S01–S03) and complex
branch/math/loop cases (C01–C04). Run with Kestra reachable (macOS needs in-net):

```bash
# Host path fails complete builds with ECONNREFUSED :8080 — use this:
./scripts/harness-in-net.sh packages/server/src/scenarios/builder-replay.ts \
  --corpus=conversations/hr-absence-bands-corpus.json \
  --intent-ir \
  --out=/repo/plan/builder-rewrite/hr-absence-intent-ir-p8.json

# Subset:
./scripts/harness-in-net.sh packages/server/src/scenarios/builder-replay.ts \
  --corpus=conversations/hr-absence-bands-corpus.json \
  --only=RW-HR-A03,RW-HR-A05 --intent-ir
```

| Id | Shape |
| :--- | :--- |
| A01–A06 | Three-band absence (half / full / present) |
| S01–S03 | Simple list / filter / avg hours |
| C01 | Branch on total absences → email vs list |
| C02 | Loop: email each employee with ≥2 full-day absences |
| C03 | Dept math (absences / headcount) + branch |
| C04 | Friday schedule + last week + loop email |

Statuses to read carefully:

| Status | Meaning |
| :--- | :--- |
| `complete` | Builder finished + Kestra accepted the revision |
| `asks` / `incomplete` / `cannot` | Builder verdict (no Kestra required) |
| `infra_kestra` | Hit Kestra from a process that cannot reach it — **not** a builder defect |
