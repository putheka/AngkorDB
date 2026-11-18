import { QueryClient } from "@tanstack/react-query";

/** One shared client, so stores can drop cached data (e.g. when a connection closes). */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
