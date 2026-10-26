import { useEffect, useState } from "react";
import { api } from "./api";
import { Logo } from "./Logo";

export interface SiteStats { users: number; servers: number }

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Public numbers for the sign-in page. Null until they load (or if they can't), and the page copes with both. */
export function useSiteStats() {
  const [stats, setStats] = useState<SiteStats | null>(null);
  useEffect(() => {
    let live = true;
    api<SiteStats>("/auth/stats").then((s) => live && setStats(s), () => {});
    return () => { live = false; };
  }, []);
  return stats;
}

/** Counts up from 0 to the target once, so the number feels alive. Jumps straight there if the person prefers less motion. */
function useCountUp(target: number, ms = 1300) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!target || reduced()) return setN(target);
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return n;
}

/** Fades sections in as they scroll into view. `root` is the scrolling element. */
export function useReveal(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".lp-reveal"));
    if (!("IntersectionObserver" in window) || reduced()) {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      },
      { root: root.current, threshold: 0.12 }
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [root]);
}

export function CountPill({ stats }: { stats: SiteStats | null }) {
  const total = stats?.users ?? 0;
  const n = useCountUp(total);
  if (!stats) return <p className="lp-count lp-count-ghost" aria-hidden="true">&nbsp;</p>;
  const label = total > 0 ? `Join the ${total.toLocaleString()} other ${total === 1 ? "user" : "users"} on Huddle` : "Be the first to join Huddle";
  return (
    <p className="lp-count">
      <span className="lp-live" aria-hidden="true" />
      <span className="lp-sr">{label}</span>
      <span aria-hidden="true">
        {total > 0 ? (
          <>Join the <b>{n.toLocaleString()}</b> other {total === 1 ? "user" : "users"} on Huddle</>
        ) : (
          label
        )}
      </span>
    </p>
  );
}

export function Hero({ stats, onSignUp, onSignIn }: { stats: SiteStats | null; onSignUp: () => void; onSignIn: () => void }) {
  return (
    <div className="lp-copy">
      <CountPill stats={stats} />
      <h1>Where your <span className="lp-grad">community</span> comes together.</h1>
      <p className="lp-lead">
        Huddle is a realtime chat app for friends, clubs and communities. Build a server, split it into channels, and keep every
        conversation, poll and in-joke in one place.
      </p>
      <div className="lp-cta">
        <button type="button" className="primary lp-big" onClick={onSignUp}>Create an account</button>
        <button type="button" className="pill lp-big" onClick={onSignIn}>I already have one</button>
      </div>
      <ul className="lp-ticks" aria-label="Highlights">
        <li>Instant messages</li>
        <li>Roles &amp; permissions</li>
        <li>Vote moderation</li>
        <li>Desktop app</li>
      </ul>
      {stats && stats.servers > 0 && (
        <p className="lp-sub">Already home to <b>{stats.servers.toLocaleString()}</b> {stats.servers === 1 ? "server" : "servers"}.</p>
      )}
    </div>
  );
}

const avatar = (h: number) => ({ background: `linear-gradient(135deg, hsl(${h} 70% 58%), hsl(${(h + 40) % 360} 70% 48%))` });

/** A picture of the real app, built from the same colours and shapes. Decorative, so it's hidden from screen readers. */
export function Preview() {
  return (
    <section className="lp-section lp-reveal" aria-hidden="true">
      <div className="lp-window">
        <div className="lp-win-nav">
          <div className="lp-win-brand"><Logo /> Huddle</div>
          <div className="lp-win-servers">
            <span style={avatar(222)}>GN</span>
            <span style={avatar(160)}>SG</span>
            <span style={avatar(20)}>BC</span>
            <span className="add">+</span>
          </div>
          <div className="lp-win-seg"><span className="on">Channels</span><span>Messages</span><span>Friends</span></div>
          <div className="lp-win-label">Channels</div>
          <div className="lp-chan on"><i>#</i> general</div>
          <div className="lp-chan hot"><i>#</i> game-night <b>2</b></div>
          <div className="lp-chan"><i>#</i> memes</div>
          <div className="lp-chan"><i>#</i> announcements</div>
        </div>
        <div className="lp-win-main">
          <div className="lp-win-head"><i>#</i> general <small>Game Night crew · 12 online</small></div>
          <div className="lp-msgs">
            <div className="lp-msg">
              <span className="lp-av" style={avatar(222)}>M</span>
              <div><b>Maya</b> <small>Today 7:42 PM</small>
                <p>Who&rsquo;s in for game night on Friday? 🎲</p>
                <div className="lp-react"><span className="mine">🙌 5</span><span>🔥 2</span></div>
              </div>
            </div>
            <div className="lp-msg">
              <span className="lp-av" style={avatar(160)}>J</span>
              <div><b>Jordan</b> <small>Today 7:44 PM</small>
                <p className="lp-quote">↪ Maya: Who&rsquo;s in for game night&hellip;</p>
                <p>Count me in. I&rsquo;ll bring snacks.</p>
              </div>
            </div>
            <div className="lp-msg mention">
              <span className="lp-av" style={avatar(20)}>S</span>
              <div><b>Sam</b> <small>Today 7:51 PM</small>
                <p><span className="lp-at">@Maya</span> I made a poll for the game!</p>
                <div className="lp-poll">
                  <strong>What are we playing?</strong>
                  <div><span style={{ width: "64%" }} />Codenames <em>64%</em></div>
                  <div><span style={{ width: "28%" }} />Mario Kart <em>28%</em></div>
                  <div><span style={{ width: "8%" }} />Charades <em>8%</em></div>
                </div>
              </div>
            </div>
          </div>
          <div className="lp-compose">Message #general</div>
        </div>
      </div>
    </section>
  );
}

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: "🏠", title: "Servers and channels", text: "Make a home for any group and split it into channels. Share an invite link and people are in." },
  { icon: "⚡", title: "Instant, live chat", text: "Messages, edits, replies, reactions and typing indicators show up for everyone the moment they happen." },
  { icon: "💬", title: "Direct messages and friends", text: "Chat one to one, keep a friends list, reply to someone's status, and tidy your conversations whenever you like." },
  { icon: "🎭", title: "Roles and permissions", text: "Ranked roles with fine-grained permissions. Let people pick their own roles, and show them off in the member list." },
  { icon: "🗳️", title: "Vote moderation", text: "Turn it on and members can vote to kick, time out or temporarily ban, so moderation isn't left to one person." },
  { icon: "🎉", title: "Polls, GIFs and stickers", text: "Settle debates with polls, and give every server its own custom emoji and stickers." },
  { icon: "🎨", title: "Make it yours", text: "Profile pictures, banners, bios, statuses, accent colours and name fonts, plus light and dark themes." },
  { icon: "🔒", title: "Private and safe", text: "Authenticator-app sign-in, recovery codes, blocking, and your choice of who can start a conversation with you." },
];

