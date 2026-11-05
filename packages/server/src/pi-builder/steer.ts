/**
 * Whether a message can be pushed into a running Forge turn (2026-11-03). Pure: the service passes what it knows and
 * gets back the sentence to show the person, or null when the message can go in now.
 */
export function steerRefusal(st: { running: boolean; testing: boolean; compacting: boolean; forgeBusy: boolean }): string | null {
  if (st.compacting) return "Forge is making room in this conversation. Send your message again in a moment.";
  if (st.testing) return "Forge is testing the workflow now. Your message will wait until the test finishes.";
  if (!st.running) return "Forge is not working on a message right now. Send it as a new message.";
  if (!st.forgeBusy) return "Forge is checking its work now. Your message will wait until it finishes.";
  return null;
}
