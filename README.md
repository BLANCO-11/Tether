# Introduction 
TODO: Give a short introduction of your project. Let this section explain the objectives or the motivation behind this project. 

# Getting Started
TODO: Guide users through getting your code up and running on their own system. In this section you can talk about:
1.	Installation process
2.	Software dependencies
3.	Latest releases
4.	API references

# Build and Test
TODO: Describe and show how to build your code and run the tests. 

# Contribute
TODO: Explain how other users and developers can contribute to make your code better. 

If you want to learn more about creating good readme files then refer the following [guidelines](https://docs.microsoft.com/en-us/azure/devops/repos/git/create-a-readme?view=azure-devops). You can also seek inspiration from the below readme files:
- [ASP.NET Core](https://github.com/aspnet/Home)
- [Visual Studio Code](https://github.com/Microsoft/vscode)
- [Chakra Core](https://github.com/Microsoft/ChakraCore)
# Spec-Kit Starter Template

A starter template for **enforced spec-driven development** with
[GitHub spec-kit](https://github.com/github/spec-kit) and AI coding agents.
Every source change must flow through the spec-kit workflow
(specify → plan → tasks → implement); hooks, a pre-commit gate, and an Azure
DevOps pipeline enforce it.

## What's inside

| Piece | Purpose |
|-------|---------|
| `.specify/` | spec-kit core: templates, scripts, memory (constitution), git extension |
| `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.gemini/commands/` | spec-kit commands for Claude Code, Codex CLI, Cursor and Gemini CLI - including two custom ones: **`/speckit-backfill`** (retro-fit specs onto manual changes) and **`/speckit-comply`** (code-vs-constitution compliance report) |
| `scripts/spec-gate-core.sh` + per-agent hook adapters | Layer 1: deny source writes without an active, complete feature |
| `.githooks/pre-commit` | Layer 2: block non-compliant commits from ANY agent or human |
| `ci/check-spec-compliance.sh` + `azure-pipelines.yml` | Layer 3: authoritative PR gate |
| `ci/spec-policy.sh` | The single policy source (branch regex, allowlist) all layers share |
| `ci/secret-policy.sh` + `ci/check-secrets.sh` + `.githooks/pre-push` | Secret protection: agents blocked from hardcoding keys, commits/pushes/PRs scanned for `.env` files and credential patterns (no hotfix exemption) |
| `.specify/memory/constitution.md` | Starter constitution (7 articles, spec-first is NON-NEGOTIABLE) |
| `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `.cursor/rules/` | Agent instructions pointing at the canonical team rules |
| `docs/TEAM-WORKFLOW.md` | Multi-developer workflow, hotfix policy, onboarding, ADO setup |

Feature branches and spec directories use **timestamp numbering**
(`20260710-153001-user-auth`), so parallel developers never collide.

## Start a new project from this template

```bash
# 1. Copy the template (or use your git host's "use as template")
git clone <this-repo> my-project && cd my-project
rm -rf .git && git init -b main

# 2. Bootstrap (verifies tools, installs the git hooks path, wires agent hooks)
./setup.sh

# 3. Commit the baseline and push to your Azure DevOps repo
git add -A && git commit -m "chore: bootstrap from spec-kit starter template"
git remote add origin <ado-repo-url> && git push -u origin main

# 4. (Admin, once) Set up the ADO branch policy - see docs/TEAM-WORKFLOW.md

# 5. Start your agent and establish the project's standards (REQUIRED first)
claude        # or codex / cursor / gemini
/speckit-start
```

`/speckit-start` interviews you to establish four enforceable standards —
**Constitution, Frameworks, Security, and Design** (the last only if your
project has a UI) — before any feature code. Until they exist, the pre-write
hook blocks source changes. Change a standard later with
`/speckit-update-standards`. See [docs/STANDARDS.md](docs/STANDARDS.md).

Then build features with `/speckit-specify` → `/speckit-plan` →
`/speckit-tasks` → `/speckit-implement` → `/speckit-comply`.

## For each developer joining an existing project

```bash
git clone <repo> && cd <repo>
./setup.sh
```

See [docs/TEAM-WORKFLOW.md](docs/TEAM-WORKFLOW.md) for everything else.
