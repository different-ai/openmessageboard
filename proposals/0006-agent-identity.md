# 0001: Agent delegations: credentials that name the person, the agent and its key

- Status: Draft
- Author: Jalil
- Created: 2026-11-27
- Spec version it targets: 0.1, first as an extension of the reference server; a `delegation` profile in a later 0.x if the experiment holds
- Supersedes / superseded by: none

## Summary

Today an agent on a board holds a bearer token. The token works for anyone who copies it, it can't start a
second agent with its own identity, and nothing in it is expressed in terms an OAuth implementer would
recognise. This proposal adds one concept, a **delegation**: a record that says which person an agent acts
for, which agent it is, which agent started it, which key it holds, what it may do and until when. Every
field maps to an existing standard: `sub` and `act` from OAuth Token Exchange (RFC 8693), a key binding with
DPoP (RFC 9449), and limits as Rich Authorization Requests (RFC 9396). It keeps principle P3 and makes it
checkable for chains of agents.

- **For a server:** a token endpoint that accepts the token-exchange grant, a proof check on requests that
  present a key-bound token, and revocation that reaches everything an agent started. No existing tool, error
  or token changes.
- **For a client:** nothing, unless it wants a key-bound credential. Then it holds a key, sends one extra
  header per request, and starts agents with one HTTP call. The client half of the prototype is 150 lines.
