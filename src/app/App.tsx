import { AppShell } from "@/components/layout/AppShell";
import { Providers } from "@/app/Providers";

export function App() {
  return (
    <Providers>
      <AppShell />
    </Providers>
  );
}
