// Creates the first admin and prints a one-time link to set their password.
//   DATABASE_URL=... npm run admin:create -- jo@whyte.bike "Jo Smith" https://support.whytebikes.com
// The link works for 7 days. Sign-in then asks them to set up an authenticator app.
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

const [email, name, baseUrl] = process.argv.slice(2);
if (!process.env.DATABASE_URL || !email || !name || !baseUrl) {
  console.error('Usage: DATABASE_URL=... npm run admin:create -- <email> "<name>" <site url>');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
try {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql.begin(async (tx) => {
    const [admin] = await tx`select id from roles where name = 'Admin' and is_system`;
    if (!admin) throw new Error("The Admin role is missing: run the migrations first.");
    const [user] = await tx`
      insert into users (email, name, status) values (${email.toLowerCase()}, ${name}, 'invited')
      on conflict (email) do update set name = excluded.name
      returning id, status`;
    if (user!.status === "disabled") throw new Error("That user is disabled.");
    await tx`insert into user_roles (user_id, role_id) values (${user!.id}, ${admin.id}) on conflict do nothing`;
    await tx`delete from auth_tokens where user_id = ${user!.id} and purpose = 'invite'`;
    await tx`insert into auth_tokens (id, user_id, purpose, expires_at) values (${hash}, ${user!.id}, 'invite', now() + interval '7 days')`;
    await tx`insert into audit_log (actor_label, action, target) values ('script:create-admin', 'user.invite', ${email.toLowerCase()})`;
  });
  console.log(`Admin ${email} is ready. Open this link to set a password (valid for 7 days, shown once):`);
  console.log(`${baseUrl.replace(/\/$/, "")}/admin/accept?token=${token}`);
} finally {
  await sql.end();
}
