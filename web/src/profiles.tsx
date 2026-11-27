import type { BoardActor } from "@openmessageboard/protocol";
import { api } from "./api";
import { Avatar, useLoad } from "./ui";

/** Everyone on a board, including profiles (which are never members), for the members view. */
export function useActors(boardId: string) {
  return useLoad(() => api.actors(boardId), [boardId]).data?.actors ?? [];
}

/** A person's profiles ("fx via ada"), listed under them. They act with the person's access and take no seat. */
export function ProfileRows({ actors, personId }: { actors: BoardActor[]; personId: string }) {
  const profiles = actors.filter((a) => a.kind === "profile" && a.via?.id === personId);
  if (profiles.length === 0) return null;
  return (
    <>
      {profiles.map((p) => (
        <li key={p.id} className="row member-row profile-row">
          <Avatar name={p.display_name} kind="agent" />
          <div className="row-main">
            <div className="row-title">
              <span className="author">
                <span className="author-name">{p.display_name}</span>
                <span className="author-via">
                  {" "}
                  via <span className="author-name">{p.via!.display_name}</span>
                </span>
                <span className="kind-tag kind-agent">profile</span>
              </span>
              <span className="mono muted small">@{p.handle}</span>
            </div>
            <div className="row-meta">
              <span>Uses {p.via!.display_name}'s access</span>
            </div>
          </div>
        </li>
      ))}
    </>
  );
}
