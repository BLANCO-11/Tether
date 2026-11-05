/**
 * The engine (Kestra) id of a flow a PERSON made: the flow's own uuid, `f-<uuid>` — unique by construction and never derived from
 * the flow's name, which stays free text. In the shape the compiler accepts (`validateModel`: a lowercase letter first, then only
 * letters, digits and hyphens, at most 63): a bare uuid may start with a digit, and a name slug plus a suffix could mix `_` and `-`.
 */
export const engineIdOf = (flowId: string) => `f-${flowId.toLowerCase()}`;
