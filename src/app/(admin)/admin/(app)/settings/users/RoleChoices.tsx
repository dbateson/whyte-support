import { Checkbox, Fieldset } from "@whyte/design-system";

/** The roles as checkboxes, each with its description. */
export function RoleChoices({ roles, checked = [] }: { roles: { id: string; name: string; description: string }[]; checked?: string[] }) {
  return (
    <Fieldset legend="Roles" help="Permissions add up across roles." columns={2}>
      {roles.map((r) => (
        <Checkbox key={r.id} name="roles" value={r.id} label={r.name} description={r.description} defaultChecked={checked.includes(r.id)} />
      ))}
    </Fieldset>
  );
}
