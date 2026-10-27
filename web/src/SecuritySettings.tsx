import { useCallback, useEffect, useMemo, useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";
import { qrModules } from "./qr";

interface Security {
  totpEnabled: boolean;
  recoveryLeft: number;
}
type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
type Panel = null | "passkeyAdd" | "passkeyRemove" | "password" | "setup1" | "setup2" | "off" | "codes";

function Qr({ text }: { text: string }) {
  const mods = useMemo(() => qrModules(text), [text]);
  const n = mods.length;
  const path = mods.map((row, y) => row.map((dark, x) => (dark ? `M${x + 4} ${y + 4}h1v1h-1z` : "")).join("")).join("");
  return (
    <svg className="qr" viewBox={`0 0 ${n + 8} ${n + 8}`} role="img" aria-label="QR code to scan with your authenticator app" shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** The "Sign-in & recovery" section of Profile & appearance: passkeys, password, and two-factor sign-in. */
export function SecuritySettings({ onError }: { onError: (e: unknown) => void }) {
  const [sec, setSec] = useState<Security | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [pw, setPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [pkName, setPkName] = useState("");
  const [pkRemoving, setPkRemoving] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Security>("/me/security").then(setSec, onError);
    api<{ passkeys: Passkey[] }>("/me/passkeys").then((r) => setPasskeys(r.passkeys), () => {});
  }, [onError]);
  useEffect(load, [load]);

  const close = () => {
    setPanel(null);
    setPw("");
    setNewPw("");
    setCode("");
    setSetup(null);
  };
  const open = (p: Panel) => {
    close();
    setMsg("");
    setPanel(p);
  };
  async function act(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  const submit = (work: () => Promise<void>) => (e: React.FormEvent) => {
    e.preventDefault();
    void act(work);
  };

  if (!sec) return <div className="stack"><h3>Sign-in &amp; recovery</h3><p className="muted">Loading…</p></div>;

  const passwordField = (
    <label>Current password<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required /></label>
  );
  const codeField = (
    <label>Authenticator or recovery code<input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required /></label>
  );
  const buttons = (label: string, danger = false) => (
    <div className="row">
      <button type="button" onClick={close}>Cancel</button>
      <button className={danger ? "danger-fill" : "primary"} disabled={busy}>{label}</button>
    </div>
  );

  return (
    <div className="stack">
      <h3>Sign-in &amp; recovery</h3>
      {msg && <p className="notice" role="status">{msg}</p>}

      {/* ---- password */}
      <div className="stack tight">
        <strong>Password</strong>
        {panel === null && <div className="row"><button type="button" onClick={() => open("password")}>Change password…</button></div>}
        {panel === "password" && (
          <form className="stack" onSubmit={submit(async () => {
            await api("/me/password", "POST", { current: pw, password: newPw, code: sec.totpEnabled ? code : undefined });
            close();
            setMsg("Password changed. Your other devices were signed out.");
          })}>
            {passwordField}
            <label>New password<input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" minLength={8} required /></label>
            {sec.totpEnabled && codeField}
            {buttons("Change password")}
          </form>
        )}
      </div>

      {/* ---- passkeys */}
      <div className="stack tight">
        <strong>Passkeys</strong>
        <p className="muted">Sign in with your fingerprint, face, PIN or a security key instead of typing a password. Passkeys can't be phished, and they count as two-factor on their own.</p>
        {passkeys.length > 0 && (
          <ul className="passkey-list">
            {passkeys.map((p) => (
              <li key={p.id}>
                <span aria-hidden="true">🔑</span>
                <div>
                  <b>{p.name}</b>
                  <small className="muted">Added {new Date(p.createdAt).toLocaleDateString()}{p.lastUsedAt ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : " · never used"}</small>
                </div>
                <button type="button" className="link" onClick={() => { open("passkeyRemove"); setPkRemoving(p.id); }}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        {panel === null && !browserSupportsWebAuthn() && <p className="muted">This browser can't use passkeys.</p>}
        {panel === null && browserSupportsWebAuthn() && <div className="row"><button type="button" onClick={() => open("passkeyAdd")}>Add a passkey…</button></div>}
        {panel === "passkeyAdd" && (
          <form className="stack" onSubmit={submit(async () => {
            const { options, challengeId } = await api<{ options: any; challengeId: string }>("/me/passkeys/options", "POST", { password: pw });
            let response;
            try {
              response = await startRegistration({ optionsJSON: options });
            } catch (err: any) {
              if (err?.name === "InvalidStateError") throw new Error("This device already has a passkey for Huddle.");
              if (err?.name === "NotAllowedError" || err?.name === "AbortError") throw new Error("Adding the passkey was cancelled.");
              throw new Error("This device couldn't create a passkey.");
            }
            const r = await api<{ passkeys: Passkey[] }>("/me/passkeys", "POST", { challengeId, response, name: pkName.trim() || undefined });
            setPasskeys(r.passkeys);
            close();
            setPkName("");
            setMsg("Passkey added. Next time, choose “Sign in with a passkey”.");
          })}>
            <label>Name (optional)<input value={pkName} onChange={(e) => setPkName(e.target.value)} maxLength={40} placeholder="e.g. My laptop, YubiKey" /></label>
            {passwordField}
            {buttons("Add passkey")}
          </form>
        )}
        {panel === "passkeyRemove" && pkRemoving && (
          <form className="stack" onSubmit={submit(async () => {
            const r = await api<{ passkeys: Passkey[] }>(`/me/passkeys/${encodeURIComponent(pkRemoving)}`, "DELETE", { password: pw });
            setPasskeys(r.passkeys);
            close();
            setPkRemoving(null);
            setMsg("Passkey removed.");
          })}>
            {passwordField}
            {buttons("Remove passkey", true)}
          </form>
        )}
      </div>

      {/* ---- two-factor */}
      <div className="stack tight">
        <strong>Two-factor sign-in</strong>
        {sec.totpEnabled ? (
          <p className="muted">On. Signing in needs a code from your authenticator app. You have {sec.recoveryLeft} unused recovery {sec.recoveryLeft === 1 ? "code" : "codes"}.</p>
        ) : (
          <p className="muted">Off. Turn it on to require a code from an authenticator app (Google Authenticator, Authy, 1Password and others) when you sign in.</p>
        )}
        {panel === null && !recovery && (
          <div className="row">
            {!sec.totpEnabled && <button type="button" onClick={() => open("setup1")}>Turn on…</button>}
            {sec.totpEnabled && <button type="button" onClick={() => open("codes")}>New recovery codes…</button>}
            {sec.totpEnabled && <button type="button" onClick={() => open("off")}>Turn off…</button>}
          </div>
        )}
        {panel === "setup1" && (
          <form className="stack" onSubmit={submit(async () => {
            setSetup(await api<{ secret: string; uri: string }>("/me/2fa/setup", "POST", { password: pw }));
            setPw("");
            setPanel("setup2");
          })}>
            {passwordField}
            {buttons("Continue")}
          </form>
        )}
        {panel === "setup2" && setup && (
          <form className="stack" onSubmit={submit(async () => {
            const r = await api<{ recoveryCodes: string[] }>("/me/2fa/enable", "POST", { code });
            close();
            setRecovery(r.recoveryCodes);
            load();
          })}>
            <p className="muted">Scan this with your authenticator app, or type the key in by hand, then enter the 6-digit code it shows.</p>
            <Qr text={setup.uri} />
            <div className="secret-key" aria-label="Setup key">{setup.secret}</div>
            <label>6-digit code<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required /></label>
            {buttons("Turn on")}
          </form>
        )}
        {(panel === "off" || panel === "codes") && (
          <form className="stack" onSubmit={submit(async () => {
            if (panel === "off") {
              await api("/me/2fa/disable", "POST", { password: pw, code });
              close();
              setMsg("Two-factor sign-in is off.");
            } else {
              const r = await api<{ recoveryCodes: string[] }>("/me/2fa/recovery", "POST", { password: pw, code });
              close();
              setRecovery(r.recoveryCodes);
            }
            load();
          })}>
            {passwordField}
            {codeField}
            {buttons(panel === "off" ? "Turn off two-factor" : "Make new codes", panel === "off")}
          </form>
        )}
        {recovery && (
          <div className="stack">
            <p><strong>Save these recovery codes now.</strong> Each works once if you lose your authenticator. They won't be shown again, and making new ones replaces these.</p>
            <div className="recovery-grid">{recovery.map((c) => <span key={c}>{c}</span>)}</div>
            <div className="row">
              <button type="button" onClick={() => navigator.clipboard?.writeText(recovery.join("\n")).then(() => setMsg("Copied."), () => {})}>Copy</button>
              <a className="btn" download="huddle-recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`Huddle recovery codes\n\n${recovery.join("\n")}\n`)}`}>Download</a>
              <button type="button" className="primary" onClick={() => setRecovery(null)}>I've saved them</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
