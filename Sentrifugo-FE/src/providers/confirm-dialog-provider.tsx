import * as React from "react";
import { AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
};

type ConfirmContextType = (options: ConfirmOptions) => void;

const ConfirmContext = React.createContext<ConfirmContextType | undefined>(
  undefined,
);

export function ConfirmDialogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null);
  const [loading, setLoading] = React.useState(false);
  // Each dialog instance must resolve exactly once. Radix fires `onOpenChange`
  // in ADDITION to our button handlers, which previously double-/triple-invoked
  // onConfirm/onCancel (and even fired onCancel after a confirm). The
  // navigation guard relies on these callbacks resolving its blocker promise,
  // so a stray extra call made the "Discard changes?" flow misbehave.
  const settledRef = React.useRef(false);

  const confirm = React.useCallback((newOptions: ConfirmOptions) => {
    settledRef.current = false;
    setOptions(newOptions);
    setOpen(true);
  }, []);

  const handleConfirm = async () => {
    if (!options || settledRef.current) return;
    settledRef.current = true;
    try {
      setLoading(true);
      await options.onConfirm();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  // Fire onCancel at most once, and never after a confirm has settled.
  const cancelOnce = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    options?.onCancel?.();
  };

  const handleCancel = () => {
    cancelOnce();
    setOpen(false);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={open}
        onOpenChange={(isOpen) => {
          if (isOpen) {
            setOpen(true);
            return;
          }
          // Block close attempts (Esc / overlay) while an async confirm runs.
          if (loading) return;
          // Closing without pressing an action button counts as a cancel.
          cancelOnce();
          setOpen(false);
        }}
      >
        <AlertDialogContent className="sm:max-w-[400px]">
          <AlertDialogHeader>
            {options?.variant === "destructive" && (
              <AlertDialogMedia className="rounded-full bg-destructive/10">
                <AlertTriangle className="size-5 text-destructive" />
              </AlertDialogMedia>
            )}
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description && (
              <AlertDialogDescription>
                {options.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={handleCancel}
              disabled={loading}
              autoFocus={options?.variant === "destructive"}
            >
              {options?.cancelText || "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleConfirm();
              }}
              disabled={loading}
              variant={
                options?.variant === "destructive" ? "destructive" : "soft"
              }
            >
              {loading ? "Please wait..." : options?.confirmText || "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConfirm() {
  const context = React.useContext(ConfirmContext);
  if (!context) {
    throw new Error("useConfirm must be used within a ConfirmDialogProvider");
  }
  return context;
}
