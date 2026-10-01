import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, LogIn, Mail, Lock, ShieldCheck } from "lucide-react";
import { useNavigate, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch } from "@/store";
import { setTokens, setUser } from "@/store/slices/auth-slice";
import { clearSavedOrganisation } from "@/store/slices/organisation-slice";
import { authService } from "@/api/auth";
import { AuthLayout } from "@/layouts/AuthLayout";
import { setRememberPreference } from "@/lib/cookies";

export const Login = () => {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);

  const handleLogin = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Record persistence choice before tokens are stored so the cookies
      // written on setTokens (and later refreshes) inherit it (7-day vs session).
      setRememberPreference(remember);
      const response = isSuperAdmin
        ? await authService.portalLogin({ email, password, remember })
        : await authService.login({ email, password, remember });

      dispatch(clearSavedOrganisation());
      queryClient.clear();
      dispatch(
        setTokens({
          token: response.access_token,
          refreshToken: response.refresh_token,
        }),
      );

      const me = await authService.getMe();
      dispatch(setUser(me));

      navigate({ to: me.is_super_admin ? "/super-admin" : "/" });
    } catch {
      setError("Invalid email or password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // const title = isSuperAdmin ? 'Super admin portal' : 'Welcome back'
  // const description = isSuperAdmin
  //   ? 'Sign in with your super admin credentials.'
  //   : 'Sign in to your Sentrifugo workspace.'

  return (
    <AuthLayout
      title=""
      /* title={title}
      description={description}
      footerSlot={
        <button
          type="button"
          onClick={() => { setIsSuperAdmin((v) => !v); setError('') }}
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          {isSuperAdmin ? 'Switch to organisation login' : 'Sign in as super admin'}
        </button>
      } */
    >
      <form onSubmit={handleLogin} className="space-y-5">
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="space-y-3">
          <label
            htmlFor="email"
            className="text-sm font-medium text-foreground"
          >
            Email
          </label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-icon" />
            <Input
              id="email"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="h-11 pl-9"
            />
          </div>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label
              htmlFor="password"
              className="text-sm font-medium text-foreground"
            >
              Password
            </label>
            <Link
              to="/forgot-password"
              className="text-sm font-medium text-primary hover:underline underline-offset-4"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-icon" />
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
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
        <label className="flex items-center gap-2 text-sm text-foreground select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={loading}
            className="size-4 rounded border-input accent-primary"
          />
          Remember me
        </label>
        <Button type="submit" className="h-11 w-full" disabled={loading}>
          <LogIn />
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
};
