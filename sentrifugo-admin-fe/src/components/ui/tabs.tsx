import * as React from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react"
import { cn } from "@/lib/utils"

function Tabs({
  children,
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col", className)}
      {...props}
    >
      {children}
    </TabsPrimitive.Root>
  )
}

function TabsList({
  children,
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex items-center border-b border-border bg-transparent p-0",
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({
  children,
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex items-center justify-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-medium",
        "border-b-2 border-transparent -mb-px transition-all",
        "text-muted-foreground hover:text-foreground hover:bg-muted/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        "data-[selected]:border-foreground data-[selected]:text-foreground",
        "aria-selected:border-foreground aria-selected:text-foreground",
        "cursor-pointer",
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.Tab>
  )
}

function TabsContent({
  children,
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.Panel>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
