import React, { Suspense, lazy } from "react";
import { StoreProvider } from "./data/store.jsx";
import { AuthRoot } from "./auth/AuthRoot.jsx";
import { Loading } from "./auth/screens.jsx";
import { ChunkBoundary } from "./ui/ChunkBoundary.jsx";

// The chat application (pages, rail, icons they use) is its own chunk: the sign-in, register, verify and reset
// screens never download it, only a signed-in session does.
export const loadShell = () => import("./AppShell.jsx");
const Shell = lazy(loadShell);

export function App(props) {
  return (
    <AuthRoot {...props}>
      {(dataLayer, key) => (
        <StoreProvider key={key} dataLayer={dataLayer}>
          <ChunkBoundary>
            <Suspense fallback={<Loading />}>
              <Shell />
            </Suspense>
          </ChunkBoundary>
        </StoreProvider>
      )}
    </AuthRoot>
  );
}
