import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface EmbedInfo {
  url: string;
  host: string;
  kind: "link" | "image" | "minimal";
  siteName: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  large: boolean;
}

const cache = new Map<string, Promise<EmbedInfo | null>>();

/** One request per link per page load, shared by every message (and every re-render) that shows it. */
function fetchEmbed(url: string): Promise<EmbedInfo | null> {
  let p = cache.get(url);
  if (!p) {
    p = api<{ embed: EmbedInfo }>(`/embed?url=${encodeURIComponent(url)}`).then(
      (r) => r.embed,
      () => {
        cache.delete(url); // a failed request (rate limit, offline) is worth retrying next time, unlike a site with no preview
        return null;
      }
    );
    cache.set(url, p);
  }
  return p;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * Preview card shown under a message for each link in it. The server fetches the page, so this browser never talks to
 * the linked site, and the preview image comes from this server too. The request only starts once the card scrolls
 * near the screen, so opening a channel with a long history doesn't fire off a request for every old link.
 */
export function LinkEmbed({ url, onLayout }: { url: string; onLayout: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [info, setInfo] = useState<EmbedInfo | null | undefined>(undefined); // undefined = loading, null = failed
  const [badImage, setBadImage] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let live = true;
    fetchEmbed(url).then((i) => live && setInfo(i));
    return () => { live = false; };
  }, [near, url]);

  // The card appearing changes the height of the message list, so let it keep the view pinned to the bottom if it was.
  const layout = useRef(onLayout);
  layout.current = onLayout;
  useEffect(() => {
    if (info !== undefined) layout.current();
  }, [info]);

  if (info === undefined) return <div ref={holder} className="embed embed-loading" aria-hidden="true" />;

  const host = info?.host ?? hostOf(url);
  const image = info?.image && !badImage ? info.image : null;

  // A link that is itself a picture is shown as the picture.
  if (info?.kind === "image" && image) {
    return (
      <div ref={holder} className="embed-image-only">
        <a href={url} target="_blank" rel="noopener noreferrer nofollow ugc">
          <img src={image} alt="" loading="lazy" onLoad={onLayout} onError={() => setBadImage(true)} />
        </a>
      </div>
    );
  }

  const title = info?.kind === "link" ? info.title : null;
  return (
    <div ref={holder} className={`embed${info?.kind === "link" ? "" : " embed-plain"}`}>
      <small className="embed-site">{info?.siteName ?? host}</small>
      <a className="embed-title" href={url} target="_blank" rel="noopener noreferrer nofollow ugc">{title ?? url}</a>
      {info?.description && <p className="embed-desc">{info.description}</p>}
      {image && (
        <img
          className={info?.large ? "embed-img large" : "embed-img small"}
          src={image}
          alt=""
          loading="lazy"
          onLoad={onLayout}
          onError={() => setBadImage(true)}
        />
      )}
    </div>
  );
}
