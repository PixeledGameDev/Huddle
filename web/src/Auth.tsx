import { useEffect, useRef, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { api, ApiError } from "./api";
import { FinalCta, Features, Footer, Hero, Preview, Steps, Trust, useReveal, useSiteStats } from "./Landing";
import { Logo } from "./Logo";
import type { User } from "./types";

type Mode = "login" | "register" | "twofa" | "reset";

export default function Auth({ onAuth, intro }: { onAuth: (u: User) => void; intro?: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState(""); // sign-in second factor
  const [resetCode, setResetCode] = useState(""); // the reset code a Huddle Admin gave them
  const [newPassword, setNewPassword] = useState("");
  const [factor, setFactor] = useState(""); // authenticator/recovery code needed to reset a 2FA account
  const [needsFactor, setNeedsFactor] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const landing = !intro; // the plain sign-in screen is the home page; an invite shows just the card
  const stats = useSiteStats();
  const scroller = useRef<HTMLElement>(null);
  useReveal(scroller);

  const go = (m: Mode) => {
    setMode(m);
    setError("");
    setNotice("");
  };

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      if (err instanceof ApiError && err.data?.needs2fa && mode === "reset") setNeedsFactor(true);
    } finally {
      setBusy(false);
    }
  }

  /** Signs in with a passkey: the device asks for a fingerprint, face or PIN, and no username or password is typed. */
  const passkeySignIn = () =>
    run(async () => {
      const { options, challengeId } = await api<{ options: any; challengeId: string }>("/auth/passkey/options", "POST");
      let response;
      try {
        response = await startAuthentication({ optionsJSON: options });
      } catch (err: any) {
        if (err?.name === "NotAllowedError" || err?.name === "AbortError") throw new Error("Passkey sign-in was cancelled.");
        throw new Error("This device couldn't use a passkey. You can still sign in with your password.");
      }
      const { user } = await api<{ user: User }>("/auth/passkey/login", "POST", { challengeId, response });
      onAuth(user);
    });
  const canPasskey = browserSupportsWebAuthn();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      if (mode === "reset") {
        await api("/auth/reset", "POST", { identifier: username, code: resetCode, password: newPassword, totp: needsFactor ? factor : undefined });
        setPassword("");
        setResetCode("");
        setNewPassword("");
        setFactor("");
        setNeedsFactor(false);
        setMode("login");
        setNotice("Your password was changed. Sign in with the new one.");
      } else {
        const body: Record<string, string> = { username, password };
        if (mode === "twofa") body.code = code;
        const r = await api<{ user?: User; needs2fa?: boolean }>(`/auth/${mode === "register" ? "register" : "login"}`, "POST", body);
        if (r.needs2fa) {
          setCode("");
          setMode("twofa");
        } else if (r.user) onAuth(r.user);
      }
    });
  };

  /** Switches to a mode, scrolls the form into view and puts the cursor in it. */
  const jumpTo = (m: Mode) => {
    go(m);
    const wrap = document.getElementById("lp-form");
    wrap?.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    window.setTimeout(() => wrap?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }), 250);
  };

  const title =
    mode === "login" ? "Sign in to pick up where you left off."
    : mode === "register" ? "Create an account to start chatting."
    : mode === "twofa" ? "Enter the 6-digit code from your authenticator app, or one of your recovery codes."
    : "Reset your password.";

  const card = (
      <form className="auth-card" onSubmit={submit}>
        {intro}
        {landing && <Logo className="auth-mark" />}
        {landing ? <h2>Huddle</h2> : <h1>Huddle</h1>}
        <p className="muted">{title}</p>
        {notice && <p className="notice" role="status">{notice}</p>}

        {(mode === "login" || mode === "register") && (
          <>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus={!landing} required />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "register" ? 8 : undefined}
                required
              />
            </label>
          </>
        )}

        {mode === "twofa" && (
          <label>
            Code
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text" autoFocus required placeholder="123456" />
          </label>
        )}

        {mode === "reset" && (
          <>
            <p className="muted">Huddle has no email, so a Huddle Admin gives you a one-time reset code. Ask one for a code, then enter it here.</p>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
            </label>
            <label>
              Code
              <input value={resetCode} onChange={(e) => setResetCode(e.target.value)} autoComplete="one-time-code" autoFocus required placeholder="From a Huddle Admin" />
            </label>
            <label>
              New password
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
            </label>
            {needsFactor && (
              <label>
                Authenticator or recovery code
                <input value={factor} onChange={(e) => setFactor(e.target.value)} autoComplete="off" required />
              </label>
            )}
          </>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>
          {mode === "login" ? "Sign in" : mode === "register" ? "Create account" : mode === "twofa" ? "Verify" : "Change password"}
        </button>

        {mode === "login" && canPasskey && (
          <button type="button" className="pill passkey-btn" disabled={busy} onClick={() => void passkeySignIn()}>
            <span aria-hidden="true">🔑</span> Sign in with a passkey
          </button>
        )}
        {mode === "login" && <button type="button" className="link" onClick={() => go("reset")}>Forgot your password?</button>}
        {(mode === "login" || mode === "register") && (
          <button type="button" className="link" onClick={() => go(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "Need an account? Create one" : "Have an account? Sign in"}
          </button>
        )}
        {(mode === "twofa" || mode === "reset") && (
          <button type="button" className="link" onClick={() => go("login")}>Back to sign in</button>
        )}
        {!window.huddleDesktop && !landing && <a className="link" href="/download" target="_blank" rel="noopener">Get the desktop app</a>}
      </form>
  );

  if (!landing) return <main className="auth">{card}</main>;

  const showDownload = !window.huddleDesktop;
  return (
    <main className="auth lp" ref={scroller}>
      <header className="lp-nav">
        <span className="lp-brand"><Logo /> Huddle</span>
        <div className="lp-nav-actions">
          {showDownload && <a className="link-quiet" href="/download" target="_blank" rel="noopener">Desktop app</a>}
          <button type="button" className="pill" onClick={() => jumpTo("login")}>Sign in</button>
        </div>
      </header>
      <section className="lp-hero">
        <Hero stats={stats} onSignUp={() => jumpTo("register")} onSignIn={() => jumpTo("login")} />
        <div className="lp-form" id="lp-form">{card}</div>
      </section>
      <Preview />
      <Features />
      <Steps />
      <Trust showDownload={showDownload} />
      <FinalCta onSignUp={() => jumpTo("register")} />
      <Footer showDownload={showDownload} />
    </main>
  );
}
