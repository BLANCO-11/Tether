import { describe, expect, it } from "vitest";
import { ENDPOINT_OUTPUT_SHAPES, outputShapeForEndpoint } from "./tool-output-shapes.js";

describe("outputShapeForEndpoint — the shape belongs to the endpoint, not the tool name (compiled-builder 2c)", () => {
  it("matches a concrete tool URL to its path template, whatever the host", () => {
    expect(outputShapeForEndpoint("http://host.docker.internal:4004/hr/employees/{id}/manager", "GET")).toBe(ENDPOINT_OUTPUT_SHAPES["GET /hr/employees/:id/manager"]);
    expect(outputShapeForEndpoint("http://ops-api:4004/hr/employees/{id}", "get")).toBe(ENDPOINT_OUTPUT_SHAPES["GET /hr/employees/:id"]);
    expect(outputShapeForEndpoint("http://localhost:4000/api/mail/send", "POST")).toBe(ENDPOINT_OUTPUT_SHAPES["POST /api/mail/send"]);
  });
  it("tells the two methods on one path apart", () => {
    expect(outputShapeForEndpoint("http://x/tickets", "GET")).toBe(ENDPOINT_OUTPUT_SHAPES["GET /tickets"]);
    expect(outputShapeForEndpoint("http://x/tickets", "POST")).toBe(ENDPOINT_OUTPUT_SHAPES["POST /tickets"]);
  });
  it("answers null for an endpoint Foundry does not serve — an external tool stays Opaque", () => {
    expect(outputShapeForEndpoint("https://httpbin.org/post", "POST")).toBeNull();
    expect(outputShapeForEndpoint("http://x/hr/employees/1/manager/extra", "GET")).toBeNull();
    expect(outputShapeForEndpoint(null, "GET")).toBeNull();
  });
});
