"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Add more entries here as new sections get built — the bar lays them out
// automatically, no other changes needed.
const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: "🏠" },
  { href: "/whale-tracker", label: "Whale", icon: "🐋" },
  { href: "/ai-history", label: "Riwayat AI", icon: "🧠" }
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav">
      <div className="bottom-nav-bubble">
        {NAV_ITEMS.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={`bottom-nav-item${active ? " active" : ""}`}>
              <span className="bottom-nav-icon">{item.icon}</span>
              <span className="bottom-nav-label">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
