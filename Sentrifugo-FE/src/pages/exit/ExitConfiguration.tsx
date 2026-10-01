import { useState } from "react";
import { SectionCustomFields } from "@/components/shared/SectionCustomFields";
import {
  Users,
  Shield,
  Monitor,
  Briefcase,
  DollarSign,
  Plus,
  Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/lib/toast";
import {
  useGetChecklistsQuery,
  useUpdateChecklistMutation,
} from "@/store/api/exitManagementApi";
import type { LucideIcon } from "lucide-react";
import type { SectionType } from "@/types/custom-fields";

interface CardConfig {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  deptId?: string;
  cfSection?: SectionType;
}

const cards: CardConfig[] = [
  {
    key: "manager",
    label: "Manager",
    description: "Configure manager approval settings and requirements",
    icon: Users,
    deptId: "MANAGER",
    cfSection: "manager_clearance",
  },
  {
    key: "hr",
    label: "HR",
    description: "Configure HR review and clearance process",
    icon: Briefcase,
    deptId: "HR",
    cfSection: "hr_clearance",
  },
  {
    key: "it",
    label: "IT",
    description: "Configure IT clearance checklist and asset return",
    icon: Monitor,
    deptId: "IT",
    cfSection: "it_clearance",
  },
  {
    key: "admin",
    label: "Admin",
    description: "Configure admin clearance tasks and handover",
    icon: Shield,
    deptId: "ADMIN",
    cfSection: "admin_clearance",
  },
  {
    key: "finance",
    label: "Finance",
    description: "Configure final settlement and payroll processing",
    icon: DollarSign,
    deptId: "FINANCE",
    cfSection: "finance_clearance",
  },
];

function ChecklistEditor({ card }: { card: CardConfig }) {
  const { data: checklists } = useGetChecklistsQuery({ deptId: card.deptId! });
  const checklist = checklists?.[0];
  const items = checklist?.items || [];
  const [updateChecklist, { isLoading }] = useUpdateChecklistMutation();
  const [newItem, setNewItem] = useState("");

  const handleAdd = async () => {
    if (!newItem.trim()) return;
    try {
      await updateChecklist({
        deptId: checklist?.deptId || card.deptId!,
        deptName: checklist?.deptName || card.label,
        items: [...items, newItem.trim()],
      }).unwrap();
      setNewItem("");
      toast.success("Checklist item added.");
    } catch {
      toast.error("Failed to add checklist item.");
    }
  };

  const handleDelete = async (index: number) => {
    const newItems = [...items];
    newItems.splice(index, 1);
    try {
      await updateChecklist({
        deptId: checklist?.deptId || card.deptId!,
        deptName: checklist?.deptName || card.label,
        items: newItems,
      }).unwrap();
      toast.success("Checklist item removed.");
    } catch {
      toast.error("Failed to remove checklist item.");
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card overflow-x-auto">
        <div className="px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Input
              placeholder="Add new checklist item..."
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              className="flex-1 h-9"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
            />
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={!newItem.trim() || isLoading}
              className="gap-1.5"
            >
              <Plus className="size-4" /> Add
            </Button>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            No checklist items configured yet. Add one above.
          </div>
        ) : (
          <div className="divide-y">
            {items.map((item, index) => (
              <div
                key={index}
                className="flex items-center justify-between px-5 py-3 group"
              >
                <span className="text-sm text-foreground">{item}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => handleDelete(index)}
                  disabled={isLoading}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="px-5 py-3 border-t text-xs text-muted-foreground">
          {items.length} item{items.length !== 1 ? "s" : ""} configured
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6">
        <h3 className="font-bold text-foreground mb-4 text-base">
          Custom Fields
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Add custom fields that will appear in the {card.label} clearance page.
        </p>
        <SectionCustomFields
          entityType="exit_request"
          section={card.cfSection!}
          immediateDefinitionSave
        />
      </div>
    </div>
  );
}

export default function ExitConfiguration() {
  const [noticePeriod, setNoticePeriod] = useState("");
  const [noticePeriodError, setNoticePeriodError] = useState("");

  const handleNoticePeriodChange = (value: string) => {
    const trimmed = value.replace(/[^0-9]/g, "");
    setNoticePeriod(trimmed);

    if (!trimmed) {
      setNoticePeriodError("");
      return;
    }

    const num = Number(trimmed);
    if (num > 365) {
      setNoticePeriodError("Notice period cannot exceed 365 days.");
    } else if (num < 1) {
      setNoticePeriodError("Notice period must be at least 1 day.");
    } else {
      setNoticePeriodError("");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Exit Configuration"
        subtitle="Configure exit process settings for each department."
      />

      <div className="rounded-xl border bg-card px-5 py-4">
        <div className="flex items-center gap-4">
          <Label className="text-sm font-medium text-foreground whitespace-nowrap">
            Maximum Notice Period
          </Label>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                inputMode="numeric"
                value={noticePeriod}
                onChange={(e) => handleNoticePeriodChange(e.target.value)}
                placeholder="30"
                className="w-20 h-9 text-center"
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
            {noticePeriodError && (
              <p className="text-xs text-destructive mt-1">
                {noticePeriodError}
              </p>
            )}
          </div>
        </div>
      </div>

      <Tabs defaultValue="manager">
        <TabsList>
          {cards.map((card) => (
            <TabsTrigger key={card.key} value={card.key} className="gap-2">
              <card.icon className="size-4" />
              {card.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {cards.map((card) => (
          <TabsContent key={card.key} value={card.key} className="mt-4">
            <ChecklistEditor card={card} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
