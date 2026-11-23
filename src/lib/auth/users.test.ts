import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, useTestDatabase } from "@/test/db";
import { hashPassword, verifyPassword } from "./password";
import { claimTotpStep, decryptTotpSecret, encryptTotpSecret, inviteUser, peekToken, setPasswordWithToken, setUserDisabled, setUserRoles } from "./users";

describe.skipIf(!TEST_DATABASE_URL)("staff accounts", () => {
  const { sql, reset } = useTestDatabase();
  const actor = { label: "Test admin" };
  let adminRole = "";
  let agentRole = "";

  beforeEach(async () => {
    await reset();
    const roles = await sql`select id, name from roles`;
    adminRole = roles.find((r) => r.name === "Admin")!.id;
    agentRole = roles.find((r) => r.name === "Agent")!.id;
  });
  afterAll(async () => {
    await sql.end();
  });

  it("invites, then a one-time link sets the password and activates", async () => {
    const { userId, link, emailed } = await inviteUser({ email: "New@Whyte.test", name: "New Person", roleIds: [agentRole] }, actor, "https://support.test/");
    expect(emailed).toBe(false); // no sender configured
    expect(link).toMatch(/^https:\/\/support\.test\/admin\/accept\?token=[\w-]{43}$/);
    const token = new URL(link).searchParams.get("token")!;
    const [stored] = await sql`select id from auth_tokens where user_id = ${userId}`;
    expect(stored!.id).not.toBe(token); // only the hash is stored
    expect(await peekToken(token, "reset")).toBeNull(); // wrong purpose
    expect((await peekToken(token, "invite"))?.email).toBe("new@whyte.test");

    const user = await setPasswordWithToken(token, "invite", await hashPassword("a long enough passphrase"), "Renamed");
    expect(user?.id).toBe(userId);
    const [u] = await sql`select status, name, password_hash from users where id = ${userId}`;
    expect(u).toMatchObject({ status: "active", name: "Renamed" });
    expect(await verifyPassword("a long enough passphrase", u!.password_hash)).toBe(true);
    expect(await setPasswordWithToken(token, "invite", "x")).toBeNull(); // used up
    await expect(inviteUser({ email: "new@whyte.test", name: "Again", roleIds: [] }, actor, "https://s")).rejects.toThrow(/already/);
  });

  it("won't remove or disable the last active admin", async () => {
    const [a] = await sql`insert into users (email, name, status) values ('a@w.test', 'A', 'active') returning id`;
    await sql`insert into user_roles values (${a!.id}, ${adminRole})`;
    await expect(setUserRoles(a!.id, [agentRole], actor)).rejects.toThrow(/last active admin/);
    await expect(setUserDisabled(a!.id, true, actor)).rejects.toThrow(/last active admin/);
    const [b] = await sql`insert into users (email, name, status) values ('b@w.test', 'B', 'active') returning id`;
    await sql`insert into user_roles values (${b!.id}, ${adminRole})`;
    await setUserRoles(a!.id, [agentRole], actor);
    const audit = await sql`select action, detail from audit_log where action = 'user.roles'`;
    expect(audit[0]!.detail).toEqual({ roles: ["Agent"] });
  });

  it("encrypts authenticator secrets per user and refuses a code twice", async () => {
    const [u] = await sql`insert into users (email, name, status) values ('t@w.test', 'T', 'active') returning id`;
    const stored = encryptTotpSecret(u!.id, "JBSWY3DPEHPK3PXP");
    expect(decryptTotpSecret(u!.id, stored)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptTotpSecret("00000000-0000-4000-8000-000000000000", stored)).toThrow();
    expect(await claimTotpStep(u!.id, 100)).toBe(true);
    expect(await claimTotpStep(u!.id, 100)).toBe(false);
    expect(await claimTotpStep(u!.id, 99)).toBe(false);
    expect(await claimTotpStep(u!.id, 101)).toBe(true);
  });
});
