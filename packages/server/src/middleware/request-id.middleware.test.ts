import { describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { requestId } from "./request-id.middleware.js";

describe("requestId middleware", () => {
  it("sets req.id and echoes X-Request-Id on the response, server-generated only", async () => {
    const app = express();
    app.use(requestId);
    app.get("/probe", (req, res) => {
      res.json({ id: req.id });
    });

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // A caller-supplied X-Request-Id must be ignored — the id is always
      // server-generated (research.md Decision 6).
      const res = await fetch(`${base}/probe`, {
        headers: { "X-Request-Id": "caller-supplied-value" },
      });
      const body = (await res.json()) as { id: string };
      const header = res.headers.get("x-request-id");

      expect(header).toBeTruthy();
      expect(header).not.toBe("caller-supplied-value");
      expect(body.id).toBe(header);
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("assigns a distinct id to each request", async () => {
    const app = express();
    app.use(requestId);
    app.get("/probe", (req, res) => res.json({ id: req.id }));

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const [a, b] = await Promise.all([
        fetch(`${base}/probe`).then((r) => r.json() as Promise<{ id: string }>),
        fetch(`${base}/probe`).then((r) => r.json() as Promise<{ id: string }>),
      ]);
      expect(a.id).not.toBe(b.id);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
