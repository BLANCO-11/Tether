// src/components/ui/icons.tsx — inline SVG icons used across the Foundry pages.
// All use currentColor so color comes from the parent. `s` sets the pixel size.
type P = { className?: string; s?: number };

// Shared <svg> wrapper: stroke style, sizing, currentColor.
function S({ children, className, s = 16 }: P & { children: React.ReactNode }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {children}
    </svg>
  );
}

// Brand / generic
export const Cube = (p: P) => <S {...p}><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" /><path d="M3 7l9 5 9-5M12 12v10" /></S>;
export const Sparkle = (p: P) => <S {...p}><path d="M12 3v6m0 6v6m9-9h-6m-6 0H3m13.5-6.5-4 4m-3 3-4 4m0-11 4 4m3 3 4 4" /></S>;
export const Link = (p: P) => <S {...p}><path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1m-2 2-1 1a4 4 0 0 1-6-6l1-1" /></S>;
export const Activity = (p: P) => <S {...p}><path d="M3 12h4l2 6 4-14 2 8h6" /></S>;

// Sidebar nav
export const Home = (p: P) => <S {...p}><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></S>;
export const Apps = (p: P) => <S {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></S>;
export const Wrench = (p: P) => <S {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2.1-2.1Z" /></S>;
export const Bolt = (p: P) => <S {...p}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></S>;
export const Key = (p: P) => <S {...p}><circle cx="8" cy="8" r="4" /><path d="M11 11l9 9m-4-4 2-2m-4 0 2-2" /></S>;
export const Box = (p: P) => <S {...p}><path d="M3 7l9-4 9 4v10l-9 4-9-4V7Z" /><path d="M3 7l9 4 9-4M12 11v10" /></S>;
// Premium Lucide set for sidebar — consistent 16px stroke 1.75 per spec
export const Workflow = (p: P) => <S {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="8" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M10 6.5h4M10 17.5h4M6.5 10v4M17.5 11.5v4" /></S>;
export const Zap = (p: P) => <S {...p}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></S>;
export const CheckCheck = (p: P) => <S {...p}><path d="M20 6 9 17l-5-5" /><path d="M15 6 4 17l-5-5" transform="translate(7 0)" /></S>;

// Actions / controls
export const Search = (p: P) => <S {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></S>;
export const Plus = (p: P) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
export const Minus = (p: P) => <S {...p}><path d="M5 12h14" /></S>;
// Canvas toolbar (ui-upgrade Phase 5.2). `Frame` is fit-to-view: the graph
// brought back inside the box, which is what the F shortcut does.
export const Frame = (p: P) => <S {...p}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /></S>;
export const Expand = (p: P) => <S {...p}><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5" /></S>;
export const Collapse = (p: P) => <S {...p}><path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5" /></S>;
export const Eye = (p: P) => <S {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></S>;
export const Check = (p: P) => <S {...p}><path d="M20 6 9 17l-5-5" /></S>;
export const ChevronDown = (p: P) => <S {...p}><path d="m6 9 6 6 6-6" /></S>;
export const ChevronUp = (p: P) => <S {...p}><path d="m18 15-6-6-6 6" /></S>;
export const ChevronRight = (p: P) => <S {...p}><path d="m9 6 6 6-6 6" /></S>;
export const ChevronLeft = (p: P) => <S {...p}><path d="m15 6-6 6 6 6" /></S>;
export const Play = (p: P) => <S {...p}><path d="M6 4l14 8-14 8V4Z" /></S>;
export const Alert = (p: P) => <S {...p}><path d="M12 8v5m0 3h.01" /><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0Z" /></S>;
// The activity bell. ⚠ Its badge means "there is news", never "there is a
// problem" — see `components/shell/NotificationBell.tsx`, where a failed poll
// deliberately outranks the count.
export const Speaker = (p: P) => <S {...p}><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a10 10 0 0 1 0 14" /></S>;
export const SpeakerOff = (p: P) => <S {...p}><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m22 9-6 6" /><path d="m16 9 6 6" /></S>;
export const Bell = (p: P) => <S {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></S>;

// Row actions
export const Dots = (p: P) => <S {...p}><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></S>;
export const Pencil = (p: P) => <S {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></S>;
export const Trash = (p: P) => <S {...p}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7" /></S>;
export const Close = (p: P) => <S {...p}><path d="M18 6 6 18M6 6l12 12" /></S>;
export const Copy = (p: P) => <S {...p}><rect x="9" y="9" width="12" height="12" rx="1.5" /><path d="M6 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V6" /></S>;
export const Split = (p: P) => <S {...p}><path d="M12 3v5" /><path d="M12 8c0 4-6 3-6 8v5" /><path d="M12 8c0 4 6 3 6 8v5" /></S>;
export const Gauge = (p: P) => <S {...p}><path d="M12 14l3.5-3.5" /><path d="M20.2 15.5a9 9 0 1 0-16.4 0" /></S>;
export const Building = (p: P) => <S {...p}><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 7h2m2 0h2M9 11h2m2 0h2M9 15h2m2 0h2M12 21v-3" /></S>;
/** A conditional guard — one path in, one guarded path out. Phase 3. */
export const Fork = (p: P) => <S {...p}><path d="M6 3v6a3 3 0 0 0 3 3h9" /><path d="M15 9l3 3-3 3" /><path d="M6 12v9" /></S>;
/**
 * Where the arms come back together — deliberately the MIRROR of `Fork`, which
 * is the icon for the condition that opened them. Two paths in, one out. A
 * reader should be able to see the pair on a canvas and know they belong to each
 * other without reading either label.
 */
export const Merge = (p: P) => <S {...p}><path d="M6 3v6a3 3 0 0 0 3 3h9" /><path d="M6 21v-6a3 3 0 0 1 3-3" /><path d="M15 9l3 3-3 3" /></S>;
export const Bot = (p: P) => <S {...p}><rect x="5" y="9" width="14" height="10" rx="2" /><path d="M12 9V6m-3.5 7h.01M15.5 13h.01M9.5 16h5" /><circle cx="12" cy="5" r="1" /></S>;
export const Menu = (p: P) => <S {...p}><path d="M3 6h18M3 12h18M3 18h18" /></S>;

// Data sources / tables
export const Database = (p: P) => <S {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></S>;
export const Table = (p: P) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16M15 4v16" /></S>;

// Trigger kinds
export const Chat = (p: P) => <S {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12Z" /></S>;
export const Mail = (p: P) => <S {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></S>;
export const Clock = (p: P) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></S>;
export const Sun = (p: P) => <S {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></S>;
// The theme control's pair. `Sun` above already existed; `Moon` is new, and the
// toggle draws whichever names the theme it would switch TO — a sun on a button
// that turns the lights off is the ambiguity that makes a toggle unreadable.
// See components/shell/ThemeToggle.tsx.
export const Moon = (p: P) => <S {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></S>;
export const Stream = (p: P) => <S {...p}><path d="M4 6h16M4 12h16M4 18h16" /></S>;
export const Queue = (p: P) => <S {...p}><path d="M4 4h16v12H5.2L4 20V4Z" /></S>;
export const Download = (p: P) => <S {...p}><path d="M12 3v12m0 0-4-4m4 4 4-4" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></S>;
export const Upload = (p: P) => <S {...p}><path d="M12 15V3m0 0-4 4m4-4 4 4" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></S>;

// Identity / status glyphs
export const LogOut = (p: P) => <S {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></S>;
export const User = (p: P) => <S {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></S>;
export const Code = (p: P) => <S {...p}><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" /></S>;
export const Folder = (p: P) => <S {...p}><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z" /></S>;
export const Shield = (p: P) => <S {...p}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" /></S>;
export const Image = (p: P) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m3 17 5-4 4 3 3-3 6 5" /></S>;
export const Info = (p: P) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></S>;
export const CircleSlash = (p: P) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></S>;
/** A task the platform emitted rather than one anybody wrote. */
export const Cog = (p: P) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1m0-14.2-2.1 2.1m-10 10-2.1 2.1" /></S>;
// A ring with a gap — spin it with `className="animate-spin"` for an in-progress marker.
export const Spinner = (p: P) => <S {...p}><path d="M21 12a9 9 0 1 1-6.2-8.6" /></S>;
/** Re-lay-out — the "re-arrange" affordance (plan Phase 2, D-150(e)). */
export const RefreshCw = (p: P) => <S {...p}><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" /></S>;
/** Paper plane — the chat send button. Own element (not `S`) because it draws
    at strokeWidth 2, and a shared wrapper that silently re-strokes it is how
    an icon set drifts into five almost-identical planes. */
export const Send = ({ s = 14 }: P) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 2L11 13" />
    <path d="M22 2L15 22L11 13L2 9L22 2Z" />
  </svg>
);
export const Paperclip = (p: P) => <S {...p}><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" /></S>;
export const FileDoc = (p: P) => <S {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></S>;
