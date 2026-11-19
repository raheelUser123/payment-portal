"use client";

import { useEffect } from "react";

/**
 * Friendly error screen. After a new deployment, a page that was opened
 * earlier can submit to a form handler that no longer exists ("Server Action
 * not found"). In that case reload once automatically to get the new version.
 */
function isStaleDeployment(error: Error) {
  return /Server Action|Failed to find|ChunkLoadError|Loading chunk/i.test(error?.message ?? "");
}

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isStaleDeployment(error);
  useEffect(() => {
    if (!stale) return;
    try {
      if (sessionStorage.getItem("pp-reloaded") !== "1") {
        sessionStorage.setItem("pp-reloaded", "1");
        window.location.reload();
        return;
      }
      sessionStorage.removeItem("pp-reloaded");
    } catch {
      window.location.reload();
    }
  }, [stale]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold">{stale ? "This page was updated" : "Something went wrong"}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {stale
            ? "A new version of the portal was released while this page was open. Reload the page and submit the form again."
            : "An unexpected error occurred. Please try again."}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button className="btn-primary" onClick={() => window.location.reload()}>Reload page</button>
          {!stale && <button className="btn-secondary" onClick={() => reset()}>Try again</button>}
        </div>
        {error?.digest && <p className="mt-4 text-xs text-slate-400">Reference: {error.digest}</p>}
      </div>
    </main>
  );
}
