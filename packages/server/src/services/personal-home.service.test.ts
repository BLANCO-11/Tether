import { beforeEach, describe, expect, it, vi } from "vitest";

const selectLimit = vi.fn();
const repoList = vi.fn();
const createWs = vi.fn();
const listMembers = vi.fn();
const grant = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (...args: unknown[]) => selectLimit(...args),
        }),
      }),
    }),
  },
}));

vi.mock("../repositories/workspace.repo.js", () => ({
  workspaceRepo: { list: (...args: unknown[]) => repoList(...args) },
}));

vi.mock("./workspace.service.js", () => ({
  workspaceService: { create: (...args: unknown[]) => createWs(...args) },
}));

vi.mock("./workspace-member.service.js", () => ({
  workspaceMemberService: {
    list: (...args: unknown[]) => listMembers(...args),
    grant: (...args: unknown[]) => grant(...args),
  },
}));

const { personalHomeService } = await import("./personal-home.service.js");

describe("personalHomeService.ensureHome", () => {
  beforeEach(() => {
    selectLimit.mockReset();
    repoList.mockReset();
    createWs.mockReset();
    listMembers.mockReset();
    grant.mockReset();
  });

  it("does nothing when the person already has a membership", async () => {
    selectLimit.mockResolvedValue([{ workspaceId: "ws-1" }]);
    const id = await personalHomeService.ensureHome({ subject: "local-admin", email: "a@b.co" });
    expect(id).toBeNull();
    expect(createWs).not.toHaveBeenCalled();
  });

  it("creates Personal and grants admin when the person has no membership", async () => {
    selectLimit.mockResolvedValue([]);
    repoList.mockResolvedValue([]);
    createWs.mockResolvedValue({ id: "ws-new", name: "Personal" });
    grant.mockResolvedValue({});

    const id = await personalHomeService.ensureHome({ subject: "local-admin", email: "admin@ml.com" });
    expect(id).toBe("ws-new");
    expect(createWs).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Personal", assistant: true }),
    );
    expect(grant).toHaveBeenCalledWith(
      "ws-new",
      expect.objectContaining({ subject: "local-admin", email: "admin@ml.com", role: "admin" }),
      "admin@ml.com",
      { bySuperAdmin: true },
    );
  });

  it("grants into an existing empty Personal workspace instead of creating another", async () => {
    selectLimit.mockResolvedValue([]);
    repoList.mockResolvedValue([{ id: "ws-p", name: "Personal", kind: null }]);
    listMembers.mockResolvedValue([]);
    grant.mockResolvedValue({});

    const id = await personalHomeService.ensureHome({ subject: "u1", email: "u@x.co" });
    expect(id).toBe("ws-p");
    expect(createWs).not.toHaveBeenCalled();
    expect(grant).toHaveBeenCalledWith(
      "ws-p",
      expect.objectContaining({ subject: "u1", role: "admin" }),
      "u@x.co",
      { bySuperAdmin: true },
    );
  });
});
