import type { Staff } from "../auth/session";
import type { KbAudience, Segment } from "../db/schema";
import type { Permission } from "../auth/permissions";

/** The segments an audience covers. */
export const audienceSegments = (a: KbAudience): Segment[] => (a === "both" ? ["b2c", "b2b"] : [a]);

/** Changing an article needs the permission in every segment it's for. */
export function canChange(staff: Staff, permission: Extract<Permission, "kb.edit" | "kb.approve">, audience: KbAudience): boolean {
  return audienceSegments(audience).every((s) => staff.can(permission, s));
}

/** Seeing one needs kb.view in any segment it's for. */
export function canSee(staff: Staff, audience: KbAudience): boolean {
  return audienceSegments(audience).some((s) => staff.can("kb.view", s));
}

/** The audiences someone may see: both-segment articles count if they see either. */
export function visibleAudiences(staff: Staff): KbAudience[] {
  const segs = staff.segmentsFor("kb.view");
  if (segs.length === 0) return [];
  return [...segs, "both"];
}

export const AUDIENCE_LABELS: Record<KbAudience, string> = { b2c: "B2C", b2b: "B2B", both: "B2C and B2B" };
