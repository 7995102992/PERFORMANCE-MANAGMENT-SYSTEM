import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { ModuleSelector } from "../../components/ModuleSelector"
import { useCreateSuperAdminOrg } from "@/hooks/queries/use-super-admin-orgs"
import { useScrollToError } from "@/hooks/use-scroll-to-error"
import type { ModuleKey } from "@/api/super-admin/types"

interface FormState {
  legalName: string
  adminName: string
  adminEmail: string
  adminPhone: string
  enabled_modules: ModuleKey[]
}

interface FormErrors {
  legalName?: string
  adminName?: string
  adminEmail?: string
}

const INITIAL_FORM: FormState = {
  legalName: '',
  adminName: '',
  adminEmail: '',
  adminPhone: '',
  enabled_modules: ['core_hr'],
}

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {}
  if (!form.legalName.trim()) errors.legalName = 'Organisation name is required.'
  if (!form.adminName.trim()) errors.adminName = 'Admin name is required.'
  if (!form.adminEmail.trim()) {
    errors.adminEmail = 'Admin email is required.'
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.adminEmail)) {
    errors.adminEmail = 'Enter a valid email address.'
  }
  return errors
}

export function AddOrganisation() {
  const navigate = useNavigate()
  const createOrg = useCreateSuperAdminOrg()

  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitted, setSubmitted] = useState(false)
  const scrollToError = useScrollToError()

  const update = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    if (submitted) {
      setErrors(validate({ ...form, [field]: value }))
    }
  }

  const handleSubmit = async () => {
    setSubmitted(true)
    const errs = validate(form)
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      requestAnimationFrame(() => scrollToError())
      return
    }

    await createOrg.mutateAsync({
      legal_name: form.legalName.trim(),
      enabled_modules: form.enabled_modules.map((code) => ({ code, is_active: true })),
      setup_status: 'pending',
      administrator: {
        name: form.adminName.trim(),
        email: form.adminEmail.trim(),
        phone: form.adminPhone.trim() || null,
      },
      send_activation: true,
    })

    navigate({ to: '/super-admin/organisations' })
  }

  return (
    <div className="space-y-6 p-6">

      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => navigate({ to: '/super-admin/organisations' })}>
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Add New Organisation</h1>
          <p className="text-sm text-muted-foreground">Create an organisation and assign its first administrator</p>
        </div>
      </div>

      {/* Step 1 — Organisation Details */}
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b border-border">
          <span className="text-sm font-semibold">Organisation Details</span>
          <p className="text-xs text-muted-foreground mt-0.5">Basic information about the organisation</p>
        </div>
        <CardContent className="p-5">
          <div className="max-w-sm space-y-3">
            <Label htmlFor="legalName">
              Organisation Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="legalName"
              placeholder="e.g. Acme Corporation"
              value={form.legalName}
              onChange={(e) => update('legalName', e.target.value)}
              className={errors.legalName ? 'border-destructive' : ''}
            />
            {errors.legalName && <p className="text-xs text-destructive">{errors.legalName}</p>}
          </div>
        </CardContent>
      </Card>

      {/* Step 2 — Primary Administrator */}
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b border-border">
          <span className="text-sm font-semibold">Primary Administrator</span>
          <p className="text-xs text-muted-foreground mt-0.5">This person will receive an activation email to set up their account</p>
        </div>
        <CardContent className="p-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-3">
              <Label htmlFor="adminName">
                Full Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="adminName"
                placeholder="e.g. John Doe"
                value={form.adminName}
                onChange={(e) => update('adminName', e.target.value)}
                className={errors.adminName ? 'border-destructive' : ''}
              />
              {errors.adminName && <p className="text-xs text-destructive">{errors.adminName}</p>}
            </div>
            <div className="space-y-3">
              <Label htmlFor="adminEmail">
                Email Address <span className="text-destructive">*</span>
              </Label>
              <Input
                id="adminEmail"
                type="email"
                placeholder="admin@example.com"
                value={form.adminEmail}
                onChange={(e) => update('adminEmail', e.target.value)}
                className={errors.adminEmail ? 'border-destructive' : ''}
              />
              {errors.adminEmail && <p className="text-xs text-destructive">{errors.adminEmail}</p>}
            </div>
            <div className="space-y-3">
              <Label htmlFor="adminPhone">
                Phone <span className="text-muted-foreground text-xs font-normal">(optional)</span>
              </Label>
              <Input
                id="adminPhone"
                placeholder="+91 98765 43210"
                value={form.adminPhone}
                onChange={(e) => update('adminPhone', e.target.value)}
              />
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Use a separate admin email, not the same as the employee's organisation email — this may cause permission conflicts.
          </p>
        </CardContent>
      </Card>

      {/* Step 3 — Module Selection */}
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b border-border">
          <span className="text-sm font-semibold">Module Selection</span>
          <p className="text-xs text-muted-foreground mt-0.5">Choose which modules this organisation will have access to</p>
        </div>
        <CardContent className="p-5">
          <ModuleSelector
            selected={form.enabled_modules}
            onChange={(enabled_modules) => setForm((prev) => ({ ...prev, enabled_modules }))}
          />
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="border-t pt-6 flex items-center justify-end gap-3">
        <Button
          variant="outline"
          onClick={() => navigate({ to: '/super-admin/organisations' })}
          disabled={createOrg.isPending}
        >
          Cancel
        </Button>
        <Button
          onClick={() => handleSubmit()}
          disabled={createOrg.isPending}
        >
          {createOrg.isPending ? 'Creating...' : 'Create & Send Activation Link'}
        </Button>
      </div>
    </div>
  )
}
