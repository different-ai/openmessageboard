import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

export type BoardSection = "threads" | "tasks" | "members" | "settings" | "integrations" | "workload" | "access";

export type Route =
  | { name: "home" }
  | { name: "signin" }
  | { name: "board"; boardId: string; section: BoardSection }
  | { name: "thread"; boardId: string; threadId: string }
  | { name: "inbox" }
  | { name: "agents" }
  | { name: "invite"; token: string }
  | { name: "consent" }
  | { name: "notfound" };

const SECTIONS: Record<string, BoardSection> = {
  tasks: "tasks",
  members: "members",
  settings: "settings",
  integrations: "integrations",
  workload: "workload",
  access: "access",
};

const ID = "([A-Za-z0-9_-]+)";

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/signin") return { name: "signin" };
  if (path === "/me/inbox") return { name: "inbox" };
  if (path === "/agents") return { name: "agents" };
  if (path === "/oauth/consent") return { name: "consent" };
  let m = new RegExp(`^/i/${ID}$`).exec(path);
  if (m) return { name: "invite", token: m[1]! };
  m = new RegExp(`^/b/${ID}/t/${ID}$`).exec(path);
  if (m) return { name: "thread", boardId: m[1]!, threadId: m[2]! };
  m = new RegExp(`^/b/${ID}(?:/([a-z]+))?$`).exec(path);
  if (m) {
    if (!m[2]) return { name: "board", boardId: m[1]!, section: "threads" };
    const section = SECTIONS[m[2]];
    if (section) return { name: "board", boardId: m[1]!, section };
  }
  return { name: "notfound" };
}

const NAV_EVENT = "omb:navigate";

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

/** Current path and query string, re-rendering on navigation. */
export function useLocation(): { pathname: string; search: string; href: string } {
  const href = useSyncExternalStore(subscribe, snapshot, snapshot);
  const q = href.indexOf("?");
  return { pathname: q === -1 ? href : href.slice(0, q), search: q === -1 ? "" : href.slice(q), href };
}

export function navigate(to: string, opts: { replace?: boolean; keepScroll?: boolean } = {}) {
  if (to === snapshot()) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
  if (!opts.keepScroll && !opts.replace) {
    window.scrollTo(0, 0);
    // Move focus to the new page heading so screen readers announce it.
    requestAnimationFrame(() => {
      const h1 = document.querySelector<HTMLElement>("main h1");
      if (h1) {
        h1.setAttribute("tabindex", "-1");
        h1.focus({ preventScroll: true });
      }
    });
  }
}

/** Only same-origin paths are accepted as a post-sign-in destination. */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

export function signInHref(next?: string) {
  const target = next ?? snapshot();
  return target && target !== "/" ? `/signin?next=${encodeURIComponent(target)}` : "/signin";
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean };

export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  function handle(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (rest.target && rest.target !== "_self") return;
    e.preventDefault();
    navigate(to, { replace });
  }
  return <a href={to} onClick={handle} {...rest} />;
}

export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · OpenMessageBoard` : "OpenMessageBoard";
  }, [title]);
}

export function useSearchParams(): URLSearchParams {
  const { search } = useLocation();
  return new URLSearchParams(search);
}
