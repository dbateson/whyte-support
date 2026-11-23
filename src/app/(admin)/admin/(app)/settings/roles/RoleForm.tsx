import { Button, Checkbox, Fieldset, Stack, TextField } from "@whyte/design-system";
import { ActionForm } from "@/components/ActionForm";
import { PERMISSIONS, type Permission } from "@/lib/auth/permissions";
import { saveRoleAction } from "../actions";

/** Create or edit a role. The built-in Admin role keeps every permission: only its description can change. */
export function RoleForm({ role }: { role?: { id: string; name: string; description: string; permissions: string[]; segments: string[]; isSystem: boolean } }) {
  const locked = role?.isSystem && role.name === "Admin";
  const groups = [...new Set(Object.values(PERMISSIONS).map((p) => p.group))];
  return (
    <ActionForm action={saveRoleAction} label="Role" gap="standard">
      {role && <input type="hidden" name="id" value={role.id} />}
      <Stack gap="small">
        <TextField label="Name" name="name" defaultValue={role?.name} required disabled={locked} />
        {locked && <input type="hidden" name="name" value={role!.name} />}
        <TextField label="What it's for" name="description" defaultValue={role?.description} />
      </Stack>
      <Fieldset legend="Segments" help="Ticket, knowledge-base and chat permissions apply only in these." columns={2}>
        <Checkbox name="segments" value="b2c" label="B2C" description="Riders" defaultChecked={role ? role.segments.includes("b2c") : true} disabled={locked} />
        <Checkbox name="segments" value="b2b" label="B2B" description="Dealers and trade" defaultChecked={role ? role.segments.includes("b2b") : true} disabled={locked} />
      </Fieldset>
      {locked && ["b2c", "b2b"].map((s) => <input key={s} type="hidden" name="segments" value={s} />)}
      {groups.map((g) => (
        <Fieldset key={g} legend={g} columns={2}>
          {(Object.entries(PERMISSIONS) as [Permission, (typeof PERMISSIONS)[Permission]][])
            .filter(([, p]) => p.group === g)
            .map(([key, p]) => (
              <Checkbox key={key} name="permissions" value={key} label={p.label} defaultChecked={role?.permissions.includes(key)} disabled={locked} />
            ))}
        </Fieldset>
      ))}
      <div className="ds-inline">
        <Button type="submit">{role ? "Save role" : "Create role"}</Button>
      </div>
    </ActionForm>
  );
}
