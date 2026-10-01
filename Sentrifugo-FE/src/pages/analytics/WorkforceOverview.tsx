import { useMemo } from 'react'
import { PageHeader } from '@/components/shared/PageHeader'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import {
  Users,
  CheckCircle,
  Clock,
  Building2,
  TrendingUp,
  TrendingDown,
  Loader2,
  AlertTriangle,
  Lightbulb,
  Inbox,
} from 'lucide-react'
import { useGetEmployeesQuery } from '@/store/api/iamApi'
import { EmptyState } from '@/components/shared/EmptyState'
import type { EmployeeResponse } from '@/types/iam'

const COLORS = {
  primary: '#6f5cff',
  primaryLight: '#a78bfa',
  primaryMuted: '#c4b5fd',
  accent: '#818cf8',
  slate: '#94a3b8',
  slateDark: '#64748b',
  success: '#22c55e',
  warning: '#f59e0b',
  destructive: '#ef4444',
  muted: '#6c6f89',
  border: '#f0eff6',
}

const PIE_PALETTE = [COLORS.primary, COLORS.primaryLight, COLORS.accent, COLORS.slateDark, COLORS.slate, COLORS.primaryMuted]

function ChartTooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md">
      <p className="text-xs font-medium text-foreground mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-xs text-muted-foreground">
          <span className="inline-block size-2 rounded-full mr-1.5" style={{ backgroundColor: p.color }} />
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  )
}

function KpiCard({ label, value, subtitle, trend, trendDir, icon: Icon }: {
  label: string
  value: string | number
  subtitle: string
  trend: string
  trendDir: 'up' | 'down' | 'neutral'
  icon: typeof Users
}) {
  return (
    <div className="rounded-xl border border-t-[3px] border-t-primary bg-card p-5 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
        <Icon className="size-5 text-primary" />
      </div>
      <p className="text-3xl font-bold text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground mt-1.5">{subtitle}</p>
      <p className={`text-xs font-semibold mt-1 ${trendDir === 'up' ? 'text-success' : trendDir === 'down' ? 'text-destructive' : 'text-muted-foreground'}`}>
        {trendDir === 'up' && <TrendingUp className="size-3 inline mr-1" />}
        {trendDir === 'down' && <TrendingDown className="size-3 inline mr-1" />}
        {trend}
      </p>
    </div>
  )
}

function ProgressBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs mb-1.5">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{value} ({pct}%)</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  )
}

function AlertCard({ variant, title, description }: {
  variant: 'warning' | 'danger' | 'info' | 'success'
  title: string
  description: string
}) {
  const styles: Record<string, { border: string; bg: string; iconColor: string }> = {
    danger: { border: 'border-destructive/20', bg: 'bg-destructive/5', iconColor: 'text-destructive' },
    warning: { border: 'border-warning/20', bg: 'bg-warning/5', iconColor: 'text-warning' },
    info: { border: 'border-primary/20', bg: 'bg-primary/5', iconColor: 'text-primary' },
    success: { border: 'border-success/20', bg: 'bg-success/5', iconColor: 'text-success' },
  }
  const s = styles[variant]
  const Icon = variant === 'danger' ? AlertTriangle : variant === 'warning' ? AlertTriangle : variant === 'success' ? CheckCircle : Lightbulb
  return (
    <div className={`rounded-lg border ${s.border} ${s.bg} p-3 mt-3`}>
      <div className="flex gap-2">
        <Icon className={`size-4 shrink-0 mt-0.5 ${s.iconColor}`} />
        <div>
          <p className="text-xs font-semibold text-foreground">{title}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>
    </div>
  )
}

function ChipLegend({ items }: { items: { color: string; label: string; value: string }[] }) {
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5 rounded-full border bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground">
          <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
          <strong className="text-foreground font-semibold">{item.value}</strong> {item.label}
        </span>
      ))}
    </div>
  )
}

function SectionCard({ title, subtitle, badge, children }: {
  title: string
  subtitle: string
  badge: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border bg-card p-5 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between mb-4 gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
          {badge}
        </span>
      </div>
      {children}
    </div>
  )
}

// ─── Data computation ──────────────────────────────────────────────────────

