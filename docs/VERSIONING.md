# Foundry release versioning

Scheme: one release line, `release/beta`, with annotated tags per release.
Tag `beta-1.0.0` is the immutable base; `release/beta` advances from it.

- **Release line**: all beta work lands on `release/beta` (direct commits for
  grouped patches; short-lived `fix/*` branches only for risky or multi-day
  work, merged and deleted). No per-patch branches — they multiply and rot.
- **Patch (`Z`)**: grouped fixes only. A patch ships **multiple fixes** — never
  one or two lone changes. Group related issues, land them together on the
  release line, then tag (`beta-1.0.1`, `beta-1.0.2`, …).
- **Critical exception**: a critical fix (data loss, security, total outage)
  may ship alone as a patch without waiting for a group.
- **Minor (`Y`)**: a major change of functionality resets `Z`
  (`beta-1.1.0`). No breaking migrations without a minor bump.
- Every release is a commit naming the version first, e.g.
  `beta-1.0.1: chat reliability batch (outputFields coercion, servable models, …)`,
  with an annotated tag on it: `git tag -a beta-1.0.1 -m "beta-1.0.1: …"`.
- **Pushing**: one command for the branch, one for the tags — the branch push
  never carries tags with it:
  `git push origin release/beta`
  `git push origin tag beta-1.0.1 beta-1.0.2 …`
  Name every new tag explicitly. `git push --tags` is banned: it pushes all
  local tags, including moved or stale ones. A branch push with no tag push
  leaves the remote with untagged commits — exactly how `.16`–`.19` went up
  tagless.
- **No untagged commits**: every commit on the release line is versioned —
  its subject names the version first (`beta-1.0.1: …`) and it carries an
  annotated tag. There is no "tiny chore rides the next patch" class; a
  commit without its own tag is an error, fixed by amending it into a
  versioned release before the next commit lands.
- Fix lists live in the release spec under `specs/`; the version file is this
  document, updated when the scheme changes — never per release.