export function Features() {
  return (
    <section className="lp-section">
      <div className="lp-head lp-reveal">
        <span className="lp-eyebrow">Features</span>
        <h2>Everything a community needs</h2>
        <p>All the tools to talk, organise and keep things friendly, without the clutter.</p>
      </div>
      <div className="lp-grid">
        {FEATURES.map((f, i) => (
          <article key={f.title} className="lp-card lp-reveal" style={{ transitionDelay: `${(i % 4) * 70}ms` }}>
            <span className="lp-ico" aria-hidden="true">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function Steps() {
  const steps = [
    { n: "1", title: "Create your account", text: "Pick a username and password. It takes less than a minute." },
    { n: "2", title: "Join or start a server", text: "Open an invite link from a friend, or make a server of your own and invite everyone." },
    { n: "3", title: "Start talking", text: "Jump into a channel, send a message, drop a poll and see who's online." },
  ];
  return (
    <section className="lp-section">
      <div className="lp-head lp-reveal">
        <span className="lp-eyebrow">How it works</span>
        <h2>From sign-up to chatting in three steps</h2>
      </div>
      <ol className="lp-steps">
        {steps.map((s, i) => (
          <li key={s.n} className="lp-step lp-reveal" style={{ transitionDelay: `${i * 90}ms` }}>
            <span className="lp-num">{s.n}</span>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Trust({ showDownload }: { showDownload: boolean }) {
  const points = [
    ["You decide who can message you", "Everyone, friends only, or nobody. Existing chats stay put."],
    ["Moderation your way", "Roles with real permissions, an activity log, and optional member votes."],
    ["Block and report problems", "Block anyone in one click, and ask a Huddle Admin for help when you need it."],
    ["Extra protection for your account", "Add an authenticator app and keep recovery codes for emergencies."],
  ];
  return (
    <section className="lp-section lp-split">
      <div className="lp-panel lp-reveal">
        <span className="lp-eyebrow">Built for communities</span>
        <h2>Stay in control of your space</h2>
        <ul className="lp-points">
          {points.map(([t, d]) => (
            <li key={t}><span aria-hidden="true">✓</span><div><b>{t}</b><p>{d}</p></div></li>
          ))}
        </ul>
      </div>
      <div className="lp-panel lp-panel-accent lp-reveal" style={{ transitionDelay: "90ms" }}>
        <span className="lp-eyebrow">Desktop app</span>
        <h2>Huddle on your desktop</h2>
        <p>Get notifications, a dedicated window, custom themes and automatic updates.</p>
        {showDownload ? (
          <a className="pill primary lp-big" href="/download" target="_blank" rel="noopener">Download the app</a>
        ) : (
          <p className="lp-sub">You&rsquo;re already using it. 🎉</p>
        )}
      </div>
    </section>
  );
}

export function FinalCta({ onSignUp }: { onSignUp: () => void }) {
  return (
    <section className="lp-section lp-final lp-reveal">
      <h2>Ready to hang out?</h2>
      <p>Make an account and find your people.</p>
      <button type="button" className="primary lp-big" onClick={onSignUp}>Create an account</button>
    </section>
  );
}

export function Footer({ showDownload }: { showDownload: boolean }) {
  return (
    <footer className="lp-foot">
      <span className="lp-foot-brand"><Logo /> Huddle</span>
      <span className="muted">&copy; {new Date().getFullYear()} Huddle</span>
      {showDownload && <a className="link-quiet" href="/download" target="_blank" rel="noopener">Desktop app</a>}
    </footer>
  );
}
