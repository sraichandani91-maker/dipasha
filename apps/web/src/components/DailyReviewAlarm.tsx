import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const DISMISS_KEY = "dipasha_review_dismissed_date";
const POLL_MS = 15 * 60 * 1000;

/**
 * Section 6B.5's alarm, honestly scoped to what a web tab can actually do:
 * no OS-level foreground service (that's the Android app, not built yet —
 * see DECISIONS.md) and no WhatsApp escalation (M8). While this tab is
 * open, it polls whether there's anything to review and — if so — shows a
 * banner, fires a browser Notification once, and beeps (Web Audio,
 * generated — no audio asset to ship) until dismissed or reviewed.
 * "No open requests means no alarm" (the doc's own words) is why this
 * renders nothing at all when the count is zero.
 *
 * Known gap: most browsers won't play audio before the page has seen a
 * user gesture, so the very first alarm of a session may be silent until
 * the user clicks anything — a browser autoplay-policy limit, not
 * something a web tab can work around.
 */
export default function DailyReviewAlarm({ onReviewNow }: { onReviewNow: () => void }) {
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === todayKey());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const beepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifiedRef = useRef(false);

  async function check() {
    try {
      const res = await api.get("/requests/daily-review-check");
      if (localStorage.getItem(DISMISS_KEY) !== todayKey()) {
        localStorage.removeItem(DISMISS_KEY);
        setDismissed(false);
      }
      setPendingCount(res.count);
    } catch {
      // transient network issue — next poll will retry, never alarm on a guess
    }
  }

  useEffect(() => {
    check();
    const interval = setInterval(check, POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = !!pendingCount && pendingCount > 0 && !dismissed;

  useEffect(() => {
    if (!active) {
      if (beepIntervalRef.current) { clearInterval(beepIntervalRef.current); beepIntervalRef.current = null; }
      return;
    }
    if (!notifiedRef.current) {
      notifiedRef.current = true;
      if ("Notification" in window) {
        Notification.requestPermission()
          .then((perm) => {
            if (perm === "granted") {
              new Notification("Dipasha — daily request review", { body: `${pendingCount} customer request${pendingCount === 1 ? "" : "s"} waiting for review.` });
            }
          })
          .catch(() => {});
      }
    }
    if (!audioCtxRef.current) {
      try {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        audioCtxRef.current = new Ctx();
      } catch {
        audioCtxRef.current = null;
      }
    }
    audioCtxRef.current?.resume().catch(() => {});
    function beep() {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    }
    beep();
    beepIntervalRef.current = setInterval(beep, 2000);
    return () => {
      if (beepIntervalRef.current) { clearInterval(beepIntervalRef.current); beepIntervalRef.current = null; }
    };
  }, [active, pendingCount]);

  function snooze() {
    localStorage.setItem(DISMISS_KEY, todayKey());
    setDismissed(true);
  }

  function review() {
    if (beepIntervalRef.current) { clearInterval(beepIntervalRef.current); beepIntervalRef.current = null; }
    onReviewNow();
  }

  if (!active) return null;

  return (
    <div style={{ background: "var(--status-warn)", color: "#3a2a00", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <span><strong>Daily request review</strong> — {pendingCount} request{pendingCount === 1 ? "" : "s"} waiting.</span>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-primary" onClick={review}>Review now</button>
        <button className="btn-secondary" onClick={snooze}>Snooze until tomorrow</button>
      </div>
    </div>
  );
}
