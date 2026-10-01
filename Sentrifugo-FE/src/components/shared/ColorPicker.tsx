import { useState } from 'react'
import { HexColorPicker, HexColorInput } from 'react-colorful'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'

interface ColorPickerProps {
    value: string
    onChange: (color: string) => void
    disabled?: boolean
}

export function ColorPicker({ value, onChange, disabled }: ColorPickerProps) {
    const [open, setOpen] = useState(false)

    return (
        <Popover open={open && !disabled} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    className="h-9 w-9 p-0 border-border"
                >
                    <div
                        className="size-5 rounded-sm border border-border/50"
                        style={{ backgroundColor: value }}
                    />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-3 space-y-3" align="start" sideOffset={8}>
                <HexColorPicker color={value} onChange={onChange} />
                <div className="flex items-center gap-2">
                    <div
                        className="size-8 shrink-0 rounded-md border border-border"
                        style={{ backgroundColor: value }}
                    />
                    <HexColorInput
                        color={value}
                        onChange={onChange}
                        prefixed
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs font-mono uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                </div>
            </PopoverContent>
        </Popover>
    )
}
