import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, can, segmentsFor, SYSTEM_ROLES } from "./permissions";

const role = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!;

describe("permissions", () => {
  it("limits segmented permissions to the role's segments", () => {
    const b2b = [role("B2B Agent")];
    expect(can(b2b, "tickets.reply", "b2b")).toBe(true);
    expect(can(b2b, "tickets.reply", "b2c")).toBe(false);
    expect(can(b2b, "tickets.reply")).toBe(true);
    expect(segmentsFor(b2b, "tickets.view")).toEqual(["b2b"]);
  });

  it("combines roles", () => {
    const roles = [role("B2B Agent"), role("Read-only")];
    expect(can(roles, "tickets.view", "b2c")).toBe(true);
    expect(can(roles, "tickets.reply", "b2c")).toBe(false);
    expect(segmentsFor(roles, "tickets.view")).toEqual(["b2c", "b2b"]);
  });

  it("treats global permissions as segment-free", () => {
    const admin = [{ permissions: ["settings.manage"], segments: ["b2b"] }];
    expect(can(admin, "settings.manage", "b2c")).toBe(true);
    expect(segmentsFor(admin, "settings.manage")).toEqual(["b2c", "b2b"]);
  });

  it("grants nothing without roles, and Admin everything", () => {
    expect(can([], "tickets.view")).toBe(false);
    expect(ALL_PERMISSIONS.every((p) => can([role("Admin")], p, "b2c"))).toBe(true);
    expect(can([role("Read-only")], "tickets.update")).toBe(false);
  });
});
