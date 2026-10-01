import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useOrgAdmins,
  useCreateOrgAdmin,
  useToggleOrgAdminStatus,
  useResendOrgAdminActivation,
} from "@/hooks/queries/use-org-admins";
import { useConfirm } from "@/providers/confirm-dialog-provider";

interface Props {
  organisationId?: string;
}

interface AddForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

const EMPTY_FORM: AddForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
};
const ADD_ACTION_BUTTON_CLASS =
  "border-primary/30 text-primary hover:bg-primary/10 hover:text-primary";

export function OrgAdminsManager({ organisationId }: Props) {
  const { data: admins = [], isLoading } = useOrgAdmins(organisationId);
  const createAdmin = useCreateOrgAdmin(organisationId);
  const toggleStatus = useToggleOrgAdminStatus(organisationId);
  const resendActivation = useResendOrgAdminActivation();
  const confirm = useConfirm();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof AddForm, string>>>(
    {},
  );

  function validate(): boolean {
    const errs: typeof errors = {};
    if (!form.firstName.trim()) errs.firstName = "First name is required.";
    if (!form.lastName.trim()) errs.lastName = "Last name is required.";
    if (!form.email.trim()) {
      errs.email = "Email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errs.email = "Enter a valid email address.";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleAdd() {
    if (!validate()) return;
    try {
      await createAdmin.mutateAsync({
        first_name: form.firstName.trim(),
        last_name: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
      });
      setForm(EMPTY_FORM);
      setErrors({});
      setDialogOpen(false);
    } catch {
      // toast shown by mutation onError — keep dialog open so user can fix
    }
  }

  function handleResend(id: string, name: string) {
    confirm({
      title: "Resend activation email",
      description: `Resend the activation link to ${name}? The previous link stays valid until it expires.`,
      confirmText: "Resend",
      onConfirm: async () => {
        await resendActivation.mutateAsync(id);
      },
    });
  }

  function handleToggle(id: string, name: string, currentStatus: string) {
    const newStatus = currentStatus === "active" ? "inactive" : "active";
    confirm({
      title: `${newStatus === "inactive" ? "Deactivate" : "Activate"} Admin`,
      description: `Are you sure you want to ${newStatus === "inactive" ? "deactivate" : "activate"} ${name}? ${newStatus === "inactive" ? "They will lose access to the organisation." : "They will regain access to the organisation."}`,
      confirmText: newStatus === "inactive" ? "Deactivate" : "Activate",
      variant: newStatus === "inactive" ? "destructive" : "default",
      onConfirm: async () => {
        await toggleStatus.mutateAsync({ id, status: newStatus });
      },
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {admins.length} admin{admins.length !== 1 ? "s" : ""}
        </p>
        <Button size="sm" variant="success" onClick={() => setDialogOpen(true)}>
          <Plus />
          Add Admin
        </Button>
      </div>

      <div className="rounded-xl border overflow-hidden overflow-x-auto bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Name
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Email
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Phone
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                Status
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 text-right">
                Active
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-20 text-center text-muted-foreground"
                >
                  No org admins found.
                </TableCell>
              </TableRow>
            ) : (
              admins.map((admin) => (
                <TableRow key={admin.id}>
                  <TableCell className="font-medium">
                    {admin.first_name} {admin.last_name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {admin.email}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {admin.phone ?? "—"}
                  </TableCell>
                  <TableCell>
                    {admin.activation_pending ? (
                      <div className="flex items-center gap-2">
                        <Badge className="border-amber-200 bg-amber-100 text-amber-800 hover:bg-amber-100">
                          Pending activation
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-primary hover:text-primary"
                          onClick={() =>
                            handleResend(
                              admin.id,
                              `${admin.first_name} ${admin.last_name}`,
                            )
                          }
                          disabled={resendActivation.isPending}
                        >
                          <RefreshCw />
                          Resend
                        </Button>
                      </div>
                    ) : admin.status === "active" ? (
                      <StatusBadge status="active" />
                    ) : (
                      <StatusBadge status="inactive" />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={admin.status === "active"}
                      onCheckedChange={() =>
                        handleToggle(
                          admin.id,
                          `${admin.first_name} ${admin.last_name}`,
                          admin.status,
                        )
                      }
                      disabled={
                        toggleStatus.isPending || admin.activation_pending
                      }
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Add Admin Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Org Admin</DialogTitle>
            <DialogDescription>
              An activation email will be sent to the new admin.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-3">
                <Label>
                  First Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={form.firstName}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, firstName: e.target.value }))
                  }
                  className={errors.firstName ? "border-destructive" : ""}
                />
                {errors.firstName && (
                  <p className="text-xs text-destructive">{errors.firstName}</p>
                )}
              </div>
              <div className="space-y-3">
                <Label>
                  Last Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={form.lastName}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, lastName: e.target.value }))
                  }
                  className={errors.lastName ? "border-destructive" : ""}
                />
                {errors.lastName && (
                  <p className="text-xs text-destructive">{errors.lastName}</p>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <Label>
                Email <span className="text-destructive">*</span>
              </Label>
              <Input
                type="email"
                placeholder="admin@example.com"
                value={form.email}
                onChange={(e) =>
                  setForm((p) => ({ ...p, email: e.target.value }))
                }
                className={errors.email ? "border-destructive" : ""}
              />
              <p className="text-xs text-muted-foreground">
                Please use a separate admin email, not the same as the
                employee's organisation email. Using the same email may cause
                permission conflicts.
              </p>
              {errors.email && (
                <p className="text-xs text-destructive">{errors.email}</p>
              )}
            </div>
            <div className="space-y-3">
              <Label>
                Phone{" "}
                <span className="text-muted-foreground text-xs font-normal">
                  (optional)
                </span>
              </Label>
              <Input
                placeholder="+91 98765 43210"
                value={form.phone}
                onChange={(e) =>
                  setForm((p) => ({ ...p, phone: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={handleAdd}
              disabled={createAdmin.isPending}
            >
              {createAdmin.isPending ? "Adding..." : "Add Admin"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
