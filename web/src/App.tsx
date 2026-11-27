import { useEffect, useState, type ReactNode } from "react";
import { api, NAMES_EXTENSION } from "./api";
import { BoardShell } from "./board";
import { Link, navigate, parseRoute, signInHref, useLocation, type Route } from "./router";
import { InboxProvider, SessionProvider, useInbox, useSession } from "./session";
import { Loading, ToastProvider } from "./ui";
import { Access } from "./pages/Access";
import { Agents } from "./pages/Agents";
import { BoardThreads } from "./pages/BoardThreads";
import { Consent } from "./pages/Consent";
import { Home } from "./pages/Home";
import { Inbox } from "./pages/Inbox";
import { Integrations } from "./pages/Integrations";
import { InviteLanding } from "./pages/InviteLanding";
import { Members } from "./pages/Members";
import { Settings } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { NotFound } from "./pages/Status";
import { TaskBoard } from "./pages/TaskBoard";
import { ThreadPage } from "./pages/ThreadPage";
import { Workload } from "./pages/Workload";
import { Watchers } from "./pages/Watchers";

export function App() {
  return (
    <ToastProvider>
      <SessionProvider>
        <InboxProvider>
          <Shell />
        </InboxProvider>
      </SessionProvider>
    </ToastProvider>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const route = parseRoute(pathname);
  const { loading } = useSession();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" tabIndex={-1}>
        {loading ? <Loading /> : <RouteView route={route} />}
      </main>
      <footer className="site-footer">
        <span>OpenMessageBoard</span>
        <a href="/.well-known/openmessageboard">Server info</a>
      </footer>
    </>
  );
}

function RequireSession({ children }: { children: ReactNode }) {
  const { principal } = useSession();
  const { href } = useLocation();
  useEffect(() => {
    if (!principal) navigate(signInHref(href), { replace: true });
  }, [principal, href]);
  return principal ? <>{children}</> : <Loading />;
}

/**
 * `<server>/<name>`: a board's claimed name. The name is only an address: a signed-out visitor is sent to sign in,
 * and anyone who is not a member of the board sees the same "not found" as for a name nobody holds.
 */
function NamedBoard({ name }: { name: string }) {
  const { principal, loading } = useSession();
  const [state, setState] = useState<"checking" | "signin" | "missing">("checking");
  useEffect(() => {
    if (loading) return;
    let live = true;
    setState("checking");
    void (async () => {
      if (!(await api.hasExtension(NAMES_EXTENSION))) return live && setState("missing");
      if (!principal) return live && setState("signin");
      try {
        const { board_id } = await api.resolveBoardName(name);
        if (live) navigate(`/b/${board_id}`, { replace: true });
      } catch {
        if (live) setState("missing");
      }
    })();
    return () => {
      live = false;
    };
  }, [name, principal, loading]);
  useEffect(() => {
    if (state === "signin") navigate(signInHref(`/${name}`), { replace: true });
  }, [state, name]);
  return state === "missing" ? <NotFound /> : <Loading />;
}

function RouteView({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
      return <Home />;
    case "signin":
      return <SignIn />;
    case "invite":
      return <InviteLanding token={route.token} />;
    case "inbox":
      return (
        <RequireSession>
          <Inbox />
        </RequireSession>
      );
    case "agents":
      return (
        <RequireSession>
          <Agents />
        </RequireSession>
      );
    case "consent":
      return (
        <RequireSession>
          <Consent />
        </RequireSession>
      );
    case "named":
      return <NamedBoard name={route.boardName} />;
    case "board":
    case "thread": {
      const section = route.name === "thread" ? "thread" : route.section;
      return (
        <RequireSession>
          <BoardShell key={route.boardId} boardId={route.boardId} section={section}>
            {route.name === "thread" ? <ThreadPage key={route.threadId} threadId={route.threadId} /> : <BoardSection section={route.section} />}
          </BoardShell>
        </RequireSession>
      );
    }
    default:
      return <NotFound />;
  }
}

function BoardSection({ section }: { section: Extract<Route, { name: "board" }>["section"] }) {
  switch (section) {
    case "threads":
      return <BoardThreads />;
    case "tasks":
      return <TaskBoard />;
    case "members":
      return <Members />;
    case "settings":
      return <Settings />;
    case "integrations":
      return <Integrations />;
    case "workload":
      return <Workload />;
    case "access":
      return <Access />;
    case "watchers":
      return <Watchers />;
  }
}

function Header() {
  const { principal, signOut } = useSession();
  const { unread } = useInbox();
  const { pathname } = useLocation();
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link to="/" className="brand" aria-label="OpenMessageBoard home">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="var(--accent)" />
            <path d="M8 10.5A2.5 2.5 0 0 1 10.5 8h11A2.5 2.5 0 0 1 24 10.5v7a2.5 2.5 0 0 1-2.5 2.5H15l-5 4v-4h.5A2.5 2.5 0 0 1 8 17.5z" fill="#fff" />
            <circle cx="12.5" cy="14" r="1.5" fill="var(--accent)" />
            <circle cx="16" cy="14" r="1.5" fill="var(--accent)" />
            <circle cx="19.5" cy="14" r="1.5" fill="var(--accent)" />
          </svg>
          <span className="brand-name">OpenMessageBoard</span>
        </Link>
        {principal ? (
          <nav className="site-nav" aria-label="Main">
            <Link to="/me/inbox" className="nav-link" aria-current={pathname === "/me/inbox" ? "page" : undefined}>
              Inbox
              {unread > 0 && (
                <span className="nav-badge" aria-label={`${unread} unread`}>
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
            <Link to="/agents" className="nav-link" aria-current={pathname === "/agents" ? "page" : undefined}>
              Agents
            </Link>
            <span className="nav-user" title={principal.email ?? undefined}>
              {principal.display_name}
            </span>
            <button
              type="button"
              className="button button-small"
              onClick={async () => {
                await signOut();
                navigate("/");
              }}
            >
              Sign out
            </button>
          </nav>
        ) : (
          pathname !== "/signin" && (
            <nav className="site-nav" aria-label="Main">
              <Link to={signInHref()} className="button button-small button-primary">
                Sign in
              </Link>
            </nav>
          )
        )}
      </div>
    </header>
  );
}
