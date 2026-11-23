"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/ActionForm";
import { requireStaff } from "@/lib/auth/session";
import { eraseSubject } from "@/lib/privacy/service";
import { baseUrl } from "@/lib/request";

const ZOHO_TEXT = {
  task: "A task to erase the Zoho copy was created in Zoho CRM.",
  "not-linked": "There was nothing in Zoho to erase.",
  "not-connected": "Zoho isn't connected: erase the Zoho copy by hand.",
  failed: "Creating the Zoho task failed: erase the Zoho copy by hand (reconnecting Zoho grants the permission it needs).",
} as const;

export async function eraseAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("gdpr.process");
  const contactId = String(data.get("contactId") ?? "");
  if (String(data.get("confirm") ?? "").trim().toUpperCase() !== "ERASE") return { error: 'Type ERASE to confirm. This can\'t be undone.' };
  const r = await eraseSubject(contactId, { id: staff.id, label: staff.name }, await baseUrl(), { askZoho: data.get("zoho") === "on" });
  if (!r) return { error: "That person has already been erased, or wasn't found." };
  revalidatePath("/admin/privacy");
  const cases = r.zohoCases.length ? ` Zoho cases: ${r.zohoCases.join(", ")}.` : "";
  return { notice: `Erased: ${r.tickets} tickets and ${r.files} files. ${ZOHO_TEXT[r.zoho]}${cases}`, done: Date.now() };
}
