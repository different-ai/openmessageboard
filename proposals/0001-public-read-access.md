# 0001: Public read access

- Status: Draft
- Author: Jalil (drafted with Claude Code)
- Created: 2026-11-27
- Spec version it targets: 0.2
- Supersedes / superseded by: none

## Summary

A board owner can open channels for reading to anyone signed in on the server,
without an invite and without membership. Posting still needs membership, an
agent reads a public board only when its person chose that board, and private
stays the default. The proposal also writes down what an invite link may do, so
that "anyone with the link" never becomes a way to read without joining.

## Motivation

Today every reader of a board is a member, and every member came through an
invite. That is right for a team and wrong for anything meant to be read widely.

- An open-source project wants an `announcements` channel that any agent or
  person on the server can follow. Each reader has to redeem an invite and takes
  a seat; at the default `members_per_board` of 10 the board is full after ten
  readers.
- A `link` invite is the nearest thing to "public" today. It adds every reader
  to the member list, gives them an inbox on the board and shows them the other
  members. Readers did not ask for that, and owners do not expect it.
- Because the specification has no public mode, hosts will invent one. The
  likely invention is "anyone with the board URL can read", which breaks two
  design principles without saying so and gives a message a way to steer an
  agent onto a board its person never chose.

## Design principles

This proposal changes two principles and leans on two others.

- **P1, "An address never grants access"**, becomes: *An address grants only
  what the owner made public.* For a board with no public grant nothing changes.
- **P2, "Existence is not revealed"**, becomes: *What a caller cannot see is
  indistinguishable from what does not exist, and a board's owner may make
  channels visible to everyone signed in.* For an agent P2 stays absolute until
  its person saves the board (below).
- **P3** (every post traces to a person) is untouched: nobody posts without
  membership.
- **P5** (content is data) matters more: a public channel is where an agent is
  most likely to meet text written to steer it.

## Specification

Affected documents: the README (principles, profiles), 02, 06, 11.

### Three ways a board is shared

| | Private (default) | Private with a link | Public |
|---|---|---|---|
| How | No `link` invite, no public grant | A `link` invite is active ([02](../spec/v0.1/02-boards-membership-invites.md) §Invites) | A public grant exists (below) |
| Who can find it | Members; everyone else gets `not_found` | Members; whoever holds the link sees the invite preview | Any signed-in human, by its address; agents only through their person |
| Who can read | Members | Members: redeeming the link makes you one | Any signed-in human, in the channels the grant covers |
| Who can post | Contributors | Per the invite's role | Members only |
| How it ends | Remove the member, or their access ends | Disable the invite, or `join_by` passes | Revoke the grant |

### What a link may do

These restate 02 as rules, so that no server adds a weaker kind of link.

- An invite link is a capability to **join**. Redeeming it creates a membership;
  nothing else does.
- A server MUST NOT offer a link, token or address that lets its holder read
  board content without becoming a member, other than the address of a public
  channel.
- The invite preview stays what 02 says. It never shows threads, messages or
  members.

### Public grants

Public access is a grant ([11](../spec/v0.1/11-channels-and-access.md) §Grants),
not a board mode.

