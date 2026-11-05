/**
 * Curated declared-call packs (plans/declared-api-calls-2026-10-29, phase 2): sets of declared calls Foundry ships as
 * DATA for a piece whose own actions miss something. A person with `plugins.enable` switches a pack on for a connection;
 * each call becomes an ordinary tool. Nothing here is logic keyed to a service — a pack is only declarations, checked
 * by the same rules as one a person writes, and enforced by the connector like any other.
 *
 * ⚠ A test runs every call in every pack through the connector's own `checkDeclaration` and a sample build, so a pack
 * cannot ship a call the connector would refuse.
 */
import type { DeclaredCall } from "./declared-call.js";

export type DeclaredCallPack = {
  key: string;
  piece: string;
  displayName: string;
  description: string;
  /** What the connection's credential must allow, said before anyone switches it on. */
  needs: string;
  calls: DeclaredCall[];
};

const project = { name: "project", in: "path", type: "string", required: true, description: "The project's name or id." } as const;
const repository = { name: "repository", in: "path", type: "string", required: true, description: "The repository's name or id." } as const;
const API = { "api-version": "7.1" };
const branch = (description: string) => ({ name: "branch", in: "query", key: "versionDescriptor.version", type: "string", required: false, description }) as const;
const pullRequestId = { name: "pull_request_id", in: "path", type: "number", required: true, description: "The pull request's number." } as const;
/** Git's "no object": a ref whose old value is this does not exist yet. */
const NO_OBJECT = "0000000000000000000000000000000000000000";
const REPO = "/{project}/_apis/git/repositories/{repository}";

