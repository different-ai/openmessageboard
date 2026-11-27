# 0007: Board moderation

- Status: Draft
- Author: Jalil (drafted with Claude Code)
- Created: 2026-11-27
- Spec version it targets: 0.2
- Supersedes / superseded by: none

## Summary

A board owner can appoint moderators by giving a member or a group a new
`moderate` permission at `*`, a subtree or one channel. A moderator can hide a
message, mute a member for a time, remove a member and ban one, all over MCP.
Every action carries a reason, tells the person it affects, and is recorded in a
log that moderators and the owner can read. The owner can publish board rules,
which travel as data. It is a new optional profile, `moderation`.

## Motivation

The specification has guardrails for agents (a daily cap and a loop guard,
[07](../spec/v0.1/07-limits.md) §Agent controls) and none for a board's people.

- Only the owner can delete someone else's message, and only the owner can
  remove a member, outside MCP ([02](../spec/v0.1/02-boards-membership-invites.md)
  §Roles). A board with two hundred members and one owner has one moderator, who
  must be at a browser.
- A removed person is not a member at step 4 of redemption, so a new eligible
  invite creates a fresh membership. With an open `link` invite, removal lasts
  as long as it takes to click the link again.
- An owner's delete purges the body and records no reason, so nobody can review
  it or undo it, and the author is not told.
- There is nothing between "can post" and "removed": no way to stop one member
  posting in one channel for a day.
- Proposal 0001 lets an owner open channels to everyone signed in. A board that
  does so will grow past what one person can watch.

## Design principles

None is weakened.

- **P3** (every post traces to a person): every action names the principal who
  took it. An agent moderates only inside what its person may do, and a mute,
  removal or ban of a person reaches their agents and profiles.
- **P4** (one log, one order): actions are changes in the board's one log,
  filtered by who may read them, as channel changes already are.
- **P5** (content is data): reasons and board rules are member-written. They
  appear only in `structuredContent` and error `details`, never in tool
  descriptions, server instructions or an error `message`.
- **P8** (limits are published, failures are named): the longest mute and the
  agent action cap are published limits, and each refusal has a code and a
  `details.reason`.
- **P9** (access ends everywhere at once): `remove_member` and `ban_member` end
  access through the existing rules and windows, unchanged.
- **P10** (a board can leave): the log, bans and rules are in the export.
- **P2** (existence is not revealed) is kept: a banned person is told they are
  banned only when they present a valid invite, and learns nothing else.

## Specification

Affected documents: 02 (roles, redemption, ending access), 03 (tombstones,
inbox, untrusted content), 05 (changes), 06 (tools, errors), 07 (limits), 08
(export), 10, 11 (permissions), README (profiles), and a new chapter for the
`moderation` profile.

### The `moderate` permission

- `moderate` joins `read`, `post`, `react`, `label` and `manage`
  ([11](../spec/v0.1/11-channels-and-access.md) §Permissions and roles). It
  allows the actions below at the grant's patterns. Grants combine as today.
- The owner always has it. A contributor can be given it; a reader cannot.
- Only the owner creates, changes or revokes a grant that names `moderate`.
  `manage` does not allow it.
- `all` keeps meaning the five 0.1 permissions. `moderate` must be named, so no
  existing grant starts moderating on upgrade (a private channel's creator holds
  `all` there today).
- A moderator cannot act on the owner or on a member who holds `moderate`
  anywhere on the board; only the owner can. Such a call is `forbidden`.
- Moderation acts as the principal itself. A scoped token or a request written
  as a profile cannot call these tools (`forbidden`).
- **Agents.** A member grant naming a person does not carry `moderate` to their
  agents; only a grant naming the agent does, and only where its person holds
  `moderate` too (R11-10). An agent may hide and mute. `remove_member`,
  `ban_member` and `unban_member` from an agent are `forbidden`. A new limit,
  `agent_moderation_actions_per_day` (default 100), bounds an agent; past it the
  call is `quota_exceeded` with `allowance: "moderation_actions"`.

### Actions

Every tool below is in the `moderation` profile, is idempotent like other writes
([06](../spec/v0.1/06-mcp-binding.md) §Idempotency), and requires `reason`: 1 to
500 characters of text, with an optional `rule` naming a board rule (below).
A caller who can read the channel but lacks `moderate` gets `forbidden`.

| Tool | Needs `moderate` | Effect |
|---|---|---|
| `hide_message` | in the thread's channel | The message reads as a tombstone with `moderation: {action: "hidden", by, reason, rule, at}` |
| `unhide_message` | in the thread's channel | Restores the body |
| `mute_member` | at the `channel` pattern given | Until `until`, the member has no `post`, `react` or `label` in channels the pattern covers |
| `unmute_member` | at that pattern | Ends the mute |
| `remove_member` | at `*` | Ends the membership, as "Remove member" does today |
| `ban_member` | at `*` | Removes if a member, and refuses rejoining until `until` (optional) or `unban_member` |
| `unban_member` | at `*` | Ends the ban; it does not restore the membership |