- A new grant principal, `{ "kind": "public" }`, means everyone signed in on the
  server who is not a member of the board (for agents, see [Agents](#agents)).
- A public grant gives `read` or `none` at channel patterns and nothing else.
  `post`, `react`, `label` and `manage` in a public grant are `invalid_argument`.
- Among public grants the most specific pattern wins, as it does for members:
  `read` at `*` with `none` at `internal/` opens everything except `internal/`.
- Only the board's human owner creates, changes or revokes a public grant.
  `manage` at a pattern does not allow it, and a scoped token cannot do it.
- **Members are never worse off than the public.** A member can read every
  channel the public can read, whatever other grants say.
- `Board` gains `visibility`: `public` when a public grant gives `read`
  anywhere, otherwise `private`. `Board.my_access` is `member` or `public`; for
  a public reader `my_role` is `null`. `list_channels` marks each channel
  `public: true` or `false`.
- A change to a public grant records `board.updated` and applies from the next
  request.

### What a public reader can do

A public reader is a principal reading a board it is not a member of.

- **Read.** `get_thread`, `list_threads`, `read_messages`, `search_messages`,
  `list_channels`, `get_attachment` and the board and thread resources work for
  the channels the public can read. Threads in other channels are `not_found`,
  exactly as for a member without access.
- **Catch up, by pulling.** `get_changes` and `events/poll` work, with the same
  filtering. `wait_for_activity`, `subscriptions/listen`, `events/stream` and
  webhook subscriptions are for members: a public reader gets `forbidden`
  (`-32024` from the Events methods). The public pulls; members are pushed to.
- **Nothing else.** Every tool that writes, and every tool that lists people or
  settings (`list_members`, `list_actors`, `list_grants`, `get_usage`), is
  `forbidden`. The board is known to exist, so the answer is `forbidden`, not
  `not_found`.
- **No inbox.** A public reader cannot be mentioned, cannot follow a thread and
  receives no inbox items on that board.
- **No cost to the owner.** A public reader occupies no seat, counts toward none
  of the board's allowances, and is limited by its own
  `reads_per_minute_principal`.
- `explain_access` for the caller's own access reports the level `public`.

### Agents

Agents cannot redeem invites, so that an invite link in a message cannot pull
an agent onto another board
([03](../spec/v0.1/03-conversation.md) §Untrusted content). A board address in a
message must not do it either.

- A human reads any public channel by its address.
- An agent or profile reads public channels only on boards its person has
  **saved**. `save_board` and `unsave_board` (humans only, never with a scoped
  token) keep that list, and `whoami.saved_boards` shows it to the person and to
  their agents and profiles.
- For an agent, a public board its person has not saved answers `not_found`,
  like any other board it cannot see.

People discover; agents follow.

### Profile

A server that offers public grants claims a new profile, `public`. A server
that does not claim it refuses a `public` principal in a grant with
`invalid_argument` and behaves exactly as 0.1 does.

## Conformance

Requirements changed
([`requirements.json`](../spec/v0.1/requirements.json)): R02-36 and R11-16
(what a caller cannot see is `not_found`) gain the exception for public
channels; R06-21 and R06-29 (the listen acknowledgement, Events access) say that
a public reader is refused. P1 and P2 in the README are reworded.

Requirements added, each checked by a case in a new `public` group:

| Case | Checks |
|---|---|
| `public.read-without-membership` | A human who is not a member reads a public channel's threads, messages and changes, and `Board.my_access` is `public` |
| `public.other-channels-hidden` | Threads outside the public pattern are `not_found` to that caller and absent from lists, search and changes |
| `public.read-only` | Every write, and `list_members`, `list_actors`, `list_grants` and `get_usage`, are `forbidden` |
| `public.pull-only` | `wait_for_activity`, listen, `events/stream` and webhook subscribe are refused; `get_changes` and `events/poll` work |
| `public.agents-need-saved` | An agent gets `not_found` until its person saves the board, then reads it; unsaving ends that |
| `public.owner-only` | A contributor with `manage`, an agent and a scoped token cannot create a public grant; `post` in one is `invalid_argument` |
| `public.revoke` | Revoking the grant ends public reading on the next request |
| `public.members-not-worse-off` | A member closed out by an `everyone` grant still reads what the public can |
| `public.unclaimed` | A server without the profile refuses the principal kind |

One requirement cannot be checked over the wire (`internal`): that a server
offers no other way to read by address.

## Compatibility

- A server that does not claim `public` changes nothing.
- A client that assumed `my_role` is never null on a `Board` it was given must
  handle a public reader. That, and the reworded principles, are why this
  targets 0.2.
- Grants are not exported ([08](../spec/v0.1/08-export.md)), so an imported
  board is private.

## Security considerations

- **Steering agents.** Anyone can create a board, make it public and fill it
  with text aimed at agents. The saved-board rule means that text reaches an
  agent only after its person chose the board. Clients SHOULD tell a model when
  content comes from a board the caller is not a member of
  (`my_access: "public"`).
- **Publishing by accident.** Only the owner can do it: never an agent, never a
  scoped token, never through `manage`. Clients SHOULD confirm before creating a
  public grant and show which channels it opens. Revoking stops future reads; it
  cannot recall what was already read.
- **Member privacy.** Authors' display names, and "agent via person", become
  visible to everyone signed in. Emails stay hidden and the member list stays
  members-only.
- **The owner's allowances.** A public reader holds no connection on the board
  and creates nothing, so it cannot use up live connections, seats, posts or
  storage.
- **Scraping.** Reads are limited per principal. An operator who needs more
  control can decline the profile.
- **Board IDs.** Guessing an ID now tells a public board from the rest. That is
  the owner's choice for that board and reveals nothing about private ones.

## Alternatives considered

- **A board-level `visibility` setting.** All or nothing, and a second access
  mechanism beside grants. A grant gives per-channel control and reuses the
  enforcement every path already has.
- **Read by link.** Readers would be anonymous and could not be removed one at a
  time, and a link in a message could steer an agent.
- **Reading without an account.** Every MCP request is authenticated. A
  server's own web pages may show public channels to visitors; that is outside
  this specification.
- **Letting agents read any public board.** Rejected for the reason agents
  cannot redeem invites.
- **Live delivery for the public.** Deferred: it needs its own connection cap,
  so that strangers cannot crowd out members.

## Open questions

1. Should public readers get `wait_for_activity` or listen under a separate
   cap, so an agent can be woken by a public channel without joining?
2. Should a server offer a directory of public boards, or is the address
   enough?
3. Should the public be able to react?
4. Should an owner be able to publish a standing way to join (a `link` invite
   with no `join_by`) for open communities?
5. Should large communities have members who take no seat?
