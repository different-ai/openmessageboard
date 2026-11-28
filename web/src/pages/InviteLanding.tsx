import type { InvitePreview } from "@openmessageboard/protocol";
import { useState } from "react";
import { api, ApiError, isApiError } from "../api";
import { formatZoned } from "../format";
import { Link, navigate, signInHref, useTitle } from "../router";
import { useSession } from "../session";
import { Loading, errorText, useLoad } from "../ui";

const STATUS_TEXT: Record<InvitePreview["status"], string> = {
  active: "Active",
  expired: "This invite has expired.",
  disabled: "The board owner disabled this invite.",
  used_up: "This invite has been used the maximum number of times.",
};

const STATUS_BADGE: Record<InvitePreview["status"], string> = {
  active: "Active",
  expired: "Expired",
  disabled: "Disabled",
  used_up: "Used up",
};

const AUDIENCE_TEXT: Record<InvitePreview["audience"], string> = {
  link: "Anyone signed in with this link can join.",
  email: "Only the invited email address can join.",
  domain: "Only verified addresses at the invited company domain can join.",
};

function failureText(e: unknown): { title: string; body: string } {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "invite_expired":
        return { title: "This invite has expired", body: "Ask the board owner for a new link." };
      case "invite_disabled":
        return { title: "This invite was disabled", body: "The board owner turned it off. Ask them for a new link." };
      case "invite_not_eligible": {
        const reason = typeof e.details.reason === "string" ? e.details.reason : null;
        return {
          title: "This invite isn't for this account",
          body: `${reason ?? e.message} You can sign in with a different email, or ask the owner to invite this one.`,
        };
      }
      case "member_limit_reached":
        return { title: "This board is full", body: "It has reached its member limit. Ask the owner to make room." };
      case "rate_limited":
        return { title: "Too many attempts", body: errorText(e) };
      default:
        return { title: "Couldn't join", body: e.message };
    }
  }
  return { title: "Couldn't join", body: errorText(e) };
}

export function InviteLanding({ token }: { token: string }) {
  const { principal, refreshMe, signOut } = useSession();
  const { data: preview, error, loading } = useLoad(() => api.invitePreview(token), [token]);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<unknown>(null);
  useTitle(preview ? `Join ${preview.board_name}` : "Invite");

  if (loading) return <Loading label="Opening invite…" />;
  if (error || !preview) {
    return (
      <div className="page narrow status-page">
        <h1>{isApiError(error, "not_found") ? "This invite link isn't valid" : "Couldn't open this invite"}</h1>
        <p className="lead">
          {isApiError(error, "not_found")
            ? "Check that you copied the whole link, or ask the board owner for a new one."
            : errorText(error)}
        </p>
        <Link to="/" className="button">
          Go home
        </Link>
      </div>
    );
  }

  async function join() {
    setJoining(true);
    setJoinError(null);
    try {
      const board = await api.redeemInvite(token);
      await refreshMe();
      navigate(`/b/${board.id}`, { replace: true });
    } catch (e) {
      setJoinError(e);
    } finally {
      setJoining(false);
    }
  }

  const active = preview.status === "active";
  const failure = joinError ? failureText(joinError) : null;

  return (
    <div className="page narrow invite-page">
      <div className="card invite-card">
        <p className="eyebrow">You're invited</p>
        <h1>{preview.board_name}</h1>
        <p className="lead">
          <strong>{preview.inviter}</strong> invited you to join as a <strong>{preview.role}</strong>.
        </p>
        <dl className="facts stacked">
          <div>
            <dt>Role</dt>
            <dd>{preview.role === "reader" ? "Reader: read and follow threads" : "Contributor: post, reply and claim tasks"}</dd>
          </div>
          <div>
            <dt>Join by</dt>
            <dd>{preview.join_by ? formatZoned(preview.join_by) : "No deadline"}</dd>
          </div>
          <div>
            <dt>Access ends</dt>
            <dd>{preview.access_ends_at ? formatZoned(preview.access_ends_at) : "Doesn't end on its own"}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`badge invite-${preview.status}`}>{STATUS_BADGE[preview.status]}</span>
            </dd>
          </div>
        </dl>
        <p className="muted small">{AUDIENCE_TEXT[preview.audience]}</p>

        {!active ? (
          <p className="note note-error" role="alert">
            {STATUS_TEXT[preview.status]} Ask the board owner for a new link.
          </p>
        ) : failure ? (
          <div className="note note-error" role="alert">
            <strong>{failure.title}.</strong> {failure.body}
          </div>
        ) : null}

        {active &&
          (principal ? (
            <div className="stack">
              <button type="button" className="button button-primary button-block" onClick={join} disabled={joining}>
                {joining ? "Joining…" : `Join ${preview.board_name}`}
              </button>
              <p className="hint">
                Signed in as {principal.email ?? principal.display_name}.{" "}
                {isApiError(joinError, "invite_not_eligible") && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={async () => {
                      await signOut();
                      navigate(signInHref());
                    }}
                  >
                    Use a different account
                  </button>
                )}
              </p>
            </div>
          ) : (
            <div className="stack">
              <Link to={signInHref()} className="button button-primary button-block">
                Sign in to join
              </Link>
              <p className="hint">New here? Signing in with your email creates your account.</p>
            </div>
          ))}
      </div>
    </div>
  );
}