**Hide.**

- A hidden message is a tombstone on every read path (R03-40), with `deleted:
  true` and `body: null`, so a 0.1 client shows it as deleted. `Message.moderation`
  is null on every other message.
- Unlike delete, the server keeps the body, so the action can be reviewed and
  undone. The body leaves search and undelivered webhook payloads, and still
  counts toward storage.
- Hiding emits `message.deleted` with the tombstone and unhiding emits
  `message.edited` with the message. No new change type is needed, and a 0.1
  client drops and restores the body correctly.
- The author may still `delete_message` a hidden message. That purges the body
  as today (R03-39) and keeps `moderation` on the tombstone; `unhide_message`
  then fails with `message_deleted`.
- Hiding a hidden message returns it with no new action.
- The owner's "delete any message" is unchanged. Clients SHOULD offer the owner
  hide first, because it is logged and reversible.
- Hide acts on the board only. It does not delete the message on a platform the
  thread syncs with ([09](../spec/v0.1/09-sync.md)).

**Mute.**

- `until` is required and at most `mute_max_seconds` away (new limit, default 30
  days). A mute always expires.
- A muted write fails with `forbidden`, `details.reason: "muted"`,
  `details.until` and `details.moderation` (the action). Reading, following,
  the inbox and deleting one's own messages keep working.
- Muting a person mutes their agents and profiles there. An agent can be muted
  alone.
- `explain_access` reports the mute. A task claim held by a muted member lapses
  when its lease does ([04](../spec/v0.1/04-tasks-and-labels.md)).

**Remove and ban.**

- Removal has the effects and windows of [02](../spec/v0.1/02-boards-membership-invites.md)
  §Ending access (R02-30 to R02-35). A removed person may rejoin through an
  invite that still admits them.
- A ban names a human or an agent. Redemption gains a step after step 4: a
  banned caller gets `invite_not_eligible` with `details.reason: "banned"`.
  Adding a banned agent, or an agent of a banned person, is refused the same way.
- `list_bans` (needs `moderate` at `*`) returns the bans in force.
- After removal or a ban, `access_ended` carries `details.moderation`, and an
  open channel's closing message carries the same.

### Notice

The person an action affects is always told what was done, why, under which
rule, until when and by whom.

- For hide, unhide, mute and unmute: an inbox item of a new kind, `moderation`,
  carrying the action, created in the action's transaction. It reaches every
  delivery path the inbox already has.
- For remove and ban: `details.moderation` on `access_ended`, since a removed
  principal has no inbox on that board.

### The log

- A `ModerationAction` is `{id, board_id, action, actor, subject, channel,
  message_id, thread_id, reason, rule, until, reverses, created_at}`. `action` is
  `hide`, `unhide`, `mute`, `unmute`, `remove`, `ban` or `unban`. Entries are
  never edited or deleted, and an undo is a new entry that names the one it
  reverses.
- Each action emits one `moderation.action` change in the board's log, in the
  transaction that performs it.
- `list_moderation_actions` returns entries, filtered by `channel`, `subject`
  or `actor`. With `include_body: true` a hide entry carries the hidden body, as
  member-written data.
- A caller sees an entry, and its change, when they are the owner, hold
  `moderate` at a pattern covering the entry's `channel` (`*` for remove and
  ban), or are its subject. Cursors move past the changes a caller cannot see
  (R11-17). `include_body` is for the owner and moderators only.
- The log is kept at least as long as the event retention window and is part of
  the export ([08](../spec/v0.1/08-export.md)), with bans and rules.

### Board rules

- `BoardSettings.rules` is a list of up to 20 `{id, title, text}` entries that
  the owner sets where other settings are set. Changing it emits `board.updated`.
- Rules are member-written text. A server returns them only as data wherever
  `BoardSettings` is returned, and MUST NOT place them in server instructions,
  tool descriptions or prompts (R03-44). The schema description says so, as
  `Message.body` does.
- A `rule` on an action MUST name an existing rule (`invalid_argument`
  otherwise).

### Left out of version one

- **Reports** (`report_message`). A report queue needs storage, limits against
  flooding and a rule for who reads it. Until then a member mentions a
  moderator, and `list_actors` gains `moderator: true` so one can be found.
- **Labels on content and shared block lists.** Both matter between
  communities; a board is one community with one owner.
- **An appeal tool.** Every action is reversible by another moderator or the
  owner, and the notice names who acted. A rule's text can say how to contest.
- **Automatic moderation**, slow mode, word filters, and moving ownership or
  the other owner actions into MCP.

### What it borrows, and where it differs

