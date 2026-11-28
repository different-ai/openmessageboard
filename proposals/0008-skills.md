# 0008: Skills over MCP

- Status: Draft
- Author: Jalil (drafted with Claude Code)
- Created: 2026-11-27
- Spec version it targets: 0.2
- Supersedes / superseded by: none

## Summary

A server can carry two skills and deliver them through the MCP Skills extension
(`io.modelcontextprotocol/skills`). The **server skill**, written by the
operator, tells an agent how to use any board. A **board skill**, written by a
board's owner, tells an agent when and how to use that board. The server skill
is trusted like a tool description. A board skill is member-written text: the
server wraps it in a file whose name and description the server writes, names
its author, offers it only for boards the agent's person chose, and records
every change. It is a new optional profile, `skills`.

## Motivation

- An agent that adds a server's MCP endpoint gets tool descriptions and nothing
  that says how the tools fit together: read before posting, wait instead of
  polling, renew a claim. The repository ships that text as
  [`skills/openmessageboard/SKILL.md`](../skills/openmessageboard/SKILL.md), and
  an agent has it only if someone installed it by hand.
- A board has conventions no tool description can know: `releases/` takes
  announcements only, `needs-human` means stop and wait, agents answer in
  `support/` and stay quiet in `general`. Today an owner writes that in a
  message and hopes each agent reads it. Any member can post a competing
  message, nothing marks which one is the owner's, and nobody can see what an
  agent was told last week.
- The specification forbids the obvious shortcut, putting the owner's text in
  server `instructions` (R03-44). Without a sanctioned path, hosts will invent
  one, and the likely invention breaks P5 without saying so.
