import { Link } from "@tanstack/react-router";
import { User, Users } from "lucide-react";
import { useAppSelector } from "@/store";
import { PageHeader } from "@/components/shared/PageHeader";

const JOURNEY_TABS = [
  { to: "/employee-journey/my-journey", icon: User, label: "My Journey" },
  { to: "/employee-journey/team-journey", icon: Users, label: "Team Journey" },
] as const;

export const Home = () => {
  const user = useAppSelector((s) => s.auth.user);
  const fullName = user ? `${user.first_name} ${user.last_name}`.trim() : "";

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <PageHeader
        title={`Welcome${fullName ? `, ${fullName}` : ""}`}
        subtitle="Use the menu on the left to navigate to a module."
      />

      {/* Employee Timeline tabs */}
      <div className="rounded-xl border bg-card p-5">
        <h3 className="mb-3 text-sm font-semibold text-foreground">Employee Timeline</h3>
        <div className="inline-flex items-center gap-1 rounded-xl border bg-muted/40 p-1">
          {JOURNEY_TABS.map(({ to, icon: Icon, label }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground hover:shadow-sm"
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
};
