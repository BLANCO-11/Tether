/**
 * Soft send and receive sounds for the builder chat (builder-stability Phase 6). Synthesised with WebAudio — no asset to load,
 * nothing fetched — and quiet: a short sine blip well under conversational volume.
 *
 * Always on. Every storage and audio call is guarded — a page that cannot play (no AudioContext, a blocked autoplay, private storage) is
 * simply silent, never an error.
 */
/** Always on (2026-10-13): the toggle was removed. Off only where the page cannot play. */
export function soundsOn(): boolean {
  return typeof window !== "undefined";
}

let ctx: AudioContext | null = null;
function blip(from: number, to: number, ms: number): void {
  if (!soundsOn()) return;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  } catch {
    /* audio unavailable: silent */
  }
}

/** A message left: a short rising note. */
export const playSend = () => blip(520, 780, 110);
/** A reply arrived: a short falling note. */
export const playReceive = () => blip(740, 494, 160);
