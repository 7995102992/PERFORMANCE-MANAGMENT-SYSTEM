/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { PageLoader } from "@/components/shared/PageLoader"
import { StatusBadge } from "@/components/shared/StatusBadge"
import { ModuleSelector } from "../../components/ModuleSelector"
import { OrgAdminsManager } from "@/components/shared/OrgAdminsManager"
import { useSuperAdminOrg, useUpdateSuperAdminOrg } from "@/hooks/queries/use-super-admin-orgs"
import { useScrollToError } from "@/hooks/use-scroll-to-error"
import { useConfirm } from "@/providers/confirm-dialog-provider"
import type { ModuleKey } from "@/api/super-admin/types"

interface FormState {
  legalName: string
  enabled_modules: ModuleKey[]
  is_active: boolean
}

interface FormErrors {
  legalName?: string
}

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {}
  if (!form.legalName.trim()) errors.legalName = 'Organisation name is required.'
  return errors
}

export function EditOrganisation() {
  const navigate = useNavigate()
  const { id } = useSearch({ strict: false }) as { id?: string }
  const { data: org, isLoading } = useSuperAdminOrg(id ?? null)
  const updateOrg = useUpdateSuperAdminOrg()

  const [form, setForm] = useState<FormState>({
    legalName: '',
    enabled_modules: ['core_hr'],
    is_active: true,
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitted, setSubmitted] = useState(false)
  const scrollToError = useScrollToError()
  const confirm = useConfirm()

  useEffect(() => {
    if (org) {
      setForm({
        legalName: org.legal_name ?? '',
        enabled_modules: (org.enabled_modules ?? []).map((m) => typeof m === 'string' ? m : m.code) as ModuleKey[],
        is_active: org.is_active,
      })
    }
  }, [org])

  const update = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    if (submitted) {
      setErrors(validate({ ...form, [field]: value }))
    }
  }

  const handleSave = async () => {
    setSubmitted(true)
    const errs = validate(form)
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      requestAnimationFrame(() => scrollToError())
      return
    }

    await updateOrg.mutateAsync({
      id: id!,
      payload: {
        legal_name: form.legalName.trim(),
        enabled_modules: form.enabled_modules.map((code) => ({ code, is_active: true })),
        is_active: form.is_active,
      },
    })

    navigate({ to: '/super-admin/organisations' })
  }

  if (isLoading) return <PageLoader message="Loading organisation..." />

  if (!org) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">Organisation not found.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate({ to: '/super-admin/organisations' })}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{org.legal_name}</h1>
            <p className="text-sm text-muted-foreground">Organisation details and configuration</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Status</span>
          <Switch
            checked={form.is_active}
            onCheckedChange={(checked) => {
              if (!checked) {
                confirm({
                  title: 'Deactivate Organisation',
                  description: `Are you sure you want to deactivate "${org.legal_name}"? All users in this organisation will lose access.`,
                  confirmText: 'Deactivate',
                  variant: 'destructive',
                  onConfirm: () => update('is_active', false),
                })
              } else {
                update('is_active', true)
              }
            }}
          />
          <StatusBadge status={form.is_active ? 'active' : 'inactive'} />
        </div>
      </div>

      {/* Organisation Details */}
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b border-border">
          <span className="text-sm font-semibold">Organisation Details</span>
        </div>
        <CardContent className="p-5">
          <div className="max-w-sm space-y-3">
            <Label htmlFor="legalName">
              Organisation Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="legalName"
              value={form.legalName}
              onChange={(e) => update('legalName', e.target.value)}
              className={errors.legalName ? 'border-destructive' : ''}
            />
            {errors.legalName && <p className="text-xs text-destructive mt-1">{errors.legalName}</p>}
          </div>
        </CardContent>
      </Card>

      {/* Module Selection */}
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b border-border">
          <span className="text-sm font-semibold">Module Selection</span>
          <p className="text-xs text-muted-foreground mt-0.5">Choose which modules this organisation will have access to</p>
        </div>
        <CardContent className="p-5">
          <ModuleSelector
            selected={form.enabled_modules}
            onChange={(enabled_modules) => update('enabled_modules', enabled_modules)}
          />
        </CardContent>
      </Card>

      {/* Organisation Admins */}
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b border-border">
          <span className="text-sm font-semibold">Organisation Admins</span>
          <p className="text-xs text-muted-foreground mt-0.5">Administrators who can manage this organisation</p>
        </div>
        <CardContent className="p-5">
          <OrgAdminsManager organisationId={org.id} />
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="border-t pt-6 flex items-center justify-end gap-3">
        <Button
          variant="outline"
          onClick={() => navigate({ to: '/super-admin/organisations' })}
          disabled={updateOrg.isPending}
        >
          Cancel
        </Button>
        <Button variant="soft" onClick={handleSave} disabled={updateOrg.isPending}>
          {updateOrg.isPending ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </div>
  )
}
