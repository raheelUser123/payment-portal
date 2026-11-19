"use client";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const stale = /Server Action|Failed to find|ChunkLoadError|Loading chunk/i.test(error?.message ?? "");
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f6f7f9", display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", margin: 0 }}>
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 32, maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, margin: 0 }}>{stale ? "This page was updated" : "Something went wrong"}</h1>
          <p style={{ color: "#475569", fontSize: 14 }}>{stale ? "Please reload the page and try again." : "Please reload the page and try again."}</p>
          <button onClick={() => window.location.reload()} style={{ background: "#4f46e5", color: "#fff", border: 0, borderRadius: 8, padding: "10px 16px", cursor: "pointer" }}>Reload page</button>
        </div>
      </body>
    </html>
  );
}