export const DECLARED_CALL_PACKS: DeclaredCallPack[] = [
  {
    key: "azure-repos",
    piece: "@activepieces/piece-azure-devops",
    displayName: "Azure Repos",
    description:
      "Everyday Git work: read repositories, branches, commits, files and pull requests; create a branch, commit a file, open and comment on a pull request. Nothing here deletes or merges.",
    needs: "The connection's personal access token needs Code (Read) — and Code (Read & write) to create branches, commit, and open or comment on pull requests.",
    calls: [
      {
        name: "list_repositories",
        displayName: "List repositories",
        description: "Every Git repository in a project, with its id, name, default branch and web address.",
        method: "GET",
        path: "/{project}/_apis/git/repositories",
        query: API,
        params: [project],
        returns: "json",
      },
      {
        name: "list_files",
        displayName: "List files in a folder",
        description: "The files and folders directly inside one folder of a branch (the repository's default branch when none is given).",
        method: "GET",
        path: `${REPO}/items`,
        query: { ...API, recursionLevel: "OneLevel" },
        params: [
          project,
          repository,
          { name: "folder", in: "query", key: "scopePath", type: "string", required: false, description: "The folder, e.g. /src. The repository's root when empty." },
          branch("The branch's name, e.g. main. The default branch when empty."),
        ],
        returns: "json",
      },
      {
        name: "get_file",
        displayName: "Read a file",
        description: "One file's content from a branch (the default branch when none is given), as text in the answer's content field.",
        method: "GET",
        path: `${REPO}/items`,
        query: { ...API, includeContent: "true", $format: "json" },
        params: [
          project,
          repository,
          { name: "file_path", in: "query", key: "path", type: "string", required: true, description: "The file's path, e.g. /README.md." },
          branch("The branch's name, e.g. main. The default branch when empty."),
        ],
        returns: "json",
      },
      {
        name: "list_branches",
        displayName: "List branches",
        description: "Every branch in a repository, each with its full name (refs/heads/…) and the id of the commit it points at.",
        method: "GET",
        path: `${REPO}/refs`,
        query: { ...API, filter: "heads/" },
        params: [project, repository],
        returns: "json",
      },
      {
        name: "list_commits",
        displayName: "List commits",
        description: "Recent commits on a branch, newest first, with their id, author, date and message.",
        method: "GET",
        path: `${REPO}/commits`,
        query: API,
        params: [
          project,
          repository,
          { name: "branch", in: "query", key: "searchCriteria.itemVersion.version", type: "string", required: false, description: "The branch's name, e.g. main. The default branch when empty." },
          { name: "author", in: "query", key: "searchCriteria.author", type: "string", required: false, description: "Only commits by this author (name or email)." },
          { name: "top", in: "query", key: "searchCriteria.$top", type: "number", required: false, description: "At most this many." },
        ],
        returns: "json",
      },
      {
        name: "get_commit",
        displayName: "Read a commit",
        description: "One commit: its author, date, message, parents and the files it changed.",
        method: "GET",
        path: `${REPO}/commits/{commit_id}`,
        query: { ...API, changeCount: "100" },
        params: [project, repository, { name: "commit_id", in: "path", type: "string", required: true, description: "The commit's id." }],
        returns: "json",
      },
      {
        name: "compare_branches",
        displayName: "Compare two branches",
        description: "How far apart two branches are (commits ahead and behind) and which files differ.",
        method: "GET",
        path: `${REPO}/diffs/commits`,
        query: { ...API, baseVersionType: "branch", targetVersionType: "branch" },
        params: [
          project,
          repository,
          { name: "base_branch", in: "query", key: "baseVersion", type: "string", required: true, description: "The branch to compare against, e.g. main." },
          { name: "target_branch", in: "query", key: "targetVersion", type: "string", required: true, description: "The branch with the changes, e.g. feature/x." },
        ],
        returns: "json",
      },
      {
        name: "list_pull_requests",
        displayName: "List pull requests",
        description: "Pull requests in a repository, newest first, with their title, author, status and branches.",
        method: "GET",
        path: `${REPO}/pullrequests`,
        query: API,
        params: [
          project,
          repository,
          { name: "status", in: "query", key: "searchCriteria.status", type: "string", required: false, description: "active, completed, abandoned or all. Active when empty." },
          { name: "top", in: "query", key: "$top", type: "number", required: false, description: "At most this many." },
        ],
        returns: "json",
      },
      {
        name: "get_pull_request",
        displayName: "Read a pull request",
        description: "One pull request: its title, description, status, branches, reviewers and their votes.",
        method: "GET",
        path: `${REPO}/pullrequests/{pull_request_id}`,
        query: API,
        params: [project, repository, pullRequestId],
        returns: "json",
      },
      {
        name: "create_branch",
        displayName: "Create a branch",
        description: "Creates a new branch at a commit (take the commit from List branches or List commits). Fails if the branch already exists.",
        method: "POST",
        path: `${REPO}/refs`,
        query: API,
        body: { "[0].oldObjectId": NO_OBJECT },
        params: [
          project,
          repository,
          { name: "new_branch", in: "body" as const, key: "[0].name", type: "string" as const, required: true, description: "The new branch, as refs/heads/<name>." },
          { name: "from_commit", in: "body" as const, key: "[0].newObjectId", type: "string" as const, required: true, description: "The id of the commit the branch starts at." },
        ],
        returns: "json",
      },
      ...(["add", "edit"] as const).map((change) => ({
        name: change === "add" ? "commit_new_file" : "commit_file_change",
        displayName: change === "add" ? "Commit a new file" : "Commit a change to a file",
        description:
          change === "add"
            ? "Pushes one commit that adds a file to a branch. The branch's current commit id is needed (List branches), so a push never overwrites work it did not see."
            : "Pushes one commit that replaces an existing file's content on a branch. The branch's current commit id is needed (List branches), so a push never overwrites work it did not see.",
        method: "POST" as const,
        path: `${REPO}/pushes`,
        query: API,
        body: { "commits[0].changes[0].changeType": change, "commits[0].changes[0].newContent.contentType": "rawtext" },
        params: [
          project,
          repository,
          { name: "branch", in: "body" as const, key: "refUpdates[0].name", type: "string" as const, required: true, description: "The branch to commit to, as refs/heads/<name>." },
          { name: "branch_commit", in: "body" as const, key: "refUpdates[0].oldObjectId", type: "string" as const, required: true, description: "The id of the commit the branch points at now." },
          { name: "message", in: "body" as const, key: "commits[0].comment", type: "string" as const, required: true, description: "The commit message." },
          { name: "file_path", in: "body" as const, key: "commits[0].changes[0].item.path", type: "string" as const, required: true, description: "The file's path, e.g. /docs/notes.md." },
          { name: "content", in: "body" as const, key: "commits[0].changes[0].newContent.content", type: "string" as const, required: true, description: "The file's whole new content, as text." },
        ],
        returns: "json" as const,
      })),
      {
        name: "create_pull_request",
        displayName: "Open a pull request",
        description: "Opens a pull request from one branch into another.",
        method: "POST",
        path: `${REPO}/pullrequests`,
        query: API,
        params: [
          project,
          repository,
          { name: "source_branch", in: "body", key: "sourceRefName", type: "string", required: true, description: "The branch with the changes, as refs/heads/<name>." },
          { name: "target_branch", in: "body", key: "targetRefName", type: "string", required: true, description: "The branch to merge into, as refs/heads/<name>." },
          { name: "title", in: "body", type: "string", required: true, description: "The pull request's title." },
          { name: "description", in: "body", type: "string", required: false, description: "What it changes and why." },
        ],
        returns: "json",
      },
      {
        name: "comment_on_pull_request",
        displayName: "Comment on a pull request",
        description: "Adds a comment to a pull request, as a new conversation.",
        method: "POST",
        path: `${REPO}/pullrequests/{pull_request_id}/threads`,
        query: API,
        body: { status: "active", "comments[0].commentType": 1, "comments[0].parentCommentId": 0 },
        params: [project, repository, pullRequestId, { name: "comment", in: "body" as const, key: "comments[0].content", type: "string" as const, required: true, description: "The comment's text (Markdown)." }],
        returns: "json",
      },
    ],
  },
];

export const packsFor = (piece: string) => DECLARED_CALL_PACKS.filter((p) => p.piece === piece);
