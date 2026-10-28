"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/db/browser";
import { recordAnalyticsEvent } from "@/lib/analytics/client";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    const supabase = getBrowserClient();

    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        // If email confirmation is disabled, a session is returned immediately.
        if (data.session) {
          void recordAnalyticsEvent({
            eventKey: `sign-in:${crypto.randomUUID()}`,
            eventName: "sign_in",
            mode: "personal",
          });
          router.push("/chat");
          router.refresh();
          return;
        }
        setNotice("Check your email to confirm your account, then sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        void recordAnalyticsEvent({
          eventKey: `sign-in:${crypto.randomUUID()}`,
          eventName: "sign_in",
          mode: "personal",
        });
        router.push("/chat");
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <h1 className="font-display text-[28px] font-semibold tracking-tight">
            Finance Assistant
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Talk to your money in plain language.
          </p>
        </header>

        <form
          onSubmit={onSubmit}
          className="rounded border border-border bg-surface p-6 shadow-sm"
        >
          <label className="mb-1 block text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />

          <label className="mb-1 block text-sm font-medium" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={6}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />

          {error && <p className="mb-3 text-sm text-danger">{error}</p>}
          {notice && <p className="mb-3 text-sm text-accent">{notice}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-sm bg-accent py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading
              ? "Please wait…"
              : mode === "signup"
                ? "Create account"
                : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-text-muted">
          {mode === "signup" ? "Already have an account?" : "New here?"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "signup" ? "signin" : "signup");
              setError(null);
              setNotice(null);
            }}
            className="font-medium text-accent hover:underline"
          >
            {mode === "signup" ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>
    </main>
  );
}
