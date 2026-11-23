import type { Segment } from "../db/schema";

/**
 * Everything a role can grant. Ticket and knowledge-base permissions apply
 * only within the role's segments (B2C, B2B or both); the rest are global.
 */
export const PERMISSIONS = {
  "tickets.view": { group: "Tickets", label: "View tickets", segmented: true },
  "tickets.reply": { group: "Tickets", label: "Reply to customers", segmented: true },
  "tickets.note": { group: "Tickets", label: "Add internal notes", segmented: true },
  "tickets.update": { group: "Tickets", label: "Change status, priority and details", segmented: true },
  "tickets.assign": { group: "Tickets", label: "Assign tickets", segmented: true },
  "tickets.create": { group: "Tickets", label: "Create tickets", segmented: true },
  "kb.view": { group: "Knowledge base", label: "View articles", segmented: true },
  "kb.edit": { group: "Knowledge base", label: "Write and edit drafts", segmented: true },
  "kb.approve": { group: "Knowledge base", label: "Approve and retire articles", segmented: true },
  "chat.view": { group: "Chatbot", label: "View conversations and sources", segmented: true },
  "analytics.view": { group: "Analytics", label: "View analytics", segmented: false },
  "users.manage": { group: "Administration", label: "Manage users and roles", segmented: false },
  "settings.manage": { group: "Administration", label: "Manage integrations and settings", segmented: false },
  "audit.view": { group: "Administration", label: "View the audit log", segmented: false },
  "gdpr.process": { group: "Administration", label: "Export and erase customer data", segmented: false },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(p: string): p is Permission {
  return Object.hasOwn(PERMISSIONS, p);
}

export interface RoleGrant {
  permissions: readonly string[];
  segments: readonly string[];
}

/**
 * Whether a set of roles grants a permission. For segmented permissions,
 * pass the segment to ask about one, or leave it out to ask "in any segment".
 */
export function can(roles: readonly RoleGrant[], permission: Permission, segment?: Segment): boolean {
  const segmented = PERMISSIONS[permission].segmented;
  return roles.some(
    (r) => r.permissions.includes(permission) && (!segmented || !segment || r.segments.includes(segment)),
  );
}

/** The segments in which the roles grant a permission (both, for global permissions). */
export function segmentsFor(roles: readonly RoleGrant[], permission: Permission): Segment[] {
  const out = new Set<Segment>();
  for (const r of roles) {
    if (!r.permissions.includes(permission)) continue;
    if (!PERMISSIONS[permission].segmented) return ["b2c", "b2b"];
    for (const s of r.segments) if (s === "b2c" || s === "b2b") out.add(s);
  }
  return (["b2c", "b2b"] as const).filter((s) => out.has(s));
}

/** The roles seeded on install. Admins can edit all but Admin's permissions, and add more. */
export const SYSTEM_ROLES: { name: string; description: string; permissions: Permission[]; segments: Segment[] }[] = [
  { name: "Admin", description: "Everything, in both segments.", permissions: ALL_PERMISSIONS, segments: ["b2c", "b2b"] },
  {
    name: "Agent",
    description: "Works B2C and B2B tickets.",
    permissions: ["tickets.view", "tickets.reply", "tickets.note", "tickets.update", "tickets.assign", "tickets.create", "kb.view", "chat.view"],
    segments: ["b2c", "b2b"],
  },
  {
    name: "B2B Agent",
    description: "Works dealer (B2B) tickets only.",
    permissions: ["tickets.view", "tickets.reply", "tickets.note", "tickets.update", "tickets.assign", "tickets.create", "kb.view", "chat.view"],
    segments: ["b2b"],
  },
  {
    name: "Read-only",
    description: "Sees tickets, articles, conversations and analytics; changes nothing.",
    permissions: ["tickets.view", "kb.view", "chat.view", "analytics.view"],
    segments: ["b2c", "b2b"],
  },
  {
    name: "KB Editor",
    description: "Writes, approves and retires knowledge-base articles.",
    permissions: ["kb.view", "kb.edit", "kb.approve", "tickets.view", "chat.view"],
    segments: ["b2c", "b2b"],
  },
];
