import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  XCircle,
} from "lucide-react";
import { Link, useSearch } from "@tanstack/react-router";
import { authService } from "@/api/auth";
import { AuthLayout } from "@/layouts/AuthLayout";

export const ResetPassword = () => {
  const { token } = useSearch({ strict: false }) as { token?: string };
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [notActivated, setNotActivated] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (!token) {
      setError("Invalid or missing reset token.");
      return;
    }

    setLoading(true);

    try {
      await authService.resetPassword({ token, new_password: password });
      setSuccess(true);
    } catch (err: unknown) {
      const detail = (
        err as { response?: { data?: { detail?: string; code?: string } } }
      )?.response?.data;
      if (detail?.code === "ACCOUNT_NOT_ACTIVATED") {
        // Unactivated account — Forgot Password won't help; they need a (re)activation link.
        setNotActivated(true);
      } else {
        // Expired or otherwise invalid reset token → route to Forgot Password.
        setLinkInvalid(true);
      }
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <AuthLayout
        title="Password reset"
        description="Your password has been updated. You can now sign in with your new password."
        headerIcon={
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-50 dark:bg-green-950/30">
            <CheckCircle2 className="h-6 w-6 text-badge-active-text" />
          </div>
        }
      >
        <Link to="/login" className="block">
          <Button className="h-11 w-full">Go to sign in</Button>
        </Link>
      </AuthLayout>
    );
  }

  if (notActivated) {
    return (
      <AuthLayout
        title="Account not activated"
        description="Your account hasn't been activated yet, so the password can't be reset. Please contact your administrator to resend your activation email."
        headerIcon={
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <XCircle className="h-6 w-6 text-destructive" />
          </div>
        }
      >
        <Link to="/login" className="block">
          <Button className="h-11 w-full">Back to sign in</Button>
        </Link>
      </AuthLayout>
    );
  }

  if (!token || linkInvalid) {
    return (
      <AuthLayout
        title="Invalid or expired link"
        description="This password reset link is invalid or has expired. Request a new one to continue."
        headerIcon={
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <XCircle className="h-6 w-6 text-destructive" />
          </div>
        }
      >
        <Link to="/forgot-password" className="block">
          <Button className="h-11 w-full">Request new link</Button>
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Set a new password"
      description="Choose a strong password with at least 8 characters."
      footerSlot={
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="space-y-3">
          <label
            htmlFor="password"
            className="text-sm font-medium text-foreground"
          >
            New password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-icon" />
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="h-11 pl-9 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
              tabIndex={-1}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
        <div className="space-y-3">
          <label
            htmlFor="confirmPassword"
            className="text-sm font-medium text-foreground"
          >
            Confirm password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-icon" />
            <Input
              id="confirmPassword"
              type={showConfirmPassword ? "text" : "password"}
              placeholder="Re-enter your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="h-11 pl-9 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
              tabIndex={-1}
              aria-label={
                showConfirmPassword ? "Hide password" : "Show password"
              }
            >
              {showConfirmPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
        <Button type="submit" className="h-11 w-full" disabled={loading}>
          <KeyRound />
          {loading ? "Resetting…" : "Reset password"}
        </Button>
      </form>
    </AuthLayout>
  );
};
