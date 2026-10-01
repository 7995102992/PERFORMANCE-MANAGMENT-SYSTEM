import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/PageHeader";
import { Building2, Bell, ShieldCheck, Palette, Heart } from "lucide-react";
import { cn } from "@/lib/utils";

const SETTINGS_SECTIONS = [
  {
    icon: Building2,
    title: "Organisation Profile",
    description: "Manage your organisation name, logo, and contact details.",
  },
  {
    icon: ShieldCheck,
    title: "Security & Access",
    description: "Configure password policies and session timeouts.",
  },
  {
    icon: Bell,
    title: "Notifications",
    description: "Choose how and when your team gets notified.",
  },
  {
    icon: Palette,
    title: "Appearance",
    description: "Personalise theme and display preferences.",
  },
];

// A different one fires every time. Workplace-flavoured, mildly chaotic.
const GAGS = [
  { emoji: "🕺", line: "You held that button so long, HR scheduled a 1:1 about it." },
  { emoji: "🏆", line: "Achievement Unlocked: Professional Button Holder. Put it on your résumé." },
  { emoji: "☕", line: "motivation.exe has stopped responding. Reboot with coffee." },
  { emoji: "💔", line: "You held the heart so long it caught feelings. Now it's awkward." },
  { emoji: "🦥", line: "Congrats! You just spent 1.5 seconds achieving absolutely nothing. Bold move." },
  { emoji: "📧", line: "Your reward: a meeting that could have been an email." },
  { emoji: "🐢", line: "Loading personality… please hold. Oh wait — you already did." },
  { emoji: "🌱", line: "Surprise! There are no real settings here. Go touch grass." },
  { emoji: "🤖", line: "Beep boop. This easter egg is contractually obligated to make you smile." },
  { emoji: "🫠", line: "You found the secret. Sadly, your timesheet is still due." },
  { emoji: "🎯", line: "Plot twist: the real settings were the friends we made along the way." },
  { emoji: "🔥", line: "Warning: extreme productivity detected. Just kidding, it's Friday." },
  { emoji: "🧘", line: "Take a deep breath. Now exhale. Great — that's your wellness benefit used up." },
  { emoji: "📈", line: "Your performance review just went up 0.2%. The board is ecstatic." },
  { emoji: "🦸", line: "With great button-holding comes great responsibility. Use it wisely." },
  { emoji: "🐒", line: "404: Productivity not found. But hey, you found this, so… balance." },
  { emoji: "🍕", line: "There's no pizza in the break room. This message is your consolation prize." },
  { emoji: "👻", line: "This easter egg will deny everything in standup tomorrow." },
  { emoji: "🪑", line: "Fun fact: you've been sitting long enough to legally count as furniture." },
  { emoji: "📅", line: "Your calendar is 'busy', but we both know what that meeting really is." },
  { emoji: "🧠", line: "Big brain move. Sadly, it does not unlock a pay raise. We tried." },
  { emoji: "🚀", line: "To infinity and beyond! …or just lunch. Lunch is also fine." },
  { emoji: "🤫", line: "Don't tell the other tabs, but you're our favourite user." },
  { emoji: "🦆", line: "Rubber duck says: the bug was you all along. (Just kidding. Mostly.)" },
  { emoji: "🎢", line: "Mondays are a social construct. Unfortunately, so is your deadline." },
  { emoji: "🐙", line: "Multitasking like an octopus? Adorable. Now do one thing well." },
  { emoji: "🛟", line: "Reminder: you are not behind. Everyone else is also faking it." },
  { emoji: "🥷", line: "Stealth productivity engaged. Nobody will ever know you read this instead." },
];

const HOLD_MS = 1500;

const BURST_EMOJI = ["💜", "💖", "💗", "✨", "💙", "💛"];

const KONAMI = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
];

