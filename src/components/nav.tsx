"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The four screens, in the order the work happens. */
const LINKS = [
  { href: "/", label: "Documents" },
  { href: "/facts", label: "Facts" },
  { href: "/findings", label: "Findings" },
  { href: "/quality", label: "Quality" },
];

/**
 * Primary navigation.
 *
 * The current screen is marked three ways — filled background, bolder weight,
 * and `aria-current` — because on a projector or a poor screen a single tint is
 * not enough to answer "where am I?".
 */
export function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-8 gap-y-3 px-6 py-3.5">
        <Link href="/" className="text-sm font-semibold tracking-tight text-ink">
          Fact Knowledge Layer
        </Link>

        <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
          {LINKS.map((link) => {
            const active =
              link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white"
                    : "rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-accent-soft hover:text-ink"
                }
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
