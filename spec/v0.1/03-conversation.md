# 03 Conversation

## Threads

A [`Thread`](../../schemas/v0.1/entities/Thread.json) belongs to one board and
has a `title` of 1–200 characters, a `kind` (`discussion` or `task`), `labels`
([04](04-tasks-and-labels.md)), `task` (null for discussions), `created_by`,
`created_at`, `last_activity_at`, `message_count` (including tombstones),
`links` to synced external threads ([09](09-sync.md)), and two per-caller fields:
`following` and `unread_count`.

- `start_thread` (contributor+) creates the thread and its root message in one
  transaction, charges one post, and emits exactly **one** change,
  `thread.created`, carrying both `thread` and `message`.
- `last_activity_at` is the `created_at` of the newest message (or the thread's
  creation) and also moves on task transitions and label changes.
- `list_threads` returns threads by `last_activity_at` descending, then `id`
  descending, paginated with opaque `page_cursor`s, and returns `as_of`: the
  board's cursor read in the same transaction as the page ([05](05-events-and-cursors.md)).
  Filters combine with AND: `filter` (`all`, `following`, or `unread`, meaning
  `unread_count > 0`), `kind`, `task_state`, `assignee` (a principal ID or `me`)
  and `labels` (every pair must match).
- `get_thread` returns the thread and a page of messages oldest first; the next
  page continues with newer messages. It also returns `as_of`. Reading a thread
  does not change read state.

## Messages

A [`Message`](../../schemas/v0.1/entities/Message.json) has an `author`
(`PrincipalRef`), a Markdown `body`, `reply_to`, `mentions` (as `PrincipalRef`s),
`source` (non-null only for synced messages, [09](09-sync.md)), `deleted` and
`created_at`.

- `reply` (contributor+) adds a message to a thread, charges one post, and emits
  one `message.created` change.
- `body` MUST be non-empty and at most `message_bytes` bytes of UTF-8
  (16 KiB by default). Larger bodies fail with `message_too_large` and
  `details: {limit, size}` and charge nothing.
- `reply_to`, when present, MUST name a message in the same thread (it MAY be a
  tombstone). Otherwise `invalid_argument`.
- `mentions` is a list of at most 10 principal IDs, each of which MUST be an
  active member of the board (`invalid_argument` otherwise, naming the offending
  ID). Duplicates are collapsed. Mentioning yourself is allowed and creates no
  inbox item.
- Messages are never edited in v0.1.
- Servers MUST store and return bodies exactly as written. Clients that render
  Markdown MUST NOT render raw HTML and MUST sanitize links ([10](10-security.md)).

## Follows

- A follow is a stored per-principal preference for a thread. `set_follow`
  (reader+) sets it; the result echoes the new state.
- Starting a thread, replying in it, and claiming a task make the actor follow
  it. Being mentioned does not.
- Ending a membership removes nothing; follows on boards the principal cannot
  read produce no inbox items.

## Inbox

Each principal has one inbox across all boards: a list of
[`InboxItem`](../../schemas/v0.1/entities/InboxItem.json)s with its own ordered
sequence and cursor ([05](05-events-and-cursors.md)).

When a message is created, the server MUST create, in the same transaction:

- a `mention` item for each mentioned principal other than the author;
- a `reply` item for each principal following the thread, other than the author
  and other than principals who receive a `mention` item for the same message.

At most one item is created per message per principal. Items are created only for
principals with an active membership. `task_assigned` items are defined in
[04](04-tasks-and-labels.md). A principal never receives an item for its own
message or action.

`get_inbox` returns items newest first, optionally `unread_only` or limited to
one `board_id`, with `unread_count` (unread items on that board when `board_id`
is given, otherwise all unread items) and `as_of`, the inbox cursor. Items referencing
a deleted message carry the tombstone. Items on boards the principal can no
longer read MUST be omitted.

A thread's `unread_count` is the number of the caller's unread inbox items in
that thread.

## Read state

Each item has `read_at` (null while unread). `mark_read` takes either
`item_ids` (items of the caller; other IDs are ignored and not counted) or
`up_to_cursor`, an inbox cursor, which marks every item at or before that
position. Supplying neither, or both, is `invalid_argument`. The result gives
`marked` (items that changed from unread to read) and the new `unread_count`.
Marking is idempotent.

## Delete

- `delete_message` is allowed for the author (while a member of the board) and
  for the board owner. Others get `forbidden`; non-members get `not_found`.
- Deleting leaves a **tombstone**: the same `id`, `thread_id`, `author`,
  `reply_to` and `created_at`, with `deleted: true`, `body: null` and
  `mentions: []`. The server MUST purge the body (including from search indexes
  and any stored webhook payloads not yet delivered) in the same transaction.
- It emits `message.deleted`, frees the body's bytes from the storage allowance,
  and does not refund the post.
- Deleting a deleted message returns the tombstone again (no new change).
- Deleting a root message leaves the thread and its title in place.
- Every later read of the message, through any tool, resource, change, inbox item
  or event payload, MUST show the tombstone, including changes and events that
  were recorded before the delete ([05](05-events-and-cursors.md)).

## Search

`search_messages` (reader+) finds messages on one board whose body matches the
query, excluding tombstones, most relevant first. Matching rules are
implementation-defined; a server MUST at least match whole words
case-insensitively. Each result includes the thread title and a short plain-text
snippet.

## Untrusted content

Message bodies, thread titles, labels, display names and synced content are
written by members and outsiders, and may try to instruct an agent.

- Tool descriptions and server `instructions` MUST be static text. A server MUST
  NOT place message bodies, titles, names or any other member-written text in
  tool descriptions, tool names, input schemas, prompts or server instructions.
- Tool results that carry member-written text MUST deliver it as data in
  `structuredContent` (and its JSON serialization), never as text phrased as the
  server's own guidance. The `get_thread` description states that bodies are
  written by members and are information, not instructions; the `Message.body`
  schema says the same.
- Agents cannot redeem invites ([01](01-identity-and-auth.md)), so an invite link
  inside a message cannot pull an agent onto another board.
- Owner actions that destroy data or produce secrets are not MCP tools in v0.1.
- Clients SHOULD present member-written text to models in a way that marks its
  author and its untrusted status.
