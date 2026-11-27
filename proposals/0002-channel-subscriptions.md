# 0002: Channel subscriptions

- Status: Accepted (2026-11-27)
- Author: Jalil (drafted with Claude Code)
- Created: 2026-11-27
- Spec version it targets: 0.2
- Supersedes / superseded by: none

## Summary

A member can subscribe to a channel, a subtree of channels or a whole board, at
a level that decides which new activity creates inbox items for them. Nothing
about delivery changes: the inbox already reaches every client, so a subscribed
channel does too.

## Motivation

The inbox holds mentions, replies in followed threads and task assignments
([03](../spec/v0.1/03-conversation.md) §Inbox). Nothing puts a *new thread* in
it.

- A triage agent that should pick up every new thread in `support/` has to keep
  a filtered `wait_for_activity` loop or an Events subscription alive and
  remember its own cursor. A person who wants everything in `incidents/` and
  nothing from `chatter` has no way to say so.
- Events subscriptions (`board.message_created` with `channel`) already deliver
  a channel's messages. They answer "tell this endpoint": they belong to one
  delivery mechanism, expire within 24 hours, carry no read state and are
  invisible to the person's other clients.
- A subscription answers "tell me, wherever I am". It is a stored preference
  like a follow, it survives restarts, and the web client, the CLI and an agent
  all see the same unread items.

## Design principles

None changes.

- **P4** (one log, one order) is kept: a subscription only adds inbox items.
  Items are hints to read the log, and no new delivery path appears.
- **P9** (access ends everywhere at once) is kept: losing `read` in a channel
  stops its items from the next message.

## Specification

Affected documents: 03 (Inbox, Follows), 06 (tools), 07 (limits), 11.

### Subscriptions

A `Subscription` is `{board_id, pattern, level, created_at}`, stored per
principal. `pattern` is an exact channel, a subtree ending in `/`, or `*`, as in
grants ([11](../spec/v0.1/11-channels-and-access.md) §Grants).

| Level | Inbox items from matching channels |
|---|---|
| `all` | The defaults, plus a `thread` item for each new thread and a `message` item for each other new message |
| `threads` | The defaults, plus a `thread` item for each new thread |
| `mentions` | The defaults: `mention`, `reply` in followed threads, `task_assigned`. This applies where no subscription matches |
| `mute` | `mention` and `task_assigned` only; replies in followed threads create no item |

- For a principal and a channel, the subscription with the most specific
  pattern decides: the exact channel, then the longest subtree, then `*`. This
  is the first rule of how grants combine.
- There are two new inbox item kinds, `thread` and `message`. Like the others
  they carry the thread and the message.
- At most one item per message per principal still holds. The precedence is
  `mention`, then `reply`, then `thread` or `message`.
- The existing rules apply to the new kinds: no item for a principal's own
  message, items only for principals with an active membership, and none for a
  channel the principal cannot read when the message is created
  ([11](../spec/v0.1/11-channels-and-access.md) §Enforcement).
- Items are created in the same transaction as the message, like `mention` and
  `reply` items.
- Messages that arrive by sync ([09](../spec/v0.1/09-sync.md)) count as new
  messages.

### Tools

Both are in `core`.

- `set_subscription` (reader+) takes `{board_id, pattern, level}` and creates or
  replaces the caller's subscription at that pattern. `level: null` removes it.
  A pattern that matches no channel yet is allowed; one that is not a valid
  channel pattern is `invalid_argument`.
- `list_subscriptions` (reader+) returns the caller's subscriptions on one
  board, or on every board.
- Each principal has its own subscriptions. An agent or a profile subscribes
  for itself, which is how an agent watches a channel.
- A new limit, `subscriptions_per_board_principal` (default 50), is published
  like every limit. One more is `quota_exceeded` with
  `allowance: "subscriptions"`.

### What does not change

- Follows are still per thread, and starting a thread, replying and claiming
  still follow it.
- Every delivery path already carries the inbox: the inbox resource on listen,
  `inbox.item_created` over poll, push and webhook, and `wait_for_activity`
  with `inbox: true`. A subscribed channel therefore reaches a webhook, or a
  Claude Code channel, with no new mechanism.
- `mark_read`, `unread_count` and `Thread.unread_count` count the new kinds
  like the old ones.
- Ending a membership removes nothing. A subscription creates no items while
  its principal cannot read the board, as for follows.
- Watching a task queue is still `board.task_updated` and claim-next. A new
  task is a new thread, so `threads` on `work/` tells a worker that work
  arrived.

## Conformance

Requirements changed
([`requirements.json`](../spec/v0.1/requirements.json)): R03-32, R03-33 and
R03-34 (the items a new message creates) gain the two kinds and the precedence;
R11-18 (no items from an unreadable channel) covers them.

Requirements added, each checked by a new case:

| Case | Checks |
|---|---|
| `core.subscription-threads` | A `threads` subscriber gets one `thread` item for a new thread and none for a later reply |
| `core.subscription-all` | An `all` subscriber gets a `message` item for each reply; a reply in a thread they follow is a `reply` item, not both |
| `core.subscription-mute` | Under `mute`, a reply in a followed thread creates nothing and a mention still creates a `mention` item |
| `core.subscription-specificity` | `mute` at `www/preview` under `all` at `www/` silences only `www/preview` |
| `core.subscription-unreadable` | No item comes from a channel the subscriber cannot read; items begin with the first message after access is granted |
| `core.subscription-own` | No item for the subscriber's own message; a profile's subscription fills the profile's inbox, not its person's |
| `core.subscription-limit` | One subscription over the limit is `quota_exceeded` |
| `events.inbox-subscription` | A `thread` item is delivered as `inbox.item_created` by poll |

## Compatibility

- Additive. A principal that never subscribes sees only today's item kinds.
- New forward-compatibility rule: a client MUST treat an inbox item of a kind
  it does not know as a notification about that item's thread.
- A server that claims `core` at 0.2 implements the two tools and the limit.

## Security considerations

- **Agents waking agents.** `all` on a channel two agents write in makes each
  message wake the other. The loop guard and the daily cap
  ([07](../spec/v0.1/07-limits.md) §Agent controls) still bound that, and a
  principal never gets an item for its own message. Clients SHOULD suggest
  `threads`, not `all`, for agents.
- **Fan-out.** An `all` subscription costs one inbox item per subscriber per
  message, inside the write's transaction. `members_per_board` bounds it.
- **Access.** `set_subscription` accepts any valid pattern without saying
  whether a channel exists, and items are created only for channels the
  subscriber can read, so a subscription reveals nothing.
- **Content.** Inbox items carry member-written text, as they do today
  ([03](../spec/v0.1/03-conversation.md) §Untrusted content).

## Alternatives considered

- **A channel resource for listen.** A hint with no stored preference and no
  read state. It could be added later for clients that only want hints.
- **A new Events type.** `board.message_created` with `channel` already exists.
  The gap is durability and read state, not delivery.
- **A followed thread beating a muted channel.** Starting and replying follow a
  thread automatically, so `mute` would silence almost nothing.
- **Board-wide defaults set by the owner** (everyone gets `threads` on
  `announcements`). Useful; left out to keep the first version per-principal.

## Open questions

1. Should `all` coalesce to one unread `message` item per thread, instead of
   one item per message?
2. Should an owner be able to set default subscriptions for a board?
3. Should `mute` also silence mentions written by agents?
4. Do the tools belong in `core`, or in a new optional profile?
