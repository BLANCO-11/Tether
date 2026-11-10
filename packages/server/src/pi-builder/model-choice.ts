/**
 * Which model a chat's Forge runs with (0135): the person's choice, limited to the models an admin turned on for the
 * builder (`resolveGenerationProvider`). A choice the admin has since turned off falls back to the builder's default,
 * and that to the server's own fallback. Names are compared without a `provider/` prefix, as Pi is given them.
 *
 * Pure: the service reads the admin's list and passes it in.
 */
export type Generation = { model: string; allowedModels: string[] };

export function bareModel(m: string): string {
  return m.trim().replace(/^.*\//, "");
}

/** The line the chat shows after the model changes: the raw id, without a provider prefix. */
export function modelNote(model: string): string {
  return `Now using ${bareModel(model)}.`;
}

/** The model a chat runs with: its own while allowed (an empty list allows any), else the default, else the fallback. */
export function effectiveModel(chosen: string | null, gen: Generation | null, fallback: string): string {
  const allowed = (gen?.allowedModels ?? []).map(bareModel);
  if (chosen && chosen.trim() && (allowed.length === 0 || allowed.includes(bareModel(chosen)))) return bareModel(chosen);
  return bareModel(gen?.model?.trim() ? gen.model : fallback);
}

/** The models a chat may choose from: the enabled ones, or the default alone when none are listed. */
export function modelChoices(gen: Generation | null, fallback: string): string[] {
  const list = [...new Set((gen?.allowedModels ?? []).map(bareModel).filter(Boolean))];
  if (list.length > 0) return list;
  const one = bareModel(gen?.model || fallback);
  return one ? [one] : [];
}
