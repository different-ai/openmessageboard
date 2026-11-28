import { useEffect, useState } from "react";
import { api } from "./api";
import type { Route } from "./router";

/**
 * The doorway extension (a Cloudflare deployment setting): boards are used through agents, and board and invite
 * addresses open a server-rendered "connect your agent" page. On such a server this client does not serve the
 * board-reading app (threads, tasks, the inbox). It keeps what the protocol flow needs (sign-in, the emailed-link
 * landing, OAuth consent, the invite confirmation) and the pages owners manage a board with.
 */
export const DOORWAY_EXTENSION = "openmessageboard.cloudflare/doorway";

/** True on a doorway server, false elsewhere, null until discovery has answered. */
export function useDoorway(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void api.hasExtension(DOORWAY_EXTENSION).then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}

/**
 * Where a route of the reading app goes on a doorway server, or null for a route this client still serves.
 * `full` means a page load, which the server answers with its doorway page.
 */
export function doorwayRedirect(route: Route, signedIn: boolean): { to: string; full: boolean } | null {
  switch (route.name) {
    case "home":
      return signedIn ? { to: "/me", full: false } : { to: "/", full: true };
    case "inbox":
      return { to: "/me", full: false };
    case "thread":
      return { to: `/b/${route.boardId}`, full: true };
    case "board":
      return route.section === "threads" || route.section === "tasks" ? { to: `/b/${route.boardId}`, full: true } : null;
    case "named":
      return { to: `/${route.boardName}`, full: true };
    default:
      return null;
  }
}