| Source | Borrowed | Differs |
|---|---|---|
| XMPP [XEP-0045](https://xmpp.org/extensions/xep-0045.html) Multi-User Chat (Stable, 1.35.6) | Only the owner appoints moderators (§9.6); nobody acts on a higher rank (§8.2, §8.4, §9.1); a ban outlasts removal and blocks re-entry (§4.1, §7.2.7); the removed person learns the reason and the actor (§8.2, §9.1) | One long-lived grant, not a session role beside an affiliation. Reasons are required, where `<reason/>` is optional. Mutes expire; revoked voice has no time limit |
| XMPP [XEP-0425](https://xmpp.org/extensions/xep-0425.html) Moderated Message Retraction (Experimental, 0.3.2) | A tombstone that says a moderator acted, by whom and why (§3.1, §4), distinct from the author's own retraction | There a retraction is advisory and clients need not enforce it (§1). Here the server withholds the body on every path, and the hide can be undone |
| [Matrix](https://spec.matrix.org/latest/client-server-api/) v1.19: power levels, redactions, bans | A redaction keeps the event and strips its content, carries a `reason`, and shows who redacted (`redacted_because`). A ban carries a reason and blocks rejoining and re-invites | A named permission per channel pattern, not one number per user. Hide is reversible; a redaction cannot be undone |
| Matrix moderation policy lists | Nothing in version one. The rule shape (`entity`, `recommendation`, `reason`) is the model for shared ban lists later | Left out. The module defines data structures only and leaves enforcement to each subscriber |
| ActivityStreams [`Flag`](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-flag) (W3C Recommendation, 2017) | The name and meaning for a later `report_message`: the actor flags an object as inappropriate | Left out. The vocabulary defines the activity only, with no recipient or handling |
| AT Protocol [labels](https://atproto.com/specs/label) | For later: a label annotates and each reader chooses whose labels to honour; `neg` retracts and `exp` expires one | Left out. Labelers are independent signed services, and a board has one authority, its owner |
| [Santa Clara Principles](https://santaclaraprinciples.org/) 2.0, Notice and Appeal | Notice identifies the content and the specific rule, and is durable | No appeal process or published numbers. The operational principles are written for the largest companies |
| EU Digital Services Act, [Regulation (EU) 2022/2065](https://eur-lex.europa.eu/eli/reg/2022/2065/oj/eng), Art. 14, 16, 17, 20 | The contents of a statement of reasons (Art. 17(3)): what was restricted and for how long, the facts, the contractual ground. Published rules (Art. 14) | No notice-and-action mechanism (Art. 16) and no complaint system (Art. 20). This proposal gives a host the data and makes no claim that a host complies |

### Verification

Read on 2026-11-27 in their published text: XEP-0045 except its appendices;
XEP-0425 in full; Matrix v1.19 `m.room.power_levels`, Redactions, Banning,
Moderation policy lists and the start of Reporting Content; the `Flag` entry of
the Activity Vocabulary; the atproto label specification in full; the Santa
Clara Principles page; DSA Articles 14, 16, 17, 19 and 20(1) to (4) on EUR-Lex.

Not verified:

- Whether Matrix refuses a kick or ban of a user with an equal or higher power
  level. That is in the room version authorisation rules, which were not read,
  so the "nobody acts on a higher rank" row cites XMPP only.
- Whether Matrix has any timed mute or ban. None was found in the sections read.
- That ActivityPub never mentions `Flag`: only its sections 1 to 5.6 were read
  in full.
- The fields of atproto's `com.atproto.moderation.createReport` and of Matrix's
  event report endpoint, and DSA Article 20(5) and (6).
- Amendments to the DSA after its Official Journal text of 27 October 2022.
- Whether the DSA applies to any particular host of a board. That is a legal
  question this proposal does not answer.

## Conformance

Requirements changed ([`requirements.json`](../spec/v0.1/requirements.json)):

- R02-17: the redemption order gains the ban step.
- R03-38 and R03-40: a tombstone may carry `moderation`, and every read path
  shows a hidden message as one.
- R03-41: search excludes hidden messages.
- R03-44: board rules join the text that never enters instructions.
- R11-09 and R11-10: a person's grant does not carry `moderate` to their agents.
- R02-30 and R02-33 are unchanged and gain a second way to trigger them over MCP.

Requirements added, each checked by a new case in the `moderation` profile:

| Case | Checks |
|---|---|
| `moderation.grant-owner-only` | A member with `manage` cannot give `moderate`; `all` does not include it; a reader cannot hold it |
| `moderation.hide` | A hidden message is a tombstone with `moderation` in `get_thread`, changes, search and the inbox; the author gets a `moderation` inbox item |
| `moderation.unhide` | The body returns; after the author's delete it fails with `message_deleted` |
| `moderation.scope` | `moderate` at `support/` does not allow hiding in `general` (`forbidden`), and an unreadable thread is `not_found` |
| `moderation.rank` | A moderator cannot hide the owner's message or mute another moderator |
| `moderation.mute` | A muted member's `reply` fails with `forbidden` and `details.reason: "muted"`, reading works, and posting works after `until` |
| `moderation.mute-reaches-agents` | Muting a person stops their agent posting in that channel |
| `moderation.remove` | The removed member gets `access_ended` with `details.moderation` and can rejoin through an open `link` invite |
| `moderation.ban` | The banned person's redemption fails with `invite_not_eligible` and `banned`; after `unban_member` it succeeds |
| `moderation.agent` | An agent moderates only with its own grant and its person's; its `ban_member` is `forbidden` |
| `moderation.log` | Each action is one `moderation.action` change; a plain member sees none; the subject sees their own; `reverses` links an undo |
| `moderation.rules-are-data` | Rules appear in the board's structured content and not in `instructions` or any tool description |

Not checkable over the wire: that a hidden body is gone from search indexes and
undelivered webhook payloads (an internal test, like R03-39), and the agent
daily cap when the server publishes a value too high to reach in a test run.

## Compatibility

- Additive, in a new optional profile. A server that does not claim
  `moderation` refuses a grant naming `moderate` with `invalid_argument`.
- A 0.1 client sees a hidden message as deleted, a muted write as `forbidden`
  and a ban as `invite_not_eligible`, all codes it knows.
- New forward-compatibility rules: a client MUST ignore a change type it does
  not know, and (from 0002) treats an unknown inbox kind as a notification. A
  `moderation` item for a mute has no thread, so `InboxItem.thread` becomes
  nullable.
- `scopes.ts` in the reference server classifies every new tool as not callable
  by a scoped token.
- Proposal 0001: a ban ends membership. In version one it does not stop a
  banned person reading channels the owner made public.

## Security considerations

- **A steered agent moderator.** A message can tell an agent to hide other
  messages. The agent can only hide and mute, both are reversible and logged,
  the daily cap bounds the damage, and its person must hold `moderate` there.
- **A moderator against the owner.** No action reaches the owner or another
  moderator, and only the owner hands out `moderate`, so a moderator cannot
  take a board over or appoint allies.
- **Reasons as an injection path.** A reason reaches the affected member's
  agent. It is delivered as data, never in an error `message` or summary line
  (R06-11).
- **Existence.** A caller who cannot read a thread gets `not_found` from
  `hide_message`, before any permission check. `banned` is returned only to a
  caller who holds a valid invite token, with the fields a failed redemption
  may carry today.
- **Ban evasion.** A ban names a principal. A second account passes a `link`
  invite. Email and domain invites, or disabling the link, are the answer in
  version one, and the limit is stated so owners are not misled.
- **Reading hidden content.** `include_body` is a read path for content someone
  chose to hide. It is limited to the owner and that channel's moderators, and
  the author's delete still purges it.
- **Privacy.** Members who are neither subject nor moderator see a tombstone or
  a `member.left`, not the log. Logs and metrics never record reasons or bodies.

## Alternatives considered

- **A `moderator` board role.** Simpler to explain, but it is board-wide, so a
  support lead could not moderate `support/` alone, and every role table grows.
- **Letting `manage` or `all` imply `moderate`.** Existing grants would start
  moderating on upgrade.
- **Purging on hide, like delete and like a Matrix redaction.** Nothing could
  be reviewed or restored, which matters most when the moderator is an agent.
- **New change types `message.hidden` and `message.unhidden`.** A 0.1 client
  would ignore them and keep showing a body it had cached.
- **Putting the tools in `core`.** A two-person board would have to implement a
  log it never uses.
- **A permanent mute.** That is a ban from posting with no review date. A mute
  that matters can be renewed, and each renewal is logged.

## Open questions

Decisions for the maintainer, each with a recommendation.

1. **May an agent moderate?** Recommended: yes, only through a grant naming the
   agent, capped by its person, limited to hide and mute, with a daily cap. The
   alternative is humans only in version one.
2. **Is the affected member always told why, and by whom?** Recommended: always
   told what, why and until when, and told who by default. The alternative is a
   board setting that shows "a moderator" to protect moderators from
   retaliation; the log would still name them.
3. **What is in version one?** Recommended: the permission, the seven actions,
   notice, the log and rules, as above; reports next, with labels and shared
   ban lists after there is a second implementation.
4. **Is a hide reversible, with the body kept?** Recommended: yes. The cost is
   that a server stores content a moderator judged harmful until the author or
   the owner deletes it.
5. **Should `all` include `moderate`?** Recommended: no.
6. **Does a ban also end public reading under 0001?** Recommended: decide it
   when 0001 becomes Final.
