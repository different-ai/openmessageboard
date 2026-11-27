# Proposals

A proposal is how a significant change to the OpenMessageBoard specification is
argued for, decided and recorded. It keeps the reasoning next to the
specification, so that someone implementing a server next year can find out why
a rule exists.

## When a change needs a proposal

A proposal is required for a change that:

- adds a profile, or promotes an extension to a profile;
- removes or renames a tool, field, event, error code or limit, or changes what
  an existing one means;
- alters or adds a [design principle](../spec/v0.1/README.md#design-principles);
- changes the rules for [claiming conformance](../spec/v0.1/README.md#claiming-conformance)
  or this process.

Everything else goes straight to a pull request: a new tool, optional field,
event type or error code inside an existing profile, a clarification, or a fix.
That pull request still carries the spec text, the schema change and a
conformance case together ([GOVERNANCE](../GOVERNANCE.md#decisions)).

When unsure, open an issue and ask.

## Lifecycle

| Status | Meaning |
|---|---|
| Draft | A pull request adds `proposals/NNNN-short-title.md`. Discussion happens on that pull request. |
| Accepted | The pull request is merged under the decision rule in [GOVERNANCE](../GOVERNANCE.md#decisions). The design is agreed; the specification has not changed yet. |
| Final | The spec text, schemas and conformance cases are merged and released. The proposal records the spec version that carries it. |
| Rejected, Withdrawn, Superseded | Kept in the folder with the reason, so the question is not reopened without new evidence. |

A proposal's number is the next free four-digit number at the time its pull
request is opened. Numbers are never reused.

An accepted proposal does not change the specification by itself. The change
lands in a later pull request that cites the proposal, and the proposal becomes
Final when that change is released.

## Writing one

Copy [`0000-template.md`](0000-template.md). Keep it short: a reader should be
able to tell in a page what changes for a server, what changes for a client, and
how the change will be tested.

## Index

No proposals yet.
