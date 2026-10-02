"use client";

/**
 * Guest UI: the session hook, the Nav banner, the "Try as guest" button (with
 * Cloudflare Turnstile when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set at build
 * time) and the sample-data button. Server-side rules live in src/lib/guest*.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, Loader, PlayCircle, UserRound } from "lucide-react";

type GuestStatus = { enabled: boolean; guest: { expires_at: string } | null };

let statusPromise: Promise<GuestStatus> | null = null;
function fetchGuestStatus(): Promise<GuestStatus> {
  statusPromise ??= fetch("/api/guest", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { enabled: false, guest: null }))
    .catch(() => ({ enabled: false, guest: null }));
  return statusPromise;
}

/** null while loading. */
export function useGuestStatus(): GuestStatus | null {
  const [status, setStatus] = useState<GuestStatus | null>(null);
  useEffect(() => { let live = true; fetchGuestStatus().then((s) => live && setStatus(s)); return () => { live = false; }; }, []);
  return status;
}

export function useIsGuest(): boolean {
  return useGuestStatus()?.guest != null;
}

function remaining(expiresAt: string): string {
  const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function GuestBanner() {
  const status = useGuestStatus();
  const router = useRouter();
  const [ending, setEnding] = useState(false);
  if (!status?.guest) return null;
  return (
    <div role="status" data-testid="guest-banner" className="bg-amber-500/10 border-b border-amber-500/30 px-6 py-2 text-sm text-amber-200 flex items-center justify-between gap-4 flex-wrap">
      <span className="inline-flex items-center gap-2">
        <Clock className="h-4 w-4" aria-hidden="true" />
        Guest session: everything is deleted in {remaining(status.guest.expires_at)}. Files up to 2 MB, 3 uploads.
      </span>
      <span className="flex items-center gap-3">
        <Link href="/sign-up" className="font-medium text-amber-100 underline underline-offset-2 hover:text-white">Sign up to keep your work</Link>
        <button
          type="button"
          disabled={ending}
          className="text-amber-300 hover:text-white disabled:opacity-50"
          onClick={async () => {
            setEnding(true);
            await fetch("/api/guest", { method: "DELETE" }).catch(() => {});
            statusPromise = null;
            router.push("/");
            router.refresh();
          }}
        >
          End session
        </button>
      </span>
    </div>
  );
}

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

type TurnstileApi = { render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; "expired-callback": () => void }) => string; reset: (id?: string) => void };

function useTurnstile(enabled: boolean, ref: React.RefObject<HTMLDivElement | null>) {
  const [token, setToken] = useState<string | null>(null);
  const widgetId = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !TURNSTILE_SITE_KEY || !ref.current) return;
    const el = ref.current;
    const render = () => {
      const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (!ts || widgetId.current) return;
      widgetId.current = ts.render(el, { sitekey: TURNSTILE_SITE_KEY, callback: setToken, "expired-callback": () => setToken(null) });
    };
    if ((window as unknown as { turnstile?: TurnstileApi }).turnstile) { render(); return; }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, [enabled, ref]);
  const reset = useCallback(() => {
    setToken(null);
    (window as unknown as { turnstile?: TurnstileApi }).turnstile?.reset(widgetId.current ?? undefined);
  }, []);
  return { token, reset };
}

/** "Try as guest": renders nothing when guest access is off (GUEST_COOKIE_SECRET unset). */
export function GuestStartButton({ className = "" }: { className?: string }) {
  const status = useGuestStatus();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const turnstileRequired = !!TURNSTILE_SITE_KEY;
  const turnstile = useTurnstile(status?.enabled === true && !status.guest, widgetRef);

  if (!status?.enabled) return null;
  if (status.guest) {
    return (
      <Link href="/dashboard" className={className}>
        <UserRound className="h-4 w-4" aria-hidden="true" /> Continue as guest
      </Link>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2">
      {turnstileRequired && <div ref={widgetRef} />}
      <button
        type="button"
        disabled={busy || (turnstileRequired && !turnstile.token)}
        className={className}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch("/api/guest", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ turnstile_token: turnstile.token ?? undefined }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error ?? `Could not start a guest session (HTTP ${res.status})`);
            statusPromise = null;
            router.push("/dashboard");
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            turnstile.reset();
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserRound className="h-4 w-4" aria-hidden="true" />}
        Try as guest, no sign-up
      </button>
      {error && <p role="alert" className="text-sm text-red-400 max-w-sm text-center">{error}</p>}
    </div>
  );
}

/** Starts a run on the bundled sample file (template rules, no AI cost). */
export function SampleDataButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        className="inline-flex items-center gap-2 border border-gray-700 hover:border-gray-500 text-gray-200 hover:text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch("/api/sample-data", { method: "POST" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error ?? `Could not start the sample (HTTP ${res.status})`);
            router.push(`/pipelines/${data.pipeline_id}/runs/${data.run_id}`);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader className="h-4 w-4 animate-spin" aria-hidden="true" /> : <PlayCircle className="h-4 w-4" aria-hidden="true" />}
        Try with sample data
      </button>
      {error && <p role="alert" className="text-xs text-red-400 max-w-xs text-right">{error}</p>}
    </div>
  );
}
