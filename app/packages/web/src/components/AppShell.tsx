"use client";

import { WebSidebar } from "./WebSidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <WebSidebar />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