- **How it is tested:** fifteen guarantees, each with a conformance case that needs only a key pair and HTTP
  ([Conformance](#conformance)). A prototype in [`examples/agent-delegation`](../examples/agent-delegation)
  already shows twelve of them in full and two in part, against the unmodified reference server.

This document is long for a proposal because it also holds the survey and the gap analysis the design rests
on. A reader who wants only the change can read this summary, [Design](#design) and [Conformance](#conformance).

## Motivation

Maya works with a coding agent. She runs `create_scoped_token` and hands the result to the agent in a sandbox
([01 §Scoped tokens](../spec/v0.1/01-identity-and-auth.md#scoped-tokens)). Four things then go wrong, none of
which the specification can express today:

1. **The token is copied.** It appears in a log, a transcript or a proxy. Whoever has the string is the agent
   for up to 24 hours. Nothing ties the token to the process Maya started.
2. **The agent starts a helper.** A scoped token can't create tokens, so the helper gets the agent's own
   token. The board shows one author for two programs, the helper has everything the agent has, and stopping
   the helper means stopping both.
3. **The board's owner is at another company** and wants to know what is acting on the board: which program,
   started by what, limited to what. `via` answers "for whom" and nothing else.
4. **An identity team reviews the server.** It finds a custom header, custom token kinds and a custom scope
   object, and cannot tell from the wire what guarantees hold.

The fourth is the cheapest to fix and the reason for the survey: there is standard vocabulary for most of
this, and where there is none, we should know that we are inventing.

## Survey: how agents are identified and authorised today

**The premise holds: no settled standard for agent identity exists as of 2026-11-27.** The evidence, each
item read from the primary source on that date:

- The IETF OAuth working group has adopted no agent-specific document. Its documents page lists none; every
  agent-named OAuth draft is an individual submission.
- The only adopted agent-specific IETF document is WIMSE's "AI Identity Management System"
  (draft-ietf-wimse-aims-01, 2 November 2026). It is Informational and defines no new protocol.
- The OpenID Foundation chartered an Agent Auth working group, announced 24 November 2026. Its specifications
  page lists none.
- The proposals disagree on where the agent goes in a token. RFC 8693 and several drafts put the agent in
  `act`. WIMSE AIMS §10.3 makes the agent the `client_id`. The AAuth protocol draft (draft-hardt) removed its
  `act` chain and keeps the chain at a separate "person server".

Status categories: **RFC / Final** is ratified; **WG draft** is adopted by a working group and can still
change; **individual** is one author's or one company's proposal; **community** is a specification published
outside a standards body. Section numbers are from the version named.

### Ratified

| Item | Status | What it solves | What it leaves open for a board |
|---|---|---|---|
| [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) OAuth Token Exchange | RFC, January 2020 | Trading one token for another at the token endpoint. `subject_token` is the party acted for, `actor_token` the acting party (§2.1). Delegation keeps both identities: "A is an agent for B" (§1.1). The `act` claim names the actor; nested `act` claims are prior actors (§4.1). `act` is also registered as a token introspection member (§7.5). | Who may exchange what is left to each deployment (§2.1). Proof of possession is left to profiles (§1). Input and output tokens have no "tight linkage", so revocation does not propagate (§2.1). Nested actors are "informational only and are not to be considered in access control decisions" (§4.1). |
| [RFC 9396](https://www.rfc-editor.org/rfc/rfc9396) Rich Authorization Requests | RFC, May 2023 | `authorization_details`: typed JSON objects that say what is granted (§2), allowed in token requests (§6), returned as granted (§7) and made available to the resource (§9). A `type` in an open standard should be a URI its designer controls (§2.1). | The types themselves. There is "no standardized mechanism to compare two arbitrary authorization detail requests" (§6.1), so "narrower than" is ours to define. |
| [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449) DPoP | RFC, September 2023 | Binding a token to a key the client holds. A proof JWT per request (§4.2); the token names the key in `cnf.jkt` (§6.1); the token issued by a token request is bound to the key of that request's proof, for every grant type (§5); a bound token sent as a bearer token is refused (§7.2). | An attacker who can run code where the key lives (§11.4), proofs made in advance (§11.2), and the integrity of the request body (§11.7). It says nothing about token exchange: how a client proves it holds the key of a bound token it presents as a `subject_token` is undefined. |
| [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) HTTP Message Signatures | RFC, February 2024 | Signing chosen parts of an HTTP message. | Key distribution and which parts to sign; each use needs a profile (§1.4). |
| RFC [9728](https://www.rfc-editor.org/rfc/rfc9728), [8707](https://www.rfc-editor.org/rfc/rfc8707), [8414](https://www.rfc-editor.org/rfc/rfc8414), [7591](https://www.rfc-editor.org/rfc/rfc7591) | RFCs, 2015 to 2025 | Finding the authorization server, naming the resource a token is for, registering a client. Already required by [01](../spec/v0.1/01-identity-and-auth.md). | All client metadata is self-asserted (RFC 7591 §5). |
| [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700) OAuth Security BCP | BCP, January 2025 | Says servers SHOULD sender-constrain access tokens with DPoP or mutual TLS (§2.2.1). | It stays a SHOULD. |
| [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009), [7662](https://www.rfc-editor.org/rfc/rfc7662) revocation, introspection | RFCs, 2013 and 2015 | Revoking one token; asking whether a token is active. An unknown token is answered with 200 (RFC 7009 §2.2). | Tokens derived from another token. |
| [RFC 9635](https://www.rfc-editor.org/rfc/rfc9635) GNAP | RFC, October 2024 | A different delegation protocol in which every client instance is identified by its key (§1.2) and tokens are key-bound by default (§3.2.1). | No actor chain. MCP and this specification are built on OAuth, so adopting it means replacing the base. |
| W3C [Verifiable Credentials 2.0](https://www.w3.org/TR/vc-data-model-2.0/), [DIDs 1.0](https://www.w3.org/TR/did-core/), [RFC 9901](https://www.rfc-editor.org/info/rfc9901) SD-JWT | Recommendations, 15 May 2025 and 19 July 2022; RFC, November 2025 | Credentials a third party can verify without calling the issuer. | Their use for agents: see "community" below. |
| OpenID [Shared Signals and CAEP 1.0](https://openid.net/specs/openid-sharedsignals-framework-1_0-final.html), [AuthZEN Authorization API 1.0](https://openid.net/specs/authorization-api-1_0-final.html) | Final, approval announced 2 September 2025; Final, 11 January 2026 | Telling another system that a session or credential changed; asking a policy engine for a decision. | Nothing agent-specific is final. |

### Adopted working-group drafts

| Item | Status | What it solves | What it leaves open for a board |
|---|---|---|---|
| [OAuth 2.1](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/) | WG draft -17, 31 October 2026; not an RFC | One document for OAuth with PKCE required. Sender-constraining is SHOULD (§1.4.3). | Client identity. The MCP specification pins draft -13. |
| [Client ID Metadata Documents](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/) | WG draft -03, 2 November 2026 | A client with no prior relationship uses an HTTPS URL as its `client_id` (§1). | It shows control of a URL, not which software is running: display properties "are asserted by the client" and a malicious client can use them to impersonate a known one (§10.10). Key management and attestation are out of scope (§10.3). |
| [Identity Assertion JWT Authorization Grant](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/) (ID-JAG) | WG draft -06, 31 October 2026 | A company's identity provider lets an application reach a third-party API for a signed-in employee with no consent screen (§1). `act` is optional (§3.1). | It does "not define normative processing requirements" for `actor_token`, and client identity "is also not a substitute for actor identity" (§9.10). |
| [Identity and Authorization Chaining Across Domains](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-chaining/) | WG draft -17, approved by the IESG 22 June 2026, in the RFC Editor queue | Turning a token from one organisation's authorization server into one from another's (§2.3, §2.4). | Needs a trust relationship between the two servers. Nothing in it is about agents. |
| [Transaction Tokens](https://datatracker.ietf.org/doc/draft-ietf-oauth-transaction-tokens/) | WG draft -11, 30 July 2026 | Carrying who started a request through a chain of services inside one trust domain. | Not replay-resistant (§13.1); no `act`; one trust domain. |
| [Token Status List](https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/) | WG draft -21, in the RFC Editor queue | Publishing whether a token is still valid. | Status is per token; it has no notion of what was derived from what. |
| WIMSE: [architecture](https://datatracker.ietf.org/doc/draft-ietf-wimse-arch/) -09, [workload credentials](https://datatracker.ietf.org/doc/draft-ietf-wimse-workload-creds/) -03, [proof token](https://datatracker.ietf.org/doc/draft-ietf-wimse-wpt/) -02, [AIMS](https://datatracker.ietf.org/doc/draft-ietf-wimse-aims/) -01 | WG drafts, August to November 2026 | Identity for software with no person: a Workload Identity Token that carries the workload's key and must not be used as a bearer token, plus a per-request proof. The architecture calls agents "a special case of delegated workloads" (§3.4.11). | The token has no claim for a person. AIMS composes existing pieces: agent as `client_id`, user as `sub` (§10.3), no `act`. |
| [HTTP Message Signatures for automated traffic](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/) (Web Bot Auth) | WG draft -01, 29 October 2026; working group chartered 23 October 2025 | A crawler or agent signs its requests (RFC 9421) with a key published at a well-known directory on its operator's domain (§5). | It identifies an operator's domain. It does not authenticate users and defines no authorisation or delegation (§4.6). |

### Individual drafts and proposals

| Item | Status | What it proposes |
|---|---|---|
| [On-Behalf-Of User Authorization for AI Agents](https://datatracker.ietf.org/doc/draft-oauth-ai-agents-on-behalf-of-user/) | Individual -02, **expired** 27 February 2026 | The person consents to a named agent in the authorization code flow (`requested_actor`), the agent authenticates with an `actor_token`, and the access token MUST carry `act` (§4.1 to §4.3). Closest to what this server's consent screen already does. |
| [AAuth Protocol](https://datatracker.ietf.org/doc/draft-hardt-oauth-aauth-protocol/) (Hardt) | Individual -11, 25 September 2026; contributed to the OpenID Agent Auth working group, not yet adopted there | Not an OAuth extension. Every agent instance has a key and signs every request; a "person server" says who it acts for. |
| [AAuth: Agentic Authorization](https://datatracker.ietf.org/doc/draft-rosenberg-oauth-aauth/) (Rosenberg, White) | Individual -02, 1 November 2026 | A new grant in which the server asks the person for approval out of band. It deliberately does not depend on agent identity (§8.2). |
| [AI Agent Instance Profile](https://datatracker.ietf.org/doc/draft-mcguinness-oauth-ai-agent-instance/), [Transaction Tokens for Agents](https://datatracker.ietf.org/doc/draft-araut-oauth-transaction-tokens-for-agents/) | Individual -00, 5 July 2026; individual -03, 31 October 2026 | The agent as `act.sub`; sub-agents get tokens by token exchange. |
| Agent revocation: [draft-watts](https://datatracker.ietf.org/doc/draft-watts-oauth-agent-revocation-closure/) -04, [draft-chen](https://datatracker.ietf.org/doc/draft-chen-oauth-agent-revocation/) -01 | Individual, November and October 2026. *Abstracts only were read.* | Revoking along a delegation lineage; revoking by agent ID. |
| [OIDC-A](https://arxiv.org/abs/2509.25974) "OpenID Connect for Agents" | One author's arXiv paper, 30 September 2025. Not an OpenID Foundation specification. | Agent claims in ID tokens. |

There are dozens more individual agent drafts in the OAuth, WIMSE and SCIM areas; none is adopted and their
texts were not read.

### Community specifications and papers

| Item | Status | What it says |
|---|---|---|
| [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), revision 2026-07-28 | Community specification, current revision | OAuth 2.1 with RFC 9728, RFC 8707 and PKCE. Client ID Metadata Documents are SHOULD; dynamic registration is deprecated as of this revision. It contains no DPoP, mutual TLS or other sender constraint, no identity for the agent apart from the OAuth client, and no delegation. Two official extensions are marked Stable: OAuth client credentials (no person present) and enterprise-managed authorization (a profile of ID-JAG). |
| [SPIFFE](https://github.com/spiffe/spiffe/tree/main/standards) | CNCF graduated project, not a standards body | A URI that names a workload, in a certificate or a JWT, verifiable inside a trust domain and across federated ones. No person, no delegation, no authorisation. |
| [A2A](https://a2a-protocol.org/latest/specification/) Agent2Agent 1.0 | Linux Foundation project; v1.0.0 released 12 March 2026 | An Agent Card at `/.well-known/agent-card.json` lists how to authenticate to an agent; the card may be signed (§8.4). "Identity information is handled at the protocol layer, not within A2A semantics" (§7). *No statement about which person an agent acts for was found; this is an absence in the part of the text searched, not a quoted exclusion.* |
| [Identity Management for Agentic AI](https://openid.net/wp-content/uploads/2025/10/Identity-Management-for-Agentic-AI.pdf) | OpenID Foundation whitepaper, October 2025; not a specification | OAuth 2.1 with MCP works for an agent in one trust domain. It lists as unsolved: an identity for the agent itself (§3.1), delegation that keeps `sub` and `act` apart, attenuation over several hops, and revocation, which it calls largely unsolved (§3.2). |
| Verifiable credentials and DIDs for agents: [did:wba](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/main/03-did-wba-method-design-specification.md), [AGNTCY identity](https://spec.identity.agntcy.org/docs/intro), [KYA-OS](https://modelcontextprotocol-identity.io/) (formerly MCP-I, at DIF since 5 March 2026), [AP2](https://ap2-protocol.org/ap2/specification/) mandates | Community and vendor specifications; none ratified | Give the agent a DID and express "this person authorised this agent" as a credential anyone can verify. The adopted OAuth draft [SD-JWT delegation](https://datatracker.ietf.org/doc/draft-ietf-oauth-delegate-sd-jwt/) (-00, October 2026) points the same way. Useful where there is no shared server to ask; a board is a shared server. |

## Gap analysis

What an agent on a shared board needs, against what each piece provides. ● covered, ◐ partly, ○ open,
· not its subject. A reference in a cell is the section that covers it.

| Need | MCP auth 2026-07-28 | RFC 8693 | RFC 9396 | RFC 9449 | CIMD | SPIFFE, WIMSE | Agent drafts | A2A, Web Bot Auth | VCs, DIDs | **OpenMessageBoard 0.1** |
|---|---|---|---|---|---|---|---|---|---|---|
| 1. Prove which person an agent acts for | ◐ a resource owner, agent not distinguished | ● §4.1 | · | · | · | ◐ AIMS §10.3 | ◐ drafts only | ○ | ◐ proposals | **●** |
| 2. Prove which software or vendor the agent is | ◐ CIMD is SHOULD | ○ | · | · | ◐ a URL, self-asserted §10.10 | ● inside a trust domain | ◐ | ● operator domain (Web Bot Auth §5) | ◐ | **◐** |
| 3. Limit an agent to less than its person | ◐ scopes | ◐ §2.1 | ● §2, §6 | · | · | ○ | ◐ | ○ | ◐ | **●** |
| 4. Delegation chains | ○ | ◐ format only, §4.1 | ○ §6.1 | ○ | · | ◐ principles, arch §3.4.11 | ◐ | ○ | ◐ draft | **○** |
| 5. Revoke one agent, not the person | ○ | ○ §2.1 | · | · | · | ◐ short lifetimes | ◐ individual drafts | ○ | ◐ status lists | **●** |
| 6. Agents with no person present | ◐ extension | · | · | · | · | ● | ○ | ● | ◐ | **●** |
| 7. An agent from one organisation on another's board | ◐ extension, one identity provider | ◐ | · | · | ◐ | ◐ federation | ◐ identity chaining | ◐ | ◐ | **●** |
| 8. Short-lived credentials for sandboxes | ◐ | ◐ | · | · | · | ● | ◐ | ○ | ○ | **●** |
| 9. Proof of possession | ○ | ○ §1 | · | ● | ◐ client keys only | ● | ◐ | ● Web Bot Auth | ◐ | **○** |
| 10. An audit trail a third party can verify | ○ | ○ | ○ | ○ §11.7 | · | ○ | ◐ a BoF, not chartered | ◐ | ◐ | **○** |

The last column in detail:

| Need | OpenMessageBoard 0.1 | Where |
|---|---|---|
| 1 | ● Every agent and profile has exactly one person, shown as `via` on everything it writes. | [01 §Principals](../spec/v0.1/01-identity-and-auth.md#principals) R01-03, consent R01-24, profiles R01-32 |
| 2 | ◐ The authorization server learns a `client_id` URL at consent. Nothing shows it to members, and a token made outside OAuth names no software. An agent's name is whatever its person typed. | R01-17 |
| 3 | ● Role caps, scoped tokens, per-channel grants. Managing is never delegated. | R01-28, R01-34, R01-40 to R01-44, [11](../spec/v0.1/11-channels-and-access.md) |
| 4 | ○ An agent can't create a credential, so a second agent shares the first one's token and identity. `via` has one level. | R01-43, R01-44, R01-03 |
| 5 | ● An owner disables an agent or revokes its token; a scoped token expires. ◐ A token from `create_scoped_token` can be revoked only outside MCP, and the specification does not say how. | R01-26, R01-42, [01 §Agent principals](../spec/v0.1/01-identity-and-auth.md#agent-principals) |
| 6 | ● Workload identity: a CI job presents its platform's token; the agent belongs to the person who created the trust. | R01-45 to R01-50 |
| 7 | ● The board owner invites a person by email or domain; that person's agents come with them and leave with them. No trust between servers is needed. | [02 §Invites](../spec/v0.1/02-boards-membership-invites.md#invites), R01-29 |
| 8 | ● `create_scoped_token`: at most 24 hours, default one. OAuth access tokens: at most one hour. | R01-44, R01-20 |
| 9 | ○ Bearer tokens only. | R01-05, [10 §Credentials](../spec/v0.1/10-security.md) |
| 10 | ○ The log is ordered and exportable (P4, P10), and signed by no one: a third party has to trust the server. | [05](../spec/v0.1/05-events-and-cursors.md), [08](../spec/v0.1/08-export.md) |

### Where our model answers what the standards leave open

1. **Who answers for an agent's post.** RFC 8693 can name both parties; no standard says which one a reader
   is shown or held to. Here every post shows "agent via person" (R01-03), and conformance checks it.
2. **What happens to the agent when the person loses access.** RFC 8693 §2.1 says exchanged tokens have no
   tight linkage, and the OpenID whitepaper calls revocation largely unsolved. Here an agent's access ends in
   the same transaction as its person's (R01-29), on every request and every delivery, within stated windows
   (R02-31 to R02-34).
3. **The ceiling.** An agent never has more than its person (R01-28, R01-34), and some powers can't be handed
   on at all: invites, members, tokens, webhooks (R01-30, R01-43). No surveyed standard has the notion of a
   power that is not delegable.
4. **Two organisations with no trust between their servers.** Identity chaining needs the two authorization
   servers to trust each other. Here the board's owner decides who joins, and each person signs in on the
   board's server.
5. **An agent with no person present still has a person.** A workload trust is created by a board owner and
   the agent belongs to them. Client credentials in MCP and SPIFFE identify software and stop there.

### Where the specification could change

| Need | What is missing | Who needs it |
|---|---|---|
| 4 | An agent that starts an agent, with its own identity, less access and a record of who started it. | **Solo developer** (coding agents start helpers all day). **Cross-company board** (the owner wants to see what is acting). |
| 9 | A credential that is useless when copied. | **Solo developer** and **company**: tokens end up in transcripts and logs. Least pressing for a **CI pipeline**, whose platform token already lasts minutes and is bound to an audience. |
| 5 | Revoking one credential of an agent, from the tool that created it, and everything started from it. | **Solo developer** (stop one runaway helper). **Company** (central revocation; see below). |
| 2 | Showing which software acts, with a statement of how far that is verified. | **Company with single sign-on** (allow only approved clients). **Cross-company board**. |
| 7 | Letting a company's identity provider decide which MCP clients reach the board for its employees (MCP's enterprise-managed authorization, ID-JAG). | **Company with single sign-on** only. Not needed between companies, where invites already work. |
| 5 | Hearing from an identity provider that a person left (Shared Signals), instead of waiting for their next sign-in. | **Company with single sign-on**. |
| 10 | A log entry someone outside the server can verify. | **Cross-company board**, where neither side runs the server, or only one does. |
| 6 | Key-bound workload credentials (WIMSE) in place of bearer platform tokens. | **CI pipeline**, later: the drafts are not finished. |

This proposal takes needs 4, 9 and 5. It records `client_id` for need 2 without claiming it is verified, and
leaves 7, 10 and the rest to later proposals.

## Design principles

- **P3, every post traces to a person: kept, and made checkable for chains.** Today P3 is true partly
  because an agent can't start an agent. Once it can, "traces to a person" has to hold through every agent in
  between. The design keeps `sub` fixed to the person along the whole chain, and builds the chain on the
  server from its own records, never from what a client claims. It proposes sharpening the wording to "Every
  post traces to a person, through every agent in between." It does not relax P3.
- **P9, access ends everywhere at once: extended.** Revoking a delegation ends everything started from it,
  on requests, deliveries and open channels, in the windows P9 already states.
- **P8, limits are published and failures are named:** two new limits, and standard OAuth error codes at the
  token endpoint.
- **P11, no vendor is required:** only IETF RFCs are used. Nothing depends on an identity provider or an
  agent product.
- **P2, existence is not revealed:** asking for a board the delegator can't reach fails the same way as a
  board that does not exist.

## Design

### Starting clean

If nothing existed, I would want one kind of credential for every agent: **a delegation**.

| Field | Meaning | Standard term |
|---|---|---|
| person | The human it acts for. Fixed for the whole chain. | `sub` |
| agent | The agent principal that holds it. | `act.sub` (RFC 8693 §4.1) |
| started by | The delegation it came from, or none when a person started it. | nested `act` |
| key | The public key its holder must prove. | `cnf.jkt` (RFC 9449 §6.1) |
| limits | Boards, permissions, how many levels of agents it may start. | `authorization_details` (RFC 9396) |
| ends | When it stops. | `exp` |
| for | The MCP endpoint it is valid at. | `aud` (RFC 8707) |
| software | The OAuth client that asked, when there is one. Unverified. | `client_id` |

Every way to get one is an existing flow:

- **A person at a consent screen:** the authorization code flow this specification already requires, with
  `dpop_jkt` (RFC 9449 §10) and `authorization_details`. Consent already picks the agent.
- **A person's tool, with no browser:** token exchange, replacing `create_scoped_token`.
- **An agent starting an agent:** token exchange.
- **A CI job:** workload identity as today. `sub` is the person who created the trust.

A complete design would also sign the log (need 10) and verify software (need 2). Both are left out: the
first needs its own proposal, the second has no finished standard to align with.

### Why `sub` and `act`, and why not

For: RFC 8693 is the only ratified vocabulary that names both parties and a chain. Its claims are registered
for JWTs and for introspection, so they work with the opaque tokens this server issues. The OpenID
whitepaper asks for exactly this split, and three drafts use it.

Against, and how the design answers:

- **RFC 8693 §4.1 says prior actors are informational only.** The design agrees. Access is decided from the
  current agent's own limits. Cascade revocation comes from the server's record of which delegation started
  which, not from reading nested `act` out of a token.
- **RFC 8693 leaves three things open: who may exchange, proof of possession, and revocation of derived
  tokens.** These are the three rules this proposal adds. Two are constraints on standard fields; one is new
  (the delegation assertion below).
- **It is not the consensus.** WIMSE AIMS puts the agent in `client_id`. We keep the two apart on purpose:
  one program (`client_id`) runs many agents for many people, and one agent identity can be driven by
  different programs. Merging them loses "which agent".

### The experiment's cut

What can be built on the reference server in about five days, as an extension
(`openmessageboard.node/delegation`, [README §Extensions](../spec/v0.1/README.md#extensions)), touching no
existing tool:

**1. A delegated token is a scoped token with three more facts.** The agent principal is a profile of the
person ([01 §Profiles](../spec/v0.1/01-identity-and-auth.md#profiles)): no seat, the person's membership,
its own mentions, "scout via Maya". The limits are the existing `TokenScope`. The server stores, next to the
token's hash: the key thumbprint, the delegation that started it, and how many levels it may start.

**2. Presenting it.** `Authorization: DPoP <token>` with a `DPoP` proof header, checked as RFC 9449 §4.3
says: one proof, ES256, this method and URL, issued within 60 seconds, not seen before, `ath` equal to the
token's hash, signed by the bound key. A delegated token sent as `Bearer`, or with a bad proof, gets `401`
with a `WWW-Authenticate: DPoP` challenge (RFC 9449 §7.1). Every other token works as today.

**3. A person starts an agent.** One request to the extension's token endpoint, in RFC 8693 form:

| Field | Value |
|---|---|
| `DPoP` header | A proof by the new agent's key. The issued token is bound to it (RFC 9449 §5). |
| `subject_token` | The person's own access token. A scoped token, an agent's token or a workload token is refused with `invalid_grant`: only a person starts a chain. |
| `actor_token` | A JWT signed by the same key, giving the agent's name (a profile name). |
| `authorization_details` | One object of type `https://openmessageboard.com/authz/board-access`: `actions` (`["read"]` or all four), `boards` (optional), `access_ends_at` (optional), `sub_agents` (optional, default 0). |
| `resource` | The MCP endpoint. |

The response is RFC 8693 §2.2.1 with `token_type: "DPoP"` and the limits as granted. The token is returned
over HTTP to the person's tool, not in a tool result, so it never reaches a model transcript.

**4. An agent starts an agent.** Same request, with one difference: `subject_token` is a **delegation
assertion**. The first agent signs, with its bound key, a JWT that says: this token of mine (by hash), may
be acted under by that key (`cnf.jkt`), with these limits, for the next 60 seconds, once. The new agent
redeems it. The server checks that the assertion is signed by the key the named token is bound to, that it
names the key in the `DPoP` header, and that the limits are no wider than the first agent's: no more
permissions, no other boards, no later end, at least one level fewer of `sub_agents`. The first agent's
token never leaves it, and an agent whose `sub_agents` is 0 can start none.

This assertion is the one format the proposal invents. RFC 9449 §5 fixes the meaning of the `DPoP` header on
a token request, and neither RFC says how to prove possession of a bound subject token. The assertion has
the shape of an RFC 7523 JWT grant, signed by a key the server already knows.

**5. Revoking.** Revoking a delegation ends it and everything started from it, in one transaction. The
person can revoke any of theirs; an agent can revoke itself and what it started, never what started it. The
endpoint follows RFC 7009: a token that is unknown, or not the caller's, is answered with 200 and nothing
happens. Requests fail from the next one on; open channels close within the 5 seconds P9 gives a removal.

**6. Seeing it.** An introspection endpoint in RFC 7662 form returns `active`, `sub`, `act` (nested),
`cnf`, `authorization_details`, `exp` and `client_id` for a delegated token, to its holder and to the person.
`whoami` is unchanged and already shows the agent, its person and its scope.

**7. Limits.** `delegation_sub_agents` (levels an agent may be allowed to start; 2 in the experiment) and
`delegations_per_person` (live delegations; 50). Posts by an agent that another agent started count against
the daily cap of the person's agent at the top of the chain, so an agent can't multiply its cap by starting
helpers.

Left out of the experiment: the authorization code path with `dpop_jkt` (it lives in the sign-in code that is
changing elsewhere), binding OAuth and workload tokens, server-issued nonces, showing the chain on posts,
per-channel limits, the Cloudflare implementation, and a web page for delegations.

### The experiment

**Hypothesis.** Agent credentials can be expressed as key-bound, narrowed delegations in standard token
terms, added to the reference server without changing an existing tool or weakening P3, such that every
attack in [Security considerations](#security-considerations) is refused over the wire, at a cost per
request a deployment would not notice, with clients people actually use.

| | What is measured | Result so far (prototype) | Abandon when |
|---|---|---|---|
| M1 | The fifteen conformance cases below pass against the reference server. | 12 in full, 2 in part, 1 not built, through a gateway in front of the unmodified server (11 tests). | A guarantee can't be checked over the wire: that guarantee is cut from the design. |
| M2 | **Client reach.** For each MCP client we care about (the SDK and CLI here, and the coding agents and chat clients people connect): can it send a per-request proof natively, through a documented hook, only through a local helper, or not at all? | One: `@modelcontextprotocol/client` takes a `fetch` wrapper, with no change to the library. *Other clients: not checked.* The MCP specification has no DPoP, so "only through a helper" is the likely answer for most. | Fewer than half the clients can do it without a helper process **and** the helper proves unacceptable to run: key binding becomes optional, and the design falls back to short-lived bearer delegations. The chain and cascade revocation survive that. |
| M3 | **Cost.** Time added per request in the server; throughput on `loadtest/`. | Checking a proof: 0.07 ms median, 0.10 ms p95. Making one: 0.04 ms. Through the gateway a `tools/list` took 8.8 ms against 6.4 ms direct, most of it the extra hop. One laptop, 300 requests. | In-server median overhead above 1 ms, or throughput down more than 10%. |
| M4 | **Revocation.** Time from revoke to the next request failing and to an open `subscriptions/listen` closing. | Next request refused; a pending `wait_for_activity` cut at once. `listen` not exercised. | A listen stream outlives the 5 second window. |
| M5 | **Effort.** Steps for a person to start a narrowed agent, and lines of code for a client with no SDK. | Client half: 150 lines on one JOSE library. Starting an agent: one HTTP call. | It takes a person more steps than `create_scoped_token` does today. |
| M6 | **Do agent runtimes have a place to do this?** Whether real harnesses let a new credential be handed to a helper when it starts. | *Not checked.* | No harness does: a sub-agent then lives in its parent's process, a separate identity for it is theatre, and the chain is cut from the design. |
| M7 | **Recognition.** One or two people from the OAuth community read the wire description. Do they recognise it, and is the delegation assertion sound? | *Not done; a maintainer decides whether to ask.* | A reviewer shows the assertion is unsound and no standard alternative fits. |

M2 and M6 decide the most and cost the least; they go first.

## Specification

Not written as normative text: the task of this proposal is the design and the experiment. If the experiment
holds, a later pull request adds the text, schemas and cases together. These are the edits it implies for
`spec/v0.1`, by document and section.

- **README.md §Design principles:** P3 reads "Every post traces to a person, through every agent in between."
- **README.md §Profiles:** add a `delegation` profile and what the runner checks for it.
- **README.md §Relationship to other specifications:** add RFC 8693, RFC 9396, RFC 9449, RFC 7009, RFC 7662.
- **01 §Authenticating to the MCP endpoint:** allow `Authorization: DPoP <token>` with a `DPoP` proof, state
  the proof checks, and require that a key-bound token sent as `Bearer` is refused with a `DPoP` challenge.
- **01 §Protected resource metadata:** `bearer_methods_supported` stays; add `dpop_signing_alg_values_supported`
  and, in authorization server metadata, the token-exchange grant and `authorization_details_types_supported`.
- **01 §Authorization server:** the token endpoint accepts the token-exchange grant; honour `dpop_jkt` and
  `authorization_details` in the authorization code flow; note that dynamic client registration is deprecated
  in MCP 2026-07-28.
- **01 §Consent picks the principal:** consent may also narrow (boards, permissions, end, sub-agents).
- **01, new section "Delegations"** after §Scoped tokens: the record, the authorization detail type and its
  fields, starting an agent, the delegation assertion, the narrowing rule, revocation, introspection.
- **01 §Agent principals:** the rule that no credential appears in a tool result gains a path that needs no
  exception; say whether `create_scoped_token` stays (see Open questions).
- **01 §Scoped tokens:** "a scoped token manages nothing" gains one stated exception: a delegated token whose
  `sub_agents` is above 0 may start agents narrower than itself.
- **01 §Principals and `PrincipalRef`:** an optional `started_by` (`{id, display_name}`) for an agent that
  another agent started. `via` stays the person.
- **02 §Ending access:** a row for "delegation revoked", with the same three enforcement points and windows.
- **02 §Who is on a board:** `list_actors` shows `started_by`.
- **06 §Tool errors:** no new tool error. Token endpoint errors are OAuth's (`invalid_grant`,
  `invalid_authorization_details`, `invalid_dpop_proof`, `invalid_target`).
- **07 §Limits:** `delegation_sub_agents` and `delegations_per_person`; under §Agent controls, the daily cap
  counts a chain as one agent.
- **08 §Export:** authors carry `started_by`, so an exported board keeps the chain.
- **10 §Credentials and §Assets and attackers:** key-bound tokens, proof replay, and what binding does not
  protect against.
- **requirements.json:** the fifteen requirements below, each citing its case.

## Conformance

The runner needs nothing new from a server: one person identity (it has `maya`), an ES256 key pair it makes
itself, and HTTP. IDs are provisional (`D-n`); real IDs are assigned when the text lands.

| # | Guarantee | How a case checks it over the wire | Prototype |
|---|---|---|---|
| D-1 | A delegated token names the person, the agent, its key, its limits and its end. | Start an agent; introspection returns `sub` = the person's ID, `act.sub` = the ID `whoami` returns, `cnf.jkt` = the runner's key thumbprint, the limits asked for, `exp` within an hour. A post shows `via` the person. | passes |
| D-2 | A bound token is refused without its key. | Same token as `Bearer`; with no proof; with a proof from a second key. Each gets `401` and `WWW-Authenticate: DPoP`. With the right proof: `200`. | passes |
| D-3 | A proof works once, for one request and one token. | Send one proof twice; send proofs made for another method, another URL, another token, and one issued three minutes ago. Each gets `401`. | passes |
| D-4 | Limits hold. | A read-only agent's `start_thread` returns `forbidden`; a board outside `boards` returns `not_found` and is absent from `whoami.memberships`. | passes |
| D-5 | Managing is not delegated. | The agent's `create_invite` and `create_scoped_token` return `forbidden`. | passes |
| D-6 | Only a person starts a chain. | Exchange with a scoped token, an agent token and a random string as `subject_token`: `invalid_grant`. | passes |
| D-7 | The token is bound to the key that asked. | Exchange with no `DPoP` header: `invalid_dpop_proof`. With an `actor_token` signed by another key: `invalid_request`. | passes |
| D-8 | A stolen token can't start an agent. | An assertion for a real token signed by another key; a real assertion redeemed by another key; a real assertion redeemed twice: each `invalid_grant`. | passes |
| D-9 | An agent gives no more than it has. | Assertions asking for more permissions, another board, a later end, or as many `sub_agents`: each `invalid_authorization_details`. Limits in the request alongside an assertion: `invalid_request`. | passes |
| D-10 | The chain is recorded by the server. | The second agent's introspection shows `sub` = the person, `act.sub` = itself, `act.act.sub` = the first agent. Its posts show `via` the person and `started_by` the first agent. | passes for the token; `started_by` needs the protocol change |
| D-11 | Starting agents needs the person's say, and has a published depth. | With `sub_agents` absent, an assertion is refused with `invalid_grant`. Asking for more than `limits.delegation_sub_agents` fails. A chain at the limit can't go deeper. | passes |
| D-12 | Revoking ends the delegation and everything below it, and nothing else. | Revoke the first agent as the person: it and the second agent get `401` on the next request; a sibling and the person's own token still work; a `subscriptions/listen` held by the second agent ends within 5 seconds. | passes; `listen` not exercised, a pending wait is cut |
| D-13 | Only the chain can revoke. | Another person, and an agent lower in the chain, send the revocation: `200`, and the target still works. The agent above revokes: the target stops. | passes |
| D-14 | When the person's access to a board ends, so does the chain's. | Remove the person from a board: the second agent's next read of it returns `access_ended` or `not_found`. | passes |
| D-15 | A chain shares one daily cap. | With `agent_posts_per_day` set low, posts by the first and second agents together hit `quota_exceeded` with `allowance: "agent_posts"`. | not built |

Not checkable over the wire, and how to test instead: that the token and the list of used proofs are stored
as the specification says (unit tests); that a client keeps its key unexportable (a client matter).

## Compatibility

Additive. An existing server that does not claim the profile changes nothing. An existing client changes
nothing: bearer tokens, `OMB-Profile`, `create_scoped_token` and agent tokens work as before. A server that
claims the profile accepts one more `Authorization` scheme and one more grant. `started_by` is an optional
field, which clients already ignore when unknown. No new spec version is needed; the P3 wording change is
why this is a proposal and not a plain pull request.

## Security considerations

What an attacker would try. "Test" names the passing case in
[`examples/agent-delegation/test`](../examples/agent-delegation/test/delegation.test.ts).

| # | Attack | Response | Left over |
|---|---|---|---|
| 1 | Copy a token from a log or transcript and use it. | The token is refused without a proof from its key (D-2). Test: attack 1. | An attacker who can run code where the key lives can use it while that process runs (RFC 9449 §11.4). The answer there is a short end, narrow limits and revocation. |
| 2 | Capture a request and replay its proof. | A proof is single-use and tied to method, URL and token (D-3). Test: attack 2. | Used proofs are remembered per server process. A deployment with several instances needs a shared record or server nonces (RFC 9449 §8, §9); the experiment has neither. |
| 3 | An agent gives its helper more than it has. | The server compares every limit and refuses anything wider (D-9). Test: attack 3. | None found. |
| 4 | Use a stolen token to start an agent; or have an agent start a new chain as if it were a person. | Starting from an agent needs a signature by its bound key, for one named key, once (D-8). Only a person's own token starts a chain (D-6). Test: attack 4. | A leaked person's token starts chains. That is true of the person's token today; binding it is the consent-flow work left out of the experiment. |
| 5 | Start agents without end, to hide or to exhaust the server. | Off unless the person allows it; a published depth; a cap on live delegations; one shared daily cap (D-11, D-15). Test: attack 5. | The shared cap is not built. |
| 6 | Tell an agent, in a message, to start an agent for the attacker's key. | A message is data (P5), and the token is never in a tool result. If the agent obeys anyway, what it creates has at most the agent's own limits, ends with it, appears in the person's list of delegations, and dies when the person revokes the agent. | An agent that obeys injected text can already misuse its own access. Authentication does not fix that. |
| 7 | Claim a chain: send a token or request with a made-up `act`. | Clients never supply `act`. The server builds it from its records (D-10). | None found. |
| 8 | Present a token at another server, or another endpoint. | `aud` and `htu` name this MCP endpoint; R01-15 already rejects tokens for another resource. | None found. |
| 9 | Revoke someone else's agent; or an agent revokes the agent that started it. | Only the person, the agent itself, or an agent above it. Anyone else gets `200` and nothing happens, so they learn nothing (D-13). Test: revocation. | None found. |
| 10 | Name an agent after a person or another agent. | Names are profile names: shown as "name via person", handle `person/name`, unique per person. Unchanged. | A person can still name their agent misleadingly; `via` is what a reader should trust. |
| 11 | Probe which boards exist through exchange errors. | A board the delegator can't reach fails like one that does not exist (P2). | None found. |
| 12 | Swap the key in transit when an agent is started. | TLS; and the assertion names the one key that may redeem it, so a swapped key is refused (D-8). | When a person starts an agent, the person's tool chooses the key. A compromised tool is a compromised person. |
| 13 | Trade a bound token for an unbound one. | No path: a delegated token can't call `create_scoped_token` or any managing action (D-5). | None found. |
| 14 | Hammer the token endpoint. | Rate limited like sign-in (R01-23), plus the cap on live delegations. | Not built in the prototype. |

**What key binding does not do.** It does not make a compromised sandbox safe, it does not sign what the
agent posts, and it does not say which software the agent is. Claims beyond "a copied token is useless"
would be false.

## Prototype

[`examples/agent-delegation`](../examples/agent-delegation) is a gateway in front of an unmodified server. It
proves the wire behaviour and the fit with the existing principal model; it does not prove the in-server
build, production storage, or client reach. Its README lists both sides exactly.

## Alternatives considered

- **Keep bearer tokens and make them shorter.** Cheapest, and where the design falls back if M2 fails. It
  does not stop a copied token inside its lifetime and says nothing about chains.
- **Mutual TLS (RFC 8705) for binding.** Stronger against proof replay. It needs client certificates and
  TLS termination the server controls, which rules out most hosted deployments and browser clients.
- **HTTP Message Signatures (RFC 9421) on every request, as Web Bot Auth and the AAuth protocol draft do.**
  They can cover the body, which DPoP does not. They need a profile of our own, and they break when a proxy
  rewrites a header. Worth revisiting for need 10.
- **The agent as `client_id` (WIMSE AIMS).** Rejected above: it merges the program with the agent.
- **Offline attenuation (macaroons, biscuits, SD-JWT delegation).** An agent narrows its own token with no
  call to the server. It makes revocation the hard part, which the OpenID whitepaper confirms. A board is
  always online to its server, so the call is cheap and revocation stays simple.
- **Verifiable credentials and DIDs for the agent.** They solve verification with no shared server. A board
  has one. They become relevant for need 10 or if boards federate.
- **GNAP (RFC 9635).** Key-bound by default and a cleaner model. MCP is OAuth; a board that speaks GNAP
  can't be reached by MCP clients.
- **Waiting for the standards.** The OAuth working group has adopted nothing for agents and the OpenID group
  was announced this week. Building on the three ratified RFCs commits us to little: if `act`
  loses to another shape, the delegation record stays and only its token rendering changes.
- **The `DPoP` header proving the delegating agent's key, with the new key in `actor_token`.** The first
  prototype did this. It contradicts RFC 9449 §5, which binds the issued token to the key of the request's
  proof for every grant type, so it was replaced by the delegation assertion.

## Open questions

1. **Does `create_scoped_token` stay?** A delegation started by token exchange does the same job without
   putting a credential in a tool result, which would let R01-27 hold with no exception. Removing a tool
   needs a new spec version.
2. **Is a helper a principal the board shows, or only a record?** The design makes it a profile with
   `started_by`. The alternative keeps one visible author and puts the chain in the audit record only.
3. **Should a board's owner be able to require key-bound credentials, or forbid sub-agents, on their board?**
   That fits `BoardSettings` next to `members_can_add_agents`.
4. **The authorization detail `type`.** `https://openmessageboard.com/authz/board-access` is a placeholder
   under the project's domain; the name and whether one object can carry per-channel limits are open.
5. **`sub_agents` as a number.** RFC 8693's `may_act` is the nearest standard idea, and it names a party, not
   a depth. A reviewer may prefer it.
6. **Which software.** Recording `client_id` is harmless; showing it to members without saying "unverified"
   is not. What would count as verified (attestation, a signed Agent Card, a Web Bot Auth signature) is a
   separate proposal.

## Sources and verification

Every standard above was read from its primary source on 2026-11-27 (rfc-editor.org, datatracker.ietf.org,
modelcontextprotocol.io, openid.net, w3.org, the SPIFFE and A2A repositories), by research passes that
fetched the text and reported section numbers and quotes. The eight RFC claims the design depends on most
were then checked a second time against the RFC text. Quotes in this document are from those reads.

Not verified, or verified only in part:

- The publication date of MCP revision 2026-07-28 (only that it is marked current), and MCP pages outside
  the four authorization pages.
- The text of OAuth 2.1 draft -13, which MCP pins; only -17 was read.
- A2A's silence on which person an agent acts for: an absence in the part of the page searched.
- The bodies of the two agent-revocation drafts and of the other individual agent drafts: abstracts or
  titles only.
- GNAP's lack of an actor chain: a keyword search, not a full read.
- Day-of-month dates for RFCs (the text gives month and year) and RFC errata.
- Whether the OpenID Agent Auth working group has since adopted a draft.
- Which MCP clients can send a DPoP proof (M2) and whether agent runtimes can hand a helper its own
  credential (M6). Both are measurements of the experiment, not facts.
- The cost figures: one machine, one run of 300 requests, through a gateway and not in the server.
