import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

interface AlarmConfig {
  timeLocal: string; // "HH:MM"
  repeatMinutes: number;
  maxSnoozes: number;
  escalationMinutes: number;
}

const CHECK_MS = 60 * 1000;

function loadDayState() {
  const date = todayKey();
  if (localStorage.getItem("dipasha_review_date") !== date) {
    localStorage.setItem("dipasha_review_date", date);
    localStorage.removeItem("dipasha_review_snoozes");
    localStorage.removeItem("dipasha_review_snoozed_until");
    localStorage.removeItem("dipasha_review_first_fired");
  }
  return {
    snoozes: Number(localStorage.getItem("dipasha_review_snoozes") ?? 0),
    snoozedUntil: Number(localStorage.getItem("dipasha_review_snoozed_until") ?? 0),
    firstFired: Number(localStorage.getItem("dipasha_review_first_fired") ?? 0),
  };
}

function fireTimeToday(timeLocal: string): number {
  const [h, m] = timeLocal.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 18, m ?? 0, 0, 0);
  return d.getTime();
}

/**
 * Section 6B.5's alarm, on the doc's own configured numbers (seeded in M1
 * as daily_request_review_time_local/repeat_minutes/max_snoozes/
 * escalation_minutes, unused until this pass) — honestly scoped to what a
 * web tab can do: no OS foreground service (Android app, not built) and
 * no real WhatsApp escalation (M8). It fires once local clock time passes
 * the configured hour and something is genuinely pending; snoozing re-
 * rings after repeat_minutes and is capped at max_snoozes, after which
 * only "Review now" remains; past escalation_minutes unresolved it turns
 * red as a visible stand-in for the WhatsApp ping this build can't send
 * yet. Zero pending means no banner at all — never trains staff to
 * dismiss it out of habit.
 *
 * Known gap: most browsers won't play audio before the page has seen a
 * user gesture, so the first alarm of a session can be silent until the
 * user clicks anything — a browser autoplay-policy limit, not fixable
 * from inside a web tab.
 */
export default function DailyReviewAlarm({ onReviewNow }: { onReviewNow: () => void }) {
  const [config, setConfig] = useState<AlarmConfig | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [, setTick] = useState(0); // forces re-evaluation every CHECK_MS / snooze click
  const audioCtxRef = useRef<AudioContext | null>(null);
  const beepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifiedDateRef = useRef<string | null>(null);

  useEffect(() => {
    api.get("/requests/daily-review-alarm-config").then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    async function check() {
      try {
        const res = await api.get("/requests/daily-review-check");
        setPendingCount(res.count);
      } catch {
        // transient network issue — next check will retry, never alarm on a guess
      }
      setTick((t) => t + 1);
    }
    check();
    const interval = setInterval(check, CHECK_MS);
    return () => clearInterval(interval);
  }, []);

  // Every value the render decision needs is computed up front, with safe
  // fallbacks, so the hooks below always run in the same order regardless
  // of whether config/pendingCount have loaded yet (Rules of Hooks — no
  // hook may live after an early `return`).
  const now = Date.now();
  const day = loadDayState();
  const ready = !!config && pendingCount !== null && pendingCount > 0;
  const pastFireTime = ready && now >= fireTimeToday(config!.timeLocal);
  const snoozing = pastFireTime && now < day.snoozedUntil;
  const alarmVisible = pastFireTime && !snoozing;
  const escalated = alarmVisible && now - (day.firstFired || now) >= (config?.escalationMinutes ?? 90) * 60 * 1000;
  const snoozesLeft = config ? Math.max(0, config.maxSnoozes - day.snoozes) : 0;

  useEffect(() => {
    if (alarmVisible && !day.firstFired) {
      localStorage.setItem("dipasha_review_first_fired", String(now));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alarmVisible]);

  useAlarmSound(alarmVisible, pendingCount ?? 0, audioCtxRef, beepIntervalRef, notifiedDateRef);

  if (!alarmVisible) return null;

  function snooze() {
    if (snoozesLeft <= 0 || !config) return;
    localStorage.setItem("dipasha_review_snoozes", String(day.snoozes + 1));
    localStorage.setItem("dipasha_review_snoozed_until", String(now + config.repeatMinutes * 60 * 1000));
    setTick((t) => t + 1);
  }

  function review() {
    if (beepIntervalRef.current) { clearInterval(beepIntervalRef.current); beepIntervalRef.current = null; }
    onReviewNow();
  }

  return (
    <div
      style={{
        background: escalated ? "var(--status-bad)" : "var(--status-warn)",
        color: escalated ? "#fff" : "#3a2a00",
        padding: "10px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      <span>
        <strong>Daily request review</strong> — {pendingCount} request{pendingCount === 1 ? "" : "s"} waiting.
        {escalated && " Overdue — would have notified the owner by WhatsApp (not wired up until M8)."}
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-primary" onClick={review}>Review now</button>
        {snoozesLeft > 0 ? (
          <button className="btn-secondary" onClick={snooze}>Snooze {config!.repeatMinutes}m ({snoozesLeft} left)</button>
        ) : (
          <span style={{ fontSize: 12, alignSelf: "center" }}>No snoozes left today</span>
        )}
      </div>
    </div>
  );
}

function useAlarmSound(
  active: boolean,
  pendingCount: number,
  audioCtxRef: React.MutableRefObject<AudioContext | null>,
  beepIntervalRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>,
  notifiedDateRef: React.MutableRefObject<string | null>
) {
  useEffect(() => {
    if (!active) {
      if (beepIntervalRef.current) { clearInterval(beepIntervalRef.current); beepIntervalRef.current = null; }
      return;
    }
    const today = todayKey();
    if (notifiedDateRef.current !== today) {
      notifiedDateRef.current = today;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
