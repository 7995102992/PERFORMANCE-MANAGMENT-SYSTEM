import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  getFilteredRowModel,
} from "@tanstack/react-table";
import {
  Search,
  Edit2,
  CalendarDays,
  CheckCircle2,
  Circle,
  Plus,
} from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useGetWorkCalendarsQuery } from "@/store/api/lmsApi";
import { PageLoader } from "@/components/shared/PageLoader";
import { PageHeader } from "@/components/shared/PageHeader";

type WorkCalendarEntry = {
  id: string;
  name: string;
  calendarYear: string;
  workWeek: string[];
  isActive: boolean;
  employeesCovered: number;
};

const columnHelper = createColumnHelper<WorkCalendarEntry>();

const WEEK_DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

const WorkCalendar = () => {
  const navigate = useNavigate();
  const [globalFilter, setGlobalFilter] = useState("");

  const { data: workCalendarsData, isLoading } = useGetWorkCalendarsQuery();

  const data = useMemo<WorkCalendarEntry[]>(() => {
    if (!workCalendarsData) return [];
    return workCalendarsData.map((cal) => {
      const startIdx = WEEK_DAYS.indexOf(cal.work_week?.start ?? "");
      const endIdx = WEEK_DAYS.indexOf(cal.work_week?.end ?? "");
      let workWeek: string[] = [];
      if (startIdx !== -1 && endIdx !== -1) {
        workWeek =
          startIdx <= endIdx
            ? WEEK_DAYS.slice(startIdx, endIdx + 1).map((d) => d.slice(0, 3))
            : [
                ...WEEK_DAYS.slice(startIdx),
                ...WEEK_DAYS.slice(0, endIdx + 1),
              ].map((d) => d.slice(0, 3));
      }
      return {
        id: cal._id,
        name: cal.name,
        calendarYear: `${cal.period?.start ?? "—"} – ${cal.period?.end ?? "—"}`,
        workWeek,
        isActive: cal.status === "ACTIVE",
        employeesCovered: cal.employee_count ?? 0,
      };
    });
  }, [workCalendarsData]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: "Name",
        cell: (info) => (
          <span className="font-medium text-muted-foreground">
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor("calendarYear", {
        header: "Period",
        cell: (info) => {
          const [start, end] = info.getValue().split(" – ");
          const fmt = (d: string) =>
            new Date(d)
              .toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                timeZone: "Asia/Kolkata",
              })
              .replace(/ /g, "-");
          return (
            <span className="text-muted-foreground text-sm">
              {fmt(start)} – {fmt(end)}
            </span>
          );
        },
      }),
      columnHelper.accessor("workWeek", {
        header: "Work Week",
        cell: (info) => (
          <div className="flex gap-1">
            {info.getValue().map((day) => (
              <Badge
                key={day}
                variant="secondary"
                className="text-[10px] px-1.5 py-0"
              >
                {day}
              </Badge>
            ))}
          </div>
        ),
      }),
      columnHelper.accessor("isActive", {
        header: "Status",
        cell: (info) =>
          info.getValue() ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
              <CheckCircle2 size={13} /> Active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Circle size={13} /> Inactive
            </span>
          ),
      }),
      columnHelper.accessor("employeesCovered", {
        header: "Employees",
        cell: (info) => (
          <span className="font-medium text-muted-foreground">
            {info.getValue()}
          </span>
        ),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data,
    columns,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  if (isLoading) {
    return <PageLoader message="Loading work calendars…" />;
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Work Calendar"
        subtitle="Define workdays, weekends, shifts, and statutory holidays."
        action={
          <Button
            variant="default"
            onClick={() =>
              navigate({ to: "/leave-management/work-calendar/add" })
            }
          >
            <Plus /> Add Work Calendar
          </Button>
        }
      />

      <div className="flex items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            size={16}
          />
          <Input
            type="text"
            placeholder="Search calendars..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full pl-9"
          />
        </div>
      </div>

      {data.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No work calendars configured"
          description="Add a work calendar to get started"
          action={
            <Button
              variant="default"
              onClick={() =>
                navigate({ to: "/leave-management/work-calendar/add" })
              }
            >
              <Plus /> Add Work Calendar
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border overflow-hidden bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                {table.getHeaderGroups().map((hg) =>
                  hg.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10"
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                    </TableHead>
                  )),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No calendars match your search.
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() =>
                      navigate({
                        to: `/leave-management/work-calendar/${row.original.id}/edit`,
                      })
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className="text-muted-foreground"
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

export default WorkCalendar;