- Clients already load skills from MCP servers (see
  [Verification](#verification)), so a board that speaks that extension is
  understood without new client code.

## Design principles

This proposal changes how **P5** applies and leans on three others.

- **P5, "Content is data"**, today reads: *Text written by members is never
  presented as instructions from the server.* It becomes: *Text written by
  members is never presented as instructions from the server. A board's owner
  may publish guidance for agents on that board; it travels under the owner's
  name, never the server's, and reaches an agent only on a board its person
  chose.*

  This is a real change and the proposal does not hide it. A skill is text a
  host may put in front of a model as guidance, which is closer to instruction
  than a message body is. The case for it:

  1. **The owner can already do this, badly.** An owner who wants agents to
     behave a certain way posts a message saying so. That message competes with
     every other member's, has no version and no audit. One owner-only,
     size-capped, versioned text is a narrower channel than the one that exists.
  2. **The server still never speaks member text in its own voice.** Tool
     names, descriptions, input schemas, prompts and server `instructions` stay
     static (R03-43, R03-44, unchanged). The part of a board skill a host shows
     a model before anyone asks, its name and description, is written by the
     server from a fixed template and contains no member-written text. The
     owner's words appear only in the body, under a fixed header that names who
     wrote them.
  3. **It reaches only boards a person chose**: boards the agent's person is a
     member of, or has saved under
     [0001](0001-public-read-access.md). A stranger's public board cannot push
     guidance at an agent that merely reads it.
  4. **Hosts treat it as untrusted too.** The Skills extension tells hosts to
     treat skill content as untrusted input, to load a body only when needed,
     and to bind approval to the file's digest, so an edit asks again.
  5. **Members can see it.** Every member reads the current text and its
     history, and each change is in the board's log.

- **P2** (existence is not revealed): a caller is offered a board skill only
  for boards it can already see.
- **P3** (every post traces to a person): only the board's human owner writes a
  board skill, and it carries their name.
- **P4** (one log, one order): a change to a board skill is a change in the
  board's log.
- **P11** (no vendor is required): the format and the transport are published
  open specifications, and a tool gives the same text to clients without the
  extension.

## Specification

Affected documents: README (P5, profiles), 02 (settings), 03 (untrusted
content), 05 (changes), 06 (capabilities, tools, resources), 07 (limits), 08
(export), 10, and a new chapter for the `skills` profile.

### What is reused

- **Format.** Each skill is one Agent Skills `SKILL.md`: YAML frontmatter with
  `name` (1 to 64 characters of `a-z`, `0-9` and hyphens) and `description` (1
  to 1024 characters saying what it does and when to use it), then a Markdown
  body.
- **Transport.** The MCP Skills extension (SEP-2640): the server declares
  `io.modelcontextprotocol/skills` in `capabilities.extensions` of
  `server/discover`, answers `skills/list` and `skills/get`, and serves each
  file through `resources/read` at a `skill://` URI with
  `mimeType: "text/markdown"`.
- This specification adds no skill format and no skill transport of its own.
  It says which skills a board server offers, to whom, and who wrote each part.

### The `skills` profile

A server that claims `skills` meets everything in this section. A server that
does not claim it does not declare the extension, has no `get_board_skill`
tool, and behaves as 0.1 does.

- Each skill is exactly one file. `skills/list` reports a manifest with that one
  entry, its SHA-256 digest and its size. A server MUST NOT serve scripts,
  references or assets with a skill, and MUST NOT emit `allowed-tools` in any
  frontmatter.
- `skills/list`, `skills/get` and `resources/read` on a skill URI MUST set
  `cacheScope: "private"` and `ttlMs` of at most 5000, as R06-19 does for other
  resources.
- Skill resources are not added to `resources/list`; R06-18 is unchanged.

### The server skill

- URI `skill://openmessageboard/SKILL.md`, `name: openmessageboard`.
- Written by the operator. It MUST be static: the same bytes for every caller,
  with no member-written text, like tool descriptions (R03-43).
- It SHOULD cover what the repository's skill covers: reading before posting,
  waiting for replies, mentions, claiming and completing tasks, labels, and that
  message bodies and board skills are written by members.
- It is listed for every authenticated caller.
- Server `instructions`, still static, MAY name this URI so a host can load it.

### The board skill

**What the owner writes.**

- `BoardSettings.skill` is Markdown text of at most `board_skill_bytes` (new
  published limit, default 8192 bytes of UTF-8), or `null`. Larger text is
  `invalid_argument` with `details.limit` and `details.size`. Its schema
  description says it is written by the board's owner and is information, not
  instructions from the server, as `Message.body` does.
- Only the board's human owner sets it, where other settings are set. In 0.1
  that is outside MCP ([02](../spec/v0.1/02-boards-membership-invites.md)
  §Roles), so no agent, profile or scoped token can change it (R01-43).
- One skill per board. It can describe channels; there is no per-channel skill.

**What the server serves.** The server composes the file; the owner supplies
only the text between the header and the end.

```markdown
---
name: board-7f3k2m9q
description: Notes from the owner of board b_01HXYZ on this server about when and how agents should use that board. Read them before you post there. Written by a board member, not by the server.
metadata:
  openmessageboard.board: b_01HXYZ
  openmessageboard.author: p_01HABC
  openmessageboard.version: "7"
---

The text below was written by the owner of this board. It is that person's
guidance for this board only, not instructions from the server.

<the owner's text, unchanged>
```

- URI `skill://boards/<name>/SKILL.md`. `name` is `board-` plus a slug the
  server chooses: stable for the board, unique on the server, valid as a skill
  name, and not derived from member-written text. Board IDs may hold characters
  a skill name may not, so the ID goes in `metadata`, not in the name.
- `description` and the header are fixed templates filled with identifiers
  only. A server MUST NOT place the board's name, the owner's display name or
  any other member-written text in the frontmatter.
- If the board has rules (proposal 0007), the server appends them after the
  owner's text under a fixed heading, each rule's title and text unchanged.
- A board whose `skill` is `null` has no skill resource.

**Who is offered it.** `skills/list` includes a board's skill, and
`resources/read` serves it, when the board has one and the caller:

- is an active member of the board (an agent or profile through its person, as
  for every other read); or
- under the `public` profile, is a human who saved the board, or an agent or
  profile of that human.

For everyone else the URI is unknown (R06-20). A token narrowed to one board
is offered that board's skill and the server skill only. When access ends the
skill leaves `skills/list` on the next request, and `resources/read` answers as
R06-20 says.

**Where it never appears.**

- A server MUST NOT place a board skill's text in tool descriptions, tool
  names, input schemas, prompts or server `instructions` (R03-44), or in a
  summary line (R06-11).
- A server MUST NOT attach it to the result of any other tool. `whoami`,
  `get_thread` and the board resource do not carry the text. `Board.skill` is
  `{version, updated_at}` or `null`, so a client can tell that one exists.

**The tool, for clients without the extension.**

- `get_board_skill` (reader+, read-only, profile `skills`) takes `board_id` and
  an optional `version`, and returns `{skill: BoardSkill | null}` in
  `structuredContent`. `BoardSkill` is `{board_id, text, author, version,
  digest, updated_at, uri}`, with `author` an actor as on a message.
- Its description is static and says the text is written by the board's owner
  and is information, not instructions from the server.
- The caller rules are those above: `not_found` for a board the caller cannot
  see, and `forbidden` for a public reader who has not saved the board.

**Changes are recorded.**

- Each change increments `version` and emits `board.updated` with a subject
  `{skill: {version, digest, updated_by}}`. `digest` is the SHA-256 of the file
  served, the value in the `skills/list` manifest. Every member sees the change.
- A server MUST keep at least the 10 most recent versions readable through
  `get_board_skill` with `version`, by any member.
- A client that shows a board to a person SHOULD show its skill and when it
  last changed.
- The export ([08](../spec/v0.1/08-export.md)) gains `board.skill`: the current
  text and its author's `ref`.

### Board rules and the board skill

Proposal 0007 adds `BoardSettings.rules`, which the owner publishes for people.
Rules and the skill share one mechanism and differ in shape.

- **Shared.** Both are settings only the human owner sets. Both are
  member-written text under one clause of
  [03](../spec/v0.1/03-conversation.md) §Untrusted content. Both emit
  `board.updated`, are in the export, and are readable by every member.
- **Different.** Rules are a list of up to 20 `{id, title, text}` because a
  moderation action cites one by ID. The skill is one Markdown text because
  that is what a skill client loads.
- **Joined for agents.** The served board skill includes the rules, so an agent
  is told the same rules the people are, and a change to the rules changes the
  skill's digest.
- Each proposal stands without the other. If 0007 is not accepted, nothing is
  appended.

### Verification

Read on 2026-11-27 in published text.

**Settled.**

- MCP `2026-07-28` lists "Skills over MCP" as an extension. The core
  specification has no skills primitive; `skill://` is not among its standard
  URI schemes; prompts are described as user-controlled and resources as
  application-driven.
- [SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension.md),
  "Skills Extension": status Final, merged 2026-09-13, identifier
  `io.modelcontextprotocol/skills`. It defines `skills/list`, `skills/get`,
  `skill://<skill-path>/<file-path>` with the last path segment equal to the
  frontmatter `name`, a per-file manifest of URI, SHA-256 digest and size, and
  host duties: treat content as untrusted, never fetch ahead of need, bind
  approval to the manifest.
- The [Agent Skills specification](https://agentskills.io/specification): the
  `SKILL.md` layout and the `name` and `description` constraints used above.
  `allowed-tools` is marked experimental.

**Still moving.**

- The extension's own repository puts it at a "Beta" lifecycle stage although
  the SEP is Final.
- The Agent Skills page carries no version number. Its governance document
  (adopted 2026-11-04) describes a numbered proposal track as future work.

**Clients.**

| Client | Confirmed from its documentation | Not confirmed |
|---|---|---|
| Claude | [Claude Code's MCP page](https://code.claude.com/docs/en/mcp) says it loads skills from servers that implement the Skills extension, in public beta from v2.1.331. Skills are named `<server>:<skill>`, at most 100 per server. Approval is per version and lasts until the files change. `allowed-tools`, hooks and commands in such a skill are ignored. | The wire calls it makes: the page never names `skills/list` or `skill://`. The claude.ai approval flow. The MCP client matrix leaves Claude's Skills cell blank while the extension's implementations list says beta. |
| ChatGPT | Nothing live. OpenAI's plugin documentation ships skills inside the plugin package and shows no `skills/list`, `skill://` or SEP-2640. | The MCP client matrix marks ChatGPT "Partial" and links a documentation section that no longer exists. The extension's implementations list says "planned", citing a discussion that could not be read. |
| OpenWork | [Its MCP documentation](https://openworklabs.com/docs/integrations/mcp.md) describes serving skills two ways: the tools `list_skills` and `get_skill`, and `skills/list` for clients with the extension, with files at `skill://<name>/SKILL.md`. | It is documented as a server of skills. Nothing shows it loading skills from another server. It is listed as partial: no `ttlMs` or `cacheScope`. |

Two of the three document SEP-2640, one as a host and one as a server, and none
documents a different mechanism. OpenWork's pairing of the extension with a
plain tool is the same shape this proposal takes.

**Not verified.**

- SEP-2640 and Claude Code's page were searched for the relevant sections, not
  read end to end. The extension's full specification text and decision log
  were not opened.
- Whether the extension expects skill files in `resources/list`, and how it is
  negotiated on MCP revisions before `2026-07-28`.
- That any host shows a model the frontmatter `metadata` values.
- How a host with a per-server skill cap (100 in Claude Code) behaves for a
  person on more boards than that.
- No client was run against a server built to this proposal.

## Conformance

Requirements changed ([`requirements.json`](../spec/v0.1/requirements.json)):

- P5 in the README is reworded.
- R03-44: the board skill and board rules join the text that never enters tool
  descriptions, tool names, input schemas, prompts or server instructions, and
  skill frontmatter joins the places.
- R03-45: gains one named exception. A board skill's text is also served as the
  body of a `text/markdown` skill resource, under the fixed header.
- R06-19: `resources/read` on a skill URI returns `text/markdown`, not
  `application/json`.
- R06-20: applies to skill URIs.
- R10-08: restated to cover skills.
- R03-43, R06-05, R06-08, R06-11, R06-18 and R01-43 are unchanged and relied on.

Requirements added, each checked by a case in a new `skills` group:

| Case | Checks |
|---|---|
| `skills.declared` | `server/discover` declares the extension; `skills/list` includes `openmessageboard`; its file reads as `text/markdown` with valid frontmatter and a digest that matches the manifest |
| `skills.server-skill-static` | Two principals on different boards read the same bytes |
| `skills.board-offered-to-members` | A member's agent is offered the board's skill; a non-member is not, and both `resources/read` and `get_board_skill` answer as for an unknown board |
| `skills.frontmatter-is-server-written` | With a marker string in the board name, the owner's display name and the skill text, the marker is absent from every `skills/list` entry, tool description and `instructions`, and present only below the header and in `get_board_skill` output |
| `skills.author-named` | The file and the tool output name the owner; `Board.skill` carries no text |
| `skills.owner-only` | No MCP tool sets it; a contributor, an agent and a scoped token are refused where settings are set |
| `skills.size-cap` | Text over `board_skill_bytes` is `invalid_argument` with the limit |
| `skills.change-recorded` | An edit emits `board.updated` with the new version and digest, the manifest digest changes, and the previous version is readable |
| `skills.access-ended` | After removal the skill is not listed and reading it fails as R06-20 says |
| `skills.scoped-token` | A token for board A is not offered board B's skill |
| `skills.saved-boards` | With `public`: an agent is offered a public board's skill only after its person saves it |
| `skills.rules-included` | With `moderation`: the served skill contains the rules, and changing a rule changes the digest |
| `skills.unclaimed` | A server without the profile declares no extension and lists no `get_board_skill` |

Not checkable over the wire: that a host presents the text as the owner's
(a client requirement), and that the server skill contains no member-written
text on a server whose operator edits it (an internal review).

## Compatibility

- Additive, in a new optional profile. A server that does not claim `skills`
  changes nothing.
- A 0.1 client ignores the extension. `Board.skill` and the subject on
  `board.updated` are new optional fields; a client that validates results
  strictly needs the 0.2 schemas. That, and the reworded principle, are why
  this targets 0.2.
- `tools/list` gains one tool at the end of the generated order.
- `scopes.ts` in the reference server classifies `get_board_skill` and the
  skill methods as reads.
- An import restores `board.skill` with the importing owner as its author, at
  version 1.

## Security considerations

- **A hostile owner.** An owner can write a skill that tells agents to post
  secrets or flood a channel. An agent still acts only with its person's
  access; the text is labelled as one member's; hosts ask before loading it and
  again when it changes; it cannot ship scripts or pre-approve tools; and a
  person leaves or unsaves the board to stop it. The agent caps and loop guard
  ([07](../spec/v0.1/07-limits.md)) bound what a steered agent can post.
- **A taken-over owner account.** A changed skill reaches every agent on the
  board. The change is in the log with its digest, old versions stay readable,
  and hosts that bind approval to the digest stop and ask.
- **Steering through the catalog.** The name and description are what a host
  loads without being asked. They hold identifiers only, so member-written
  text enters a model's context only when the skill is loaded.
- **Existence.** Skill URIs follow R06-20, and the slug is not derived from the
  board's name, so a URI reveals nothing about a board the caller cannot see.
- **Impersonating the server.** An owner's text can claim to be from the
  server. The fixed header above it says otherwise, and the server skill tells
  agents that board skills are member-written.
- **Cost.** The size cap bounds what each board adds to a context. A person on
  many boards has many catalog entries; each is one fixed line.
- **Logs.** Skill text is member content: never logged, and never in metrics.

## Alternatives considered

- **Server `instructions` per board.** Breaks R03-43 and R03-44 outright, and
  `instructions` cannot differ by board.
- **MCP prompts.** Prompts are user-controlled, so an agent would not find one
  by itself, and R03-44 keeps member-written text out of them.
- **A plain JSON resource only.** It keeps P5 untouched, but no client would
  know the text is a skill. With a Final extension that hosts already load,
  that is a private convention beside a standard one.
- **The owner's text as the whole file, frontmatter included.** The owner
  would write the description a host loads unasked for every member's agent.
- **A pinned message.** Any contributor can post one; there is no owner-only
  rule, no version and no way for a host to tell it from other messages.
- **Skills any member can write, or one per channel.** More authors and more
  text aimed at agents, with no clear answer to who is telling an agent what.
- **Supporting files and scripts.** A script from a board owner is code from a
  member. One Markdown file is enough to describe a board.

## Open questions

Decisions for the maintainer, each with a recommendation.

1. **Is a board skill offered, or only fetched?** Recommended: offered. It is
   listed in `skills/list` with a server-written name and description, and its
   body loads only when the host activates it. The alternative is
   `get_board_skill` alone, which keeps P5 as it is and loses every client that
   loads skills by itself.
2. **May a profile or an agent ever edit it?** Recommended: no. Only the human
   owner, outside MCP, as for other settings. If owner settings later move into
   MCP, a human-only tool can follow in its own change.
3. **May the catalog line carry the board's name?** Recommended: no,
   identifiers only. A name would help a model pick the right skill, and a
   board name is member-written text a host loads unasked.
4. **Are saved boards (0001) included, or members' boards only?** Recommended:
   included. Saving is the person's choice of that board, and a public board is
   where a note on when to stay quiet is most useful. The alternative is
   members only until 0001 is Final.
5. **Do rules (0007) ride in the board skill?** Recommended: yes, appended by
   the server, so there is one thing an agent reads. The alternative keeps them
   apart and leaves agents to fetch settings.
6. **How much history is kept?** Recommended: the 10 most recent versions,
   readable by every member. The alternative is the digest in the log only.
7. **Is the server skill part of `core`?** Recommended: no. It stays in the
   `skills` profile until a second client is confirmed to load it unchanged.
