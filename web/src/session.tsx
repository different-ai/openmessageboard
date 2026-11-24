import type { InboxItem, Principal } from "@openmessageboard/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Whoami } from "./api";
import { InboxLive } from "./live";

type SessionValue = {
  loading: boolean;
  principal: Principal | null;
  me: Whoami | null;
  meError: unknown;
  refresh: () => Promise<Principal | null>;
  refreshMe: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [me, setMe] = useState<Whoami | null>(null);
  const [meError, setMeError] = useState<unknown>(null);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
      setMeError(null);
    } catch (e) {
      setMeError(e);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { principal: p } = await api.session();
      setPrincipal(p);
      if (p) await refreshMe();
      else setMe(null);
      return p;
    } catch {
      setPrincipal(null);
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [refreshMe]);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } finally {
      setPrincipal(null);
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ loading, principal, me, meError, refresh, refreshMe, signOut }),
    [loading, principal, me, meError, refresh, refreshMe, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

type InboxValue = {
  unread: number;
  setUnread: (n: number) => void;
  /** Subscribe to inbox items as they arrive. */
  onItem: (fn: (item: InboxItem) => void) => () => void;
};

const InboxContext = createContext<InboxValue | null>(null);

/** Keeps the header badge current through `/api/inbox/stream`. */
export function InboxProvider({ children }: { children: ReactNode }) {
  const { principal } = useSession();
  const principalId = principal?.id ?? null;
  const [unread, setUnread] = useState(0);
  const [live, setLive] = useState<InboxLive | null>(null);

  useEffect(() => {
    if (!principalId) {
      setUnread(0);
      return;
    }
    const inbox = new InboxLive();
    setLive(inbox);
    let cancelled = false;
    const load = async () => {
      try {
        const page = await api.inbox({ unread_only: true, limit: 1 });
        if (cancelled) return;
        setUnread(page.unread_count);
        inbox.start(page.as_of);
      } catch {
        if (!cancelled) inbox.start();
      }
    };
    void load();
    const offItem = inbox.items.on((item) => {
      if (!item.read_at) setUnread((n) => n + 1);
    });
    const offResync = inbox.resync.on(() => {
      api
        .inbox({ unread_only: true, limit: 1 })
        .then((p) => setUnread(p.unread_count))
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      offItem();
      offResync();
      inbox.close();
      setLive(null);
    };
  }, [principalId]);

  const onItem = useCallback((fn: (item: InboxItem) => void) => (live ? live.items.on(fn) : () => {}), [live]);

  const value = useMemo(() => ({ unread, setUnread, onItem }), [unread, onItem]);
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

export function useInbox(): InboxValue {
  const v = useContext(InboxContext);
  if (!v) throw new Error("useInbox outside InboxProvider");
  return v;
}
