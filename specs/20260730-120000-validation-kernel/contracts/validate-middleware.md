# Contract: `validate()` Middleware

**Module**: `packages/server/src/validation/middleware.ts`
**Exported by**: `packages/server/src/validation/index.ts`

---

## Interface

```typescript
import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

interface ValidateOptions {
  params?: ZodSchema;
  query?: ZodSchema;
  body?: ZodSchema;
}

export function validate(opts: ValidateOptions): RequestHandler;
```

## Behaviour

- Each provided schema is parsed against the corresponding request segment using `.parse()`.
- A validation failure throws a `ZodError`, which propagates synchronously and is caught by Express, forwarding to the error middleware.
- The middleware replaces the parsed value on the request object so downstream handlers receive the Zod-coerced type.
- Omitted segments are not validated and not modified.
- The middleware is stateless; the same factory result can be reused across routes.

## Usage Pattern

```typescript
// routes/workspaces.ts
import { validate, workspaceParamsSchema, updateWorkspaceSchema } from "../validation/index.js";

workspacesRouter.patch(
  "/:workspaceId",
  validate({ params: workspaceParamsSchema, body: updateWorkspaceSchema }),
  asyncHandler(async (req, res) => {
    // req.params.workspaceId is guaranteed UUID here
    // req.body matches UpdateWorkspaceInput
    const result = await workspaceService.update(req.params.workspaceId, req.body);
    res.json({ workspace: result });
  }),
);
```

## Error Output

On failure, the ZodError reaches `errorHandler` which returns:
```json
{
  "error": "validation_error",
  "issues": [
    {
      "path": ["params", "workspaceId"],
      "code": "invalid_string",
      "message": "Invalid uuid"
    }
  ]
}
```

HTTP status: `400`.

## Invariants

- A route with path params that does NOT pass a `params` schema to `validate()` is a
  defect. This is detectable by grep:
  ```bash
  # Should return zero hits after V1 is complete:
  grep -r 'req\.params\.' packages/server/src/routes/ | grep -v 'validate('
  ```
- A route that calls `.parse(req.body)` directly (bypassing `validate()`) is also a
  defect:
  ```bash
  grep -r '\.parse(req\.' packages/server/src/routes/
  ```