function computeWorkforceData(employees: EmployeeResponse[]) {
  const total = employees.length
  const statusCounts: Record<string, number> = {}
  const typeCounts: Record<string, number> = {}
  const deptCounts: Record<string, number> = {}
  const buCounts: Record<string, number> = {}
  const genderCounts: Record<string, number> = {}
  const maritalCounts: Record<string, number> = {}
  const sourceOfHireCounts: Record<string, number> = {}
  const locationCounts: Record<string, number> = {}
  const projectStatusCounts: Record<string, number> = {}
  const managerDirectReports: Record<string, number> = {}
  const monthlyJoining: Record<string, number> = {}
  const quarterlyJoining: Record<string, number> = {}

  let activeCount = 0
  let noticeCount = 0
  let noL1 = 0
  let noL2 = 0
  let bothManagers = 0
  let pendingActivation = 0
  let hasWorkPhone = 0
  let hasPersonalPhone = 0
  let hasPersonalEmail = 0
  let hasSeatLocation = 0
  let hasEmergencyContact = 0
  let hasDependents = 0
  let hasBankDetails = 0
  let hasEducation = 0
  let hasWorkExperience = 0
  let hasIdentityFields = 0
  let hasAboutMe = 0
  let hasDob = 0
  let hasCtc = 0

  const ageBands = { 'Under 25': 0, '25–30': 0, '31–40': 0, '41–50': 0, '50+': 0 }
  const tenureBands = { '<1 yr': 0, '1–2 yr': 0, '2–3 yr': 0, '3–5 yr': 0, '5+ yr': 0 }
  const expBands = { 'Junior (<3yr)': 0, 'Mid (3–7yr)': 0, 'Senior (7–12yr)': 0, 'Lead (12yr+)': 0 }

  const now = new Date()
  const oneYearAgo = new Date(now)
  oneYearAgo.setFullYear(now.getFullYear() - 1)

  for (const emp of employees) {
    const statusVal = emp.employmentStatus?.value?.toLowerCase() ?? 'unknown'
    statusCounts[emp.employmentStatus?.value ?? 'Unknown'] = (statusCounts[emp.employmentStatus?.value ?? 'Unknown'] ?? 0) + 1

    if (statusVal === 'active' || statusVal === 'permanent' || statusVal === 'probation') activeCount++
    if (statusVal === 'notice period' || statusVal === 'notice_period') noticeCount++

    const typeVal = emp.employmentType?.value ?? 'Unknown'
    typeCounts[typeVal] = (typeCounts[typeVal] ?? 0) + 1

    const dept = emp.departmentName ?? emp.department_name ?? 'Unassigned'
    deptCounts[dept] = (deptCounts[dept] ?? 0) + 1

    const bu = emp.businessUnitName ?? 'Unassigned'
    buCounts[bu] = (buCounts[bu] ?? 0) + 1

    const gender = emp.gender?.value ?? 'Not specified'
    genderCounts[gender] = (genderCounts[gender] ?? 0) + 1

    const marital = emp.maritalStatus?.value ?? 'Not specified'
    maritalCounts[marital] = (maritalCounts[marital] ?? 0) + 1

    const source = emp.sourceOfHire?.value ?? 'Not specified'
    sourceOfHireCounts[source] = (sourceOfHireCounts[source] ?? 0) + 1

    const loc = emp.seatLocation ?? 'Not specified'
    locationCounts[loc] = (locationCounts[loc] ?? 0) + 1

    const projStatus = emp.projectStatus?.value ?? 'Not specified'
    projectStatusCounts[projStatus] = (projectStatusCounts[projStatus] ?? 0) + 1

    if (emp.l1ManagerId) {
      managerDirectReports[emp.l1ManagerId] = (managerDirectReports[emp.l1ManagerId] ?? 0) + 1
    } else {
      noL1++
    }
    if (!emp.l2ManagerId) noL2++
    if (emp.l1ManagerId && emp.l2ManagerId) bothManagers++

    if (emp.activationPending) pendingActivation++
    if (emp.workPhone) hasWorkPhone++
    if (emp.personalPhone) hasPersonalPhone++
    if (emp.personalEmail) hasPersonalEmail++
    if (emp.seatLocation) hasSeatLocation++
    if (emp.emergencyContacts?.length) hasEmergencyContact++
    if (emp.dependents?.length) hasDependents++
    if (emp.bankDetails?.accountNumber) hasBankDetails++
    if (emp.education?.length) hasEducation++
    if (emp.workExperience?.length) hasWorkExperience++
    if (emp.identityFields?.length) hasIdentityFields++
    if (emp.aboutMe) hasAboutMe++
    if (emp.dob) hasDob++
    if (emp.ctc != null && emp.ctc > 0) hasCtc++

    if (emp.dob) {
      const birthDate = new Date(emp.dob)
      const age = Math.floor((now.getTime() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      if (age < 25) ageBands['Under 25']++
      else if (age <= 30) ageBands['25–30']++
      else if (age <= 40) ageBands['31–40']++
      else if (age <= 50) ageBands['41–50']++
      else ageBands['50+']++
    }

    if (emp.dateOfJoining) {
      const joinDate = new Date(emp.dateOfJoining)
      const tenureYears = (now.getTime() - joinDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      if (tenureYears < 1) tenureBands['<1 yr']++
      else if (tenureYears < 2) tenureBands['1–2 yr']++
      else if (tenureYears < 3) tenureBands['2–3 yr']++
      else if (tenureYears < 5) tenureBands['3–5 yr']++
      else tenureBands['5+ yr']++

      if (joinDate >= oneYearAgo) {
        const monthKey = joinDate.toLocaleString('en', { month: 'short', year: '2-digit' })
        monthlyJoining[monthKey] = (monthlyJoining[monthKey] ?? 0) + 1
      }

      const q = Math.ceil((joinDate.getMonth() + 1) / 3)
      const qKey = `Q${q} ${joinDate.getFullYear()}`
      quarterlyJoining[qKey] = (quarterlyJoining[qKey] ?? 0) + 1
    }

    const totalExpVal = emp.totalExp ?? 0
    if (totalExpVal < 3) expBands['Junior (<3yr)']++
    else if (totalExpVal < 7) expBands['Mid (3–7yr)']++
    else if (totalExpVal < 12) expBands['Senior (7–12yr)']++
    else expBands['Lead (12yr+)']++
  }

  const spanBands = { '1–3': 0, '4–6': 0, '7–9': 0, '10+': 0 }
  for (const count of Object.values(managerDirectReports)) {
    if (count <= 3) spanBands['1–3']++
    else if (count <= 6) spanBands['4–6']++
    else if (count <= 9) spanBands['7–9']++
    else spanBands['10+']++
  }

  const buCount = Object.keys(buCounts).filter(k => k !== 'Unassigned').length
  const deptCount = Object.keys(deptCounts).filter(k => k !== 'Unassigned').length

  const profileCompleteness = [
    { label: 'Work Information', pct: total > 0 ? Math.round((Object.values(deptCounts).reduce((a, b) => a + b, 0) - (deptCounts['Unassigned'] ?? 0)) / total * 100) : 0 },
    { label: 'Personal Details (DOB, gender)', pct: total > 0 ? Math.round(hasDob / total * 100) : 0 },
    { label: 'Emergency Contacts', pct: total > 0 ? Math.round(hasEmergencyContact / total * 100) : 0 },
    { label: 'CTC & Compensation', pct: total > 0 ? Math.round(hasCtc / total * 100) : 0 },
    { label: 'Identity Fields (PAN / Aadhaar)', pct: total > 0 ? Math.round(hasIdentityFields / total * 100) : 0 },
    { label: 'Work Experience History', pct: total > 0 ? Math.round(hasWorkExperience / total * 100) : 0 },
    { label: 'Education Records', pct: total > 0 ? Math.round(hasEducation / total * 100) : 0 },
    { label: 'Bank Details', pct: total > 0 ? Math.round(hasBankDetails / total * 100) : 0 },
    { label: 'About Me / Bio', pct: total > 0 ? Math.round(hasAboutMe / total * 100) : 0 },
  ]

  return {
    total,
    activeCount,
    noticeCount,
    buCount,
    deptCount,
    statusCounts,
    typeCounts,
    deptCounts,
    buCounts,
    genderCounts,
    maritalCounts,
    sourceOfHireCounts,
    locationCounts,
    projectStatusCounts,
    ageBands,
    tenureBands,
    expBands,
    spanBands,
    monthlyJoining,
    quarterlyJoining,
    noL1,
    noL2,
    bothManagers,
    pendingActivation,
    hasWorkPhone,
    hasPersonalPhone,
    hasPersonalEmail,
    hasSeatLocation,
    hasEmergencyContact,
    hasDependents,
    profileCompleteness,
    managerDirectReports,
  }
}

function toSortedChartData(counts: Record<string, number>) {
  return Object.entries(counts)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
}

function toPieData(counts: Record<string, number>) {
  return Object.entries(counts)
    .map(([name, value], i) => ({ name, value, color: PIE_PALETTE[i % PIE_PALETTE.length] }))
    .sort((a, b) => b.value - a.value)
}

export default function WorkforceOverview() {
  const { data: employees, isLoading, isError } = useGetEmployeesQuery({ limit: 1000 })

  const stats = useMemo(() => {
    if (!employees?.length) return null
    return computeWorkforceData(employees)
  }, [employees])

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Workforce Overview" subtitle="Headcount composition, demographics, and organisational health" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  if (isError || !employees) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Workforce Overview" subtitle="Headcount composition, demographics, and organisational health" />
        <EmptyState icon={AlertTriangle} title="Unable to load data" description="There was an error fetching employee data. Please try again." />
      </div>
    )
  }

  if (!stats || stats.total === 0) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Workforce Overview" subtitle="Headcount composition, demographics, and organisational health" />
        <EmptyState icon={Inbox} title="No employees found" description="Add employees to see workforce analytics." />
      </div>
    )
  }

  const typeData = toPieData(stats.typeCounts)
  const statusData = toPieData(stats.statusCounts)
  const deptData = toSortedChartData(stats.deptCounts)
  const buData = toPieData(stats.buCounts)
  const genderData = toPieData(stats.genderCounts)
  const maritalData = toPieData(stats.maritalCounts)
  const sourceData = toSortedChartData(stats.sourceOfHireCounts)
  const locationData = toPieData(stats.locationCounts)
  const ageData = Object.entries(stats.ageBands).map(([name, value]) => ({ name, value }))
  const tenureData = Object.entries(stats.tenureBands).map(([name, value]) => ({ name, value }))
  const spanData = Object.entries(stats.spanBands).map(([name, value]) => ({ name, value }))
  const hiringData = Object.entries(stats.monthlyJoining).map(([name, value]) => ({ name, value }))
  const cohortData = Object.entries(stats.quarterlyJoining)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }))
  const projectData = toPieData(stats.projectStatusCounts)
  const contactData = [
    { name: 'Work Phone', value: stats.hasWorkPhone },
    { name: 'Personal Phone', value: stats.hasPersonalPhone },
    { name: 'Personal Email', value: stats.hasPersonalEmail },
    { name: 'Seat Location', value: stats.hasSeatLocation },
  ]

  const overloadedManagers = Object.values(stats.managerDirectReports).filter(c => c > 10).length

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Workforce Overview" subtitle="Headcount composition, demographics, and organisational health" />

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Total Employees" value={stats.total} subtitle="All employment statuses" trend={`${stats.activeCount} currently active`} trendDir="neutral" icon={Users} />
        <KpiCard label="Active Employees" value={stats.activeCount} subtitle={`${stats.total > 0 ? Math.round((stats.activeCount / stats.total) * 100) : 0}% of total headcount`} trend="Active + Probation" trendDir="up" icon={CheckCircle} />
        <KpiCard label="On Notice Period" value={stats.noticeCount} subtitle="Serving notice" trend={stats.noticeCount > 5 ? 'Monitor closely' : 'Within normal range'} trendDir={stats.noticeCount > 5 ? 'down' : 'neutral'} icon={Clock} />
        <KpiCard label="Business Units" value={stats.buCount} subtitle={`${stats.deptCount} departments active`} trend="Organisational structure" trendDir="neutral" icon={Building2} />
      </div>

      {/* Employment Type + Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Employment Type Breakdown" subtitle="Full-Time · Contract · Internship" badge="Composition">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={typeData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value" nameKey="name">
                {typeData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <RechartsTooltip content={<ChartTooltipContent />} />
            </PieChart>
          </ResponsiveContainer>
          <ChipLegend items={typeData.map(d => ({ color: d.color, label: d.name, value: `${stats.total > 0 ? Math.round((d.value / stats.total) * 100) : 0}% (${d.value})` }))} />
        </SectionCard>

        <SectionCard title="Employment Status Distribution" subtitle="Lifecycle states — from probation to exit" badge="Status">
          <ResponsiveContainer width="100%" height={Math.max(220, statusData.length * 40)}>
            <BarChart data={statusData} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="value" name="Employees" radius={[0, 6, 6, 0]}>
                {statusData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      </div>

      {/* Department + Resource Allocation */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
        <SectionCard title="Headcount by Department" subtitle="Active employees per department" badge="Structure">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={deptData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="value" name="Headcount" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Resource Allocation" subtitle="Project status — bench risk" badge="Capacity">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={projectData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3} dataKey="value" nameKey="name">
                {projectData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <RechartsTooltip content={<ChartTooltipContent />} />
            </PieChart>
          </ResponsiveContainer>
          {projectData.map((d, i) => (
            <ProgressBar key={d.name} label={d.name} value={d.value} total={stats.total} color={PIE_PALETTE[i % PIE_PALETTE.length]} />
          ))}
        </SectionCard>
      </div>

      {/* Gender + Hiring Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Gender Diversity" subtitle="Workforce gender composition" badge="Diversity">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={genderData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value" nameKey="name">
                {genderData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <RechartsTooltip content={<ChartTooltipContent />} />
            </PieChart>
          </ResponsiveContainer>
          <ChipLegend items={genderData.map(d => ({ color: d.color, label: d.name, value: `${stats.total > 0 ? Math.round((d.value / stats.total) * 100) : 0}%` }))} />
        </SectionCard>

        <SectionCard title="Monthly Hiring Trend" subtitle="New joiners last 12 months" badge="Growth">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={hiringData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="value" name="New Joiners" fill={COLORS.primaryLight} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      </div>

      {/* Source of Hire + Tenure */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Source of Hire" subtitle="Channel effectiveness" badge="Recruitment">
          {sourceData.map((d, i) => (
            <ProgressBar key={d.name} label={d.name} value={d.value} total={stats.total} color={PIE_PALETTE[i % PIE_PALETTE.length]} />
          ))}
        </SectionCard>

        <SectionCard title="Tenure Distribution" subtitle="Years at organisation" badge="Retention">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={tenureData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="value" name="Employees" fill={COLORS.accent} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          {stats.tenureBands['1–2 yr'] > 0 && (
            <AlertCard variant="danger" title="1–2 Year Risk Window" description={`${stats.tenureBands['1–2 yr']} employees are in the highest-risk exit band. Proactive stay conversations required.`} />
          )}
        </SectionCard>
      </div>

      {/* Age + Marital Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Age Distribution" subtitle="Workforce age bands" badge="Demographics">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={ageData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="value" name="Employees" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <ChipLegend items={ageData.map((d, i) => ({ color: PIE_PALETTE[i % PIE_PALETTE.length], label: d.name, value: `${stats.total > 0 ? Math.round((d.value / stats.total) * 100) : 0}%` }))} />
        </SectionCard>

        <SectionCard title="Marital Status Distribution" subtitle="Single · Married · Divorced · Widowed" badge="Demographics">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={maritalData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value" nameKey="name">
                {maritalData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <RechartsTooltip content={<ChartTooltipContent />} />
            </PieChart>
          </ResponsiveContainer>
          <ChipLegend items={maritalData.map(d => ({ color: d.color, label: d.name, value: `${stats.total > 0 ? Math.round((d.value / stats.total) * 100) : 0}%` }))} />
        </SectionCard>
      </div>

      {/* BU Headcount + Manager Span */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Headcount by Business Unit" subtitle="Active employees per BU" badge="BU Structure">
          <ResponsiveContainer width="100%" height={Math.max(220, buData.length * 40)}>
            <BarChart data={buData} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="value" name="Employees" radius={[0, 6, 6, 0]}>
                {buData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <ChipLegend items={buData.map(d => ({ color: d.color, label: d.name, value: `${d.value} (${stats.total > 0 ? Math.round((d.value / stats.total) * 100) : 0}%)` }))} />
        </SectionCard>

        <SectionCard title="Manager Span of Control" subtitle="Direct reports per L1 manager" badge="Management">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={spanData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="value" name="Managers" fill={COLORS.primaryMuted} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          {overloadedManagers > 0 && (
            <AlertCard variant="warning" title="Overloaded Managers" description={`${overloadedManagers} manager${overloadedManagers > 1 ? 's' : ''} ha${overloadedManagers > 1 ? 've' : 's'} 11+ direct reports — exceeding the optimal 7–9 span.`} />
          )}
        </SectionCard>
      </div>

      {/* Profile Completeness + Location */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Profile Completeness Score" subtitle="Data richness across all employee record sections" badge="Data Quality">
          {stats.profileCompleteness.map((item) => {
            const color = item.pct >= 90 ? COLORS.primary : item.pct >= 70 ? COLORS.primaryLight : COLORS.slate
            return (
              <div key={item.label} className="mb-3">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="font-medium text-foreground">{item.label}</span>
                  <span style={{ color }}>{item.pct}% complete</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${item.pct}%`, backgroundColor: color }} />
                </div>
              </div>
            )
          })}
        </SectionCard>

        <SectionCard title="Seat Location Distribution" subtitle="Where employees are based" badge="Location">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={locationData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value" nameKey="name">
                {locationData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <RechartsTooltip content={<ChartTooltipContent />} />
            </PieChart>
          </ResponsiveContainer>
          <ChipLegend items={locationData.map(d => ({ color: d.color, label: d.name, value: `${stats.total > 0 ? Math.round((d.value / stats.total) * 100) : 0}%` }))} />
        </SectionCard>
      </div>

      {/* Dependent + Emergency Contact Coverage */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Contact Completeness" subtitle="Work phone, personal phone, personal email, seat location coverage" badge="Reachability">
          {contactData.map((d, i) => (
            <ProgressBar key={d.name} label={d.name} value={d.value} total={stats.total} color={PIE_PALETTE[i % PIE_PALETTE.length]} />
          ))}
          {stats.total > 0 && Math.round((stats.hasWorkPhone / stats.total) * 100) < 70 && (
            <AlertCard variant="warning" title={`Low Work Phone Coverage (${Math.round((stats.hasWorkPhone / stats.total) * 100)}%)`} description="Employees without a work phone create gaps in emergency reach-outs and IT asset allocation." />
          )}
        </SectionCard>

        <SectionCard title="Dependent & Emergency Contact Coverage" subtitle="Dependents and emergency contact population" badge="Coverage">
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="text-center p-4 rounded-xl border bg-muted/30">
              <p className="text-2xl font-bold text-primary">{stats.total > 0 ? Math.round((stats.hasEmergencyContact / stats.total) * 100) : 0}%</p>
              <p className="text-[11px] text-muted-foreground mt-1">Emergency Contact Registered</p>
            </div>
            <div className="text-center p-4 rounded-xl border bg-muted/30">
              <p className="text-2xl font-bold text-foreground">{stats.total > 0 ? Math.round((stats.hasDependents / stats.total) * 100) : 0}%</p>
              <p className="text-[11px] text-muted-foreground mt-1">Dependent Info Provided</p>
            </div>
          </div>
          {stats.total > 0 && stats.hasDependents < stats.total * 0.7 && (
            <AlertCard variant="warning" title={`${stats.total - stats.hasDependents} Have No Dependents Registered`} description="Missing dependent data limits benefits personalisation and family insurance sizing." />
          )}
        </SectionCard>
      </div>

      {/* Joining Cohorts + Manager Coverage */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Joining Cohorts by Quarter" subtitle="Hiring velocity grouped quarterly" badge="Cohorts">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={cohortData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} axisLine={false} tickLine={false} />
              <RechartsTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="value" name="New Joiners" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Manager Coverage — Succession Risk" subtitle="L1/L2 manager assignment gaps" badge="Succession">
          <div className="grid grid-cols-3 gap-3">
            <div className="p-4 rounded-xl border bg-muted/30">
              <p className="text-2xl font-bold text-foreground">{stats.noL1}</p>
              <p className="text-xs text-muted-foreground mt-1">No L1 Manager</p>
              <p className="text-[11px] text-muted-foreground mt-2">{stats.total > 0 ? Math.round((stats.noL1 / stats.total) * 100) : 0}% of workforce</p>
            </div>
            <div className="p-4 rounded-xl border bg-muted/30">
              <p className="text-2xl font-bold text-foreground">{stats.noL2}</p>
              <p className="text-xs text-muted-foreground mt-1">No L2 Manager</p>
              <p className="text-[11px] text-muted-foreground mt-2">{stats.total > 0 ? Math.round((stats.noL2 / stats.total) * 100) : 0}% of workforce</p>
            </div>
            <div className="p-4 rounded-xl border border-primary/15 bg-primary/5">
              <p className="text-2xl font-bold text-primary">{stats.bothManagers}</p>
              <p className="text-xs text-muted-foreground mt-1">Fully Mapped</p>
              <p className="text-[11px] text-primary/80 mt-2">{stats.total > 0 ? Math.round((stats.bothManagers / stats.total) * 100) : 0}% covered</p>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  )
}
