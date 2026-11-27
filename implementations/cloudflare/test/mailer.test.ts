import test from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "@openmessageboard/core";
import { createMailer, parseFrom } from "../src/mailer.ts";
import type { Env } from "../src/env.ts";

const outbox = () => ({ send: async () => {} });
const ctxWith = (mailFrom: string, testMode = false) => ({ config: { mailFrom, testMode } }) as unknown as AppContext;

test("parseFrom: a display name and an address, or an address alone", () => {
  assert.deepEqual(parseFrom("OpenMessageBoard <no-reply@board.example>"), { email: "no-reply@board.example", name: "OpenMessageBoard" });
  assert.deepEqual(parseFrom('"Board, The" <a@b.example>'), { email: "a@b.example", name: "Board, The" });
  assert.equal(parseFrom("<a@b.example>"), "a@b.example");
  assert.equal(parseFrom(" a@b.example "), "a@b.example");
});

test("mailer: sends through the EMAIL binding as plain text from OMB_MAIL_FROM", async () => {
  const sent: unknown[] = [];
  const env = { EMAIL: { send: async (m: unknown) => (sent.push(m), { messageId: "m1" }) } } as unknown as Env;
  const mailer = createMailer(env, outbox)(ctxWith("Board <no-reply@board.example>"));
  await mailer.send({ to: "maya@example.test", subject: "Your code", text: "123456", code: "123456" });
  assert.deepEqual(sent, [{ to: "maya@example.test", from: { email: "no-reply@board.example", name: "Board" }, subject: "Your code", text: "123456" }]);
});

test("mailer: a refused message fails the send without logging the address or the code", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => void logged.push(line));
  const env = { EMAIL: { send: async () => Promise.reject(Object.assign(new Error("nope"), { code: "E_SENDER_NOT_VERIFIED" })) } } as unknown as Env;
  const mailer = createMailer(env, outbox)(ctxWith("no-reply@board.example"));
  await assert.rejects(mailer.send({ to: "maya@example.test", subject: "Your code", text: "123456", code: "123456" }), /could not be sent/);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /E_SENDER_NOT_VERIFIED/);
  assert.doesNotMatch(logged[0]!, /maya|123456/);
});

test("mailer: without the binding, and in test mode, mail goes to the outbox mailer", async () => {
  let outboxed = 0;
  const counting = () => ({ send: async () => void outboxed++ });
  const binding = { send: async () => assert.fail("the binding must not be used") };
  await createMailer({} as Env, counting)(ctxWith("a@b.example")).send({ to: "x@example.test", subject: "s", text: "t" });
  await createMailer({ EMAIL: binding } as unknown as Env, counting)(ctxWith("a@b.example", true)).send({ to: "x@example.test", subject: "s", text: "t" });
  assert.equal(outboxed, 2);
});
