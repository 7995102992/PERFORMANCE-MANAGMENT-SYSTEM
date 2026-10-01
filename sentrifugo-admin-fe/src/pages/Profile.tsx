/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useMemo } from "react";
import { Eye, EyeOff, User, ShieldCheck, Save } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/shared/DatePicker";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { useAppSelector } from "@/store";
import {
  useUpdateProfile,
  useChangePassword,
} from "@/hooks/queries/use-profile";
import { useMasterData } from "@/hooks/queries/use-master-data";
import { useLayoutVariant } from "@/contexts/layout-variant-context";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(firstName: string, lastName: string) {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase();
}

function toDateString(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.split("T")[0];
}

function parseLocalDate(iso: string): Date | undefined {
  if (!iso) return undefined;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

interface ProfileFormState {
  first_name: string;
  last_name: string;
  middle_name: string;
  phone: string;
  dob: string;
  gender: string;
  marital_status: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFormState(user: Record<string, any> | null): ProfileFormState {
  return {
    first_name: user?.first_name ?? "",
    last_name: user?.last_name ?? "",
    middle_name: user?.middle_name ?? "",
    phone: user?.phone ?? "",
    dob: toDateString(user?.dob),
    gender: user?.gender ?? "",
    marital_status: user?.marital_status ?? "",
  };
}

// ─── Profile Details Tab ─────────────────────────────────────────────────────

function ProfileDetailsTab() {
  const variant = useLayoutVariant();
  const user = useAppSelector((s) => s.auth.user);
  const orgId = useAppSelector((s) => s.organisation.savedOrganisation?.id);
  const { mutateAsync: updateProfile, isPending } = useUpdateProfile();
  const { data: genderOptions = [] } = useMasterData("GENDERS", orgId);
  const { data: maritalOptions = [] } = useMasterData(
    "MARITAL_STATUSES",
    orgId,
  );

  const [form, setForm] = useState<ProfileFormState>(() =>
    buildFormState(user),
  );
  const [baseline, setBaseline] = useState<ProfileFormState>(() =>
    buildFormState(user),
  );

  useEffect(() => {
    if (user) {
      const next = buildFormState(user);
      setForm(next);
      setBaseline(next);
    }
  }, [user]);

  const isDirty = useMemo(
    () =>
      (Object.keys(baseline) as (keyof ProfileFormState)[]).some(
        (k) => form[k] !== baseline[k],
      ),
    [form, baseline],
  );

  const set =
    (field: keyof ProfileFormState) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    await updateProfile({
      first_name: form.first_name || null,
      last_name: form.last_name || null,
      middle_name: form.middle_name || null,
      phone: form.phone || null,
      dob: form.dob ? `${form.dob}T00:00:00Z` : null,
      gender: form.gender || null,
      marital_status: form.marital_status || null,
    });
  };

  const fields = (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      <div className="space-y-2">
        <Label>
          First Name <span className="text-destructive">*</span>
        </Label>
        <Input
          value={form.first_name}
          onChange={set("first_name")}
          placeholder="Enter first name"
          required
          disabled={isPending}
        />
      </div>
      <div className="space-y-2">
        <Label>
          Last Name <span className="text-destructive">*</span>
        </Label>
        <Input
          value={form.last_name}
          onChange={set("last_name")}
          placeholder="Enter last name"
          required
          disabled={isPending}
        />
      </div>
      <div className="space-y-2">
        <Label>
          Middle Name{" "}
          <span className="text-muted-foreground font-normal">(Optional)</span>
        </Label>
        <Input
          value={form.middle_name}
          onChange={set("middle_name")}
          placeholder="Enter middle name"
          disabled={isPending}
        />
      </div>
      <div className="space-y-2">
        <Label>Phone</Label>
        <Input
          value={form.phone}
          onChange={set("phone")}
          type="tel"
          placeholder="Enter phone number"
          maxLength={40}
          disabled={isPending}
        />
      </div>
      <div className="space-y-2">
        <Label>Date of Birth</Label>
        <DatePicker
          value={parseLocalDate(form.dob)}
          onChange={(d) =>
            setForm((prev) => ({ ...prev, dob: d ? formatDate(d) : "" }))
          }
          maxDate={new Date()}
          placeholder="Select date"
          disabled={isPending}
        />
      </div>
      <div className="space-y-2">
        <Label>Gender</Label>
        <SearchableSelect
          options={genderOptions}
          value={form.gender}
          onChange={(v) => setForm((prev) => ({ ...prev, gender: v }))}
          placeholder="Select gender"
          searchable={false}
          disabled={isPending}
        />
      </div>
      <div className="space-y-2">
        <Label>Marital Status</Label>
        <SearchableSelect
          options={maritalOptions}
          value={form.marital_status}
          onChange={(v) => setForm((prev) => ({ ...prev, marital_status: v }))}
          placeholder="Select status"
          searchable={false}
          disabled={isPending}
        />
      </div>
      <div className="space-y-2">
        <Label>Email</Label>
        <Input
          value={user?.email ?? ""}
          disabled
          className="disabled:opacity-60"
        />
        <p className="text-xs text-muted-foreground">
          Email changes require a separate verification flow.
        </p>
      </div>
    </div>
  );

  const saveButton = (
    <Button variant="soft" type="submit" disabled={isPending || !isDirty}>
      <Save />
      {isPending ? "Saving..." : "Save Changes"}
    </Button>
  );

  if (variant === "elevated") {
    return (
      <form onSubmit={handleSubmit}>
        <Card className="gap-0 py-0">
          <div className="px-5 py-3.5 border-b border-border">
            <h2 className="text-sm font-medium">Profile Information</h2>
          </div>
          <CardContent className="p-5">{fields}</CardContent>
          <div className="px-5 py-3.5 border-t border-border">{saveButton}</div>
        </Card>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 pt-6">
      {fields}
      <div className="flex items-center gap-3 pt-2 border-t border-border">
        {saveButton}
      </div>
    </form>
  );
}

// ─── Security Tab ────────────────────────────────────────────────────────────

function SecurityTab() {
  const variant = useLayoutVariant();
  const { mutateAsync: changePassword, isPending } = useChangePassword();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [show, setShow] = useState({
    current: false,
    next: false,
    confirm: false,
  });
  const [clientError, setClientError] = useState("");

  const isDirty = !!(form.current || form.next || form.confirm);

  const toggle = (field: keyof typeof show) => () =>
    setShow((prev) => ({ ...prev, [field]: !prev[field] }));

  const set =
    (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setClientError("");
    if (form.next.length < 8) {
      setClientError("New password must be at least 8 characters.");
      return;
    }
    if (form.next !== form.confirm) {
      setClientError("New passwords do not match.");
      return;
    }
    try {
      await changePassword({
        current_password: form.current,
        new_password: form.next,
      });
      setForm({ current: "", next: "", confirm: "" });
    } catch {
      // error handled by mutation's onError
    }
  };

  const fields = (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 max-w-lg">
        <div className="space-y-2 md:col-span-2">
          <Label>
            Current Password <span className="text-destructive">*</span>
          </Label>
          <div className="relative">
            <Input
              type={show.current ? "text" : "password"}
              value={form.current}
              onChange={set("current")}
              required
              disabled={isPending}
              className="pr-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={toggle("current")}
              tabIndex={-1}
              aria-label={show.current ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 my-auto h-7 w-10 rounded-none text-muted-foreground hover:text-foreground hover:bg-transparent"
            >
              {show.current ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>
            New Password <span className="text-destructive">*</span>
          </Label>
          <div className="relative">
            <Input
              type={show.next ? "text" : "password"}
              value={form.next}
              onChange={set("next")}
              required
              disabled={isPending}
              className="pr-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={toggle("next")}
              tabIndex={-1}
              aria-label={show.next ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 my-auto h-7 w-10 rounded-none text-muted-foreground hover:text-foreground hover:bg-transparent"
            >
              {show.next ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Minimum 8 characters</p>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>
            Confirm New Password <span className="text-destructive">*</span>
          </Label>
          <div className="relative">
            <Input
              type={show.confirm ? "text" : "password"}
              value={form.confirm}
              onChange={set("confirm")}
              required
              disabled={isPending}
              className="pr-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={toggle("confirm")}
              tabIndex={-1}
              aria-label={show.confirm ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 my-auto h-7 w-10 rounded-none text-muted-foreground hover:text-foreground hover:bg-transparent"
            >
              {show.confirm ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
      {clientError && (
        <p className="mt-4 text-sm text-destructive">{clientError}</p>
      )}
    </>
  );

  const saveButton = (
    <Button variant="soft" type="submit" disabled={isPending || !isDirty}>
      <Save />
      {isPending ? "Updating..." : "Update Password"}
    </Button>
  );

  if (variant === "elevated") {
    return (
      <form onSubmit={handleSubmit}>
        <Card className="gap-0 py-0">
          <div className="px-5 py-3.5 border-b border-border">
            <h2 className="text-sm font-medium">Change Password</h2>
          </div>
          <CardContent className="p-5">{fields}</CardContent>
          <div className="px-5 py-3.5 border-t border-border">{saveButton}</div>
        </Card>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 pt-6">
      {fields}
      <div className="flex items-center gap-3 pt-2 border-t border-border">
        {saveButton}
      </div>
    </form>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function Profile() {
  const user = useAppSelector((s) => s.auth.user);
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);

  const fullName = user ? `${user.first_name} ${user.last_name}` : "—";
  const initials = user ? getInitials(user.first_name, user.last_name) : "?";
  const role = user?.is_super_admin
    ? "Super Admin"
    : user?.is_org_admin
      ? "Org Admin"
      : "User";
  const orgDisplayName = savedOrg?.legal_name ?? null;

  return (
    <div className="p-6 space-y-6">
      {/* Page title */}
      <h1 className="text-xl font-semibold">Profile</h1>

      {/* Identity row */}
      <div className="flex items-center gap-4">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-lg font-bold ring-2 ring-primary/20">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="text-base font-semibold leading-tight">{fullName}</p>
          <p className="text-sm text-muted-foreground truncate">
            {user?.email}
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Badge variant="secondary" className="text-xs">
              {role}
            </Badge>
            {orgDisplayName && (
              <span className="text-xs text-muted-foreground">
                {orgDisplayName}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile" className="gap-2">
            <User className="size-4" />
            Profile Details
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-2">
            <ShieldCheck className="size-4" />
            Security
          </TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="mt-3">
          <ProfileDetailsTab />
        </TabsContent>
        <TabsContent value="security" className="mt-3">
          <SecurityTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