const OrganisationSettings = () => {
  const [holding, setHolding] = useState(false);
  const [gag, setGag] = useState<(typeof GAGS)[number] | null>(null);
  const [gravity, setGravity] = useState(false);
  const [hearts, setHearts] = useState<
    { id: number; dx: number; emoji: string }[]
  >([]);
  const [flyby, setFlyby] = useState(false);
  const timerRef = useRef<number | null>(null);
  const lastIdx = useRef(-1);
  const heartId = useRef(0);
  const flybyTimer = useRef<number | null>(null);
  const konamiProgress = useRef(0);

  // Secret: triple-click the "Settings" title → gravity mode.
  const clickCount = useRef(0);
  const clickTimer = useRef<number | null>(null);
  const gravityTimer = useRef<number | null>(null);

  const triggerGravity = () => {
    if (gravity) return;
    setGravity(true);
    gravityTimer.current = window.setTimeout(() => setGravity(false), 2200);
  };

  const handleSecretClick = () => {
    clickCount.current += 1;
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      clickCount.current = 0;
    }, 600);
    if (clickCount.current >= 3) {
      clickCount.current = 0;
      triggerGravity();
    }
  };

  const cardStyle = (i: number): CSSProperties => ({
    transitionDelay: `${i * 70}ms`,
    transform: gravity
      ? `translateY(${58 + (i % 2) * 10}vh) translateX(${(i % 2 ? 1 : -1) * (30 + i * 22)}px) rotate(${(i % 2 ? 1 : -1) * (12 + i * 7)}deg)`
      : "translateY(0) translateX(0) rotate(0deg)",
  });

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const pickGag = () => {
    let idx = Math.floor(Math.random() * GAGS.length);
    if (GAGS.length > 1 && idx === lastIdx.current) {
      idx = (idx + 1) % GAGS.length;
    }
    lastIdx.current = idx;
    return GAGS[idx];
  };

  const startHold = () => {
    setHolding(true);
    timerRef.current = window.setTimeout(() => {
      setHolding(false);
      timerRef.current = null;
      setGag(pickGag());
    }, HOLD_MS);
  };

  // Released before the hold completes → it was a quick tap → heart burst.
  const endHold = () => {
    const wasTap = timerRef.current !== null;
    cancelHold();
    if (wasTap) burstHearts();
  };

  const cancelHold = () => {
    setHolding(false);
    clearTimer();
  };

  const burstHearts = () => {
    const batch = Array.from({ length: 8 }, () => ({
      id: heartId.current++,
      dx: Math.round((Math.random() - 0.5) * 70),
      emoji: BURST_EMOJI[Math.floor(Math.random() * BURST_EMOJI.length)],
    }));
    setHearts((prev) => [...prev, ...batch]);
    const ids = new Set(batch.map((h) => h.id));
    window.setTimeout(
      () => setHearts((prev) => prev.filter((h) => !ids.has(h.id))),
      1200,
    );
  };

  const launchRocket = () => {
    if (flyby) return;
    setFlyby(true);
    flybyTimer.current = window.setTimeout(() => setFlyby(false), 1700);
  };

  useEffect(
    () => () => {
      clearTimer();
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
      if (gravityTimer.current !== null)
        window.clearTimeout(gravityTimer.current);
      if (flybyTimer.current !== null) window.clearTimeout(flybyTimer.current);
    },
    [],
  );

  // Secret: Konami code → rocket fly-by.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === KONAMI[konamiProgress.current]) {
        konamiProgress.current += 1;
        if (konamiProgress.current === KONAMI.length) {
          konamiProgress.current = 0;
          launchRocket();
        }
      } else {
        konamiProgress.current = key === KONAMI[0] ? 1 : 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flyby]);

  useEffect(() => {
    if (!gag) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setGag(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gag]);

  return (
    <div
      className={cn(
        "space-y-6 max-w-4xl mx-auto",
        gravity && "overflow-hidden",
      )}
    >
      <div onClick={handleSecretClick}>
        <PageHeader
          title="Settings"
          subtitle="Manage your organisation preferences and configuration."
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SETTINGS_SECTIONS.map(({ icon: Icon, title, description }, i) => (
          <div
            key={title}
            className="will-change-transform transition-transform duration-[900ms] [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]"
            style={cardStyle(i)}
          >
            <Card>
              <CardContent className="pt-6 flex items-start gap-4">
                <div className="rounded-xl bg-primary/10 p-3 shrink-0">
                  <Icon className="size-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    {title}
                  </h3>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {description}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>

      {/* Quiet footer — tap the heart for a burst, hold it for a surprise */}
      <div className="flex items-center justify-center pt-4 pb-2 text-xs text-muted-foreground/70 select-none">
        <span>made by the Sentrifugo team</span>
        <span className="relative ml-1.5 inline-flex">
          <button
            type="button"
            aria-label="Sentrifugo"
            onPointerDown={startHold}
            onPointerUp={endHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
            onContextMenu={(e) => e.preventDefault()}
            className="inline-flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-full p-1"
          >
            <Heart
              className={cn(
                "size-3.5 transition-all ease-out",
                holding
                  ? "scale-[1.8] text-primary drop-shadow-[0_0_6px_var(--primary)]"
                  : "text-muted-foreground/60",
              )}
              style={{ transitionDuration: holding ? `${HOLD_MS}ms` : "300ms" }}
              fill={holding ? "currentColor" : "none"}
            />
          </button>

          {/* tap burst */}
          {hearts.map((h) => (
            <span
              key={h.id}
              className="pointer-events-none absolute left-1/2 top-0 text-sm animate-egg-float"
              style={{ marginLeft: `${h.dx}px` }}
            >
              {h.emoji}
            </span>
          ))}
        </span>
      </div>

      {/* Konami rocket fly-by */}
      {flyby && (
        <div className="pointer-events-none fixed inset-0 z-[100] overflow-hidden">
          <div className="absolute top-1/3 left-0 animate-egg-flyby whitespace-nowrap">
            <span className="text-5xl">💨💨🚀</span>
            <span className="ml-3 align-super text-sm font-bold text-primary">
              wheeee!
            </span>
          </div>
        </div>
      )}

      {/* Easter egg reveal — animated, different every time */}
      {gag && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setGag(null)}
        >
          <div
            className="relative mx-4 max-w-md rounded-3xl border bg-card px-10 py-12 text-center shadow-2xl ring-1 ring-primary/15 animate-egg-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-7xl leading-none animate-egg-wiggle inline-block">
              {gag.emoji}
            </div>
            <p className="mt-7 text-lg font-semibold leading-relaxed text-foreground">
              {gag.line}
            </p>
            <p className="mt-6 text-xs uppercase tracking-widest text-muted-foreground/70">
              hold again for another
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default OrganisationSettings;
