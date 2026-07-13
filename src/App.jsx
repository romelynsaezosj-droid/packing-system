import React, { useState, useMemo, useEffect, useCallback } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { supabase } from "./supabaseClient";

// Persists a value to localStorage so it survives a page refresh. Only
// used for `session` now — which device is currently signed in as whom
// is inherently per-device, unlike accounts/gates/items, which live in
// Supabase and are shared across every device.
function usePersistentState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage full or unavailable, ignore
    }
  }, [key, value]);

  return [value, setValue];
}

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

// Fetches accounts_public (id/username/role — never a password) and
// refetches after any account mutation. No realtime subscription here:
// account changes are rare admin actions, so a manual refresh after
// add/remove/role-change is enough.
function useAccounts() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from("accounts_public")
      .select("*")
      .order("created_at");
    setAccounts(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { accounts, loading, refresh };
}

// Start of the local calendar day, as an ISO string for timestamptz
// comparisons in Supabase queries.
function todayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Today's dashboard numbers via count-only queries (head: true returns
// no rows, just the count). The tables hold thousands of rows per day
// and Supabase caps plain selects at 1000 rows anyway — the app must
// never assume it can download the whole warehouse into the browser.
function useTodayStats() {
  const [stats, setStats] = useState({ total: 0, completed: 0, packed: 0 });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const since = todayStartIso();
    const [totalRes, completedRes, packedRes] = await Promise.all([
      supabase.from("gates").select("*", { count: "exact", head: true }).gte("created_at", since),
      supabase
        .from("gates")
        .select("*", { count: "exact", head: true })
        .gte("created_at", since)
        .not("closed_at", "is", null),
      supabase.from("items").select("*", { count: "exact", head: true }).gte("packed_at", since),
    ]);
    setStats({
      total: totalRes.count ?? 0,
      completed: completedRes.count ?? 0,
      packed: packedRes.count ?? 0,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();

    // Realtime keeps the dashboard live: a packer's confirm anywhere
    // bumps these counts without a manual refresh. Count queries are
    // cheap, so refreshing on every change is fine.
    const channel = supabase
      .channel("dashboard-stats")
      .on("postgres_changes", { event: "*", schema: "public", table: "gates" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, refresh)
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [refresh]);

  return { stats, loading };
}

export default function PackingSystem() {
  const [session, setSession] = usePersistentState("packing_session", null); // { id, username, role } — this device only
  const [view, setView] = useState(() =>
    session ? (session.role === "admin" ? "dash" : "scan") : "dash"
  );

  const { accounts, refresh: refreshAccounts } = useAccounts();

  const isAdmin = session?.role === "admin";

  // If an admin removed this account elsewhere, drop the stale session.
  useEffect(() => {
    if (session && accounts.length > 0 && !accounts.some((a) => a.id === session.id)) {
      setSession(null);
    }
  }, [session, accounts]);

  async function handleLogin(username, password) {
    try {
      const { data, error } = await supabase.rpc("login", {
        p_username: username.trim(),
        p_password: password,
      });
      if (error || !data || data.length === 0) {
        return { ok: false, error: "Incorrect username or password." };
      }
      const acc = data[0];
      setSession(acc);
      setView(acc.role === "admin" ? "dash" : "scan");
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
    }
  }

  if (!session) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <Shell
      session={session}
      isAdmin={isAdmin}
      view={view}
      setView={setView}
      onLogout={() => setSession(null)}
    >
      {view === "dash" && isAdmin && <Dashboard />}
      {view === "upload" && isAdmin && <GateUpload />}
      {view === "scan" && <PackingMode currentUser={session.username} />}
      {view === "logs" && isAdmin && <Logs />}
      {view === "accounts" && isAdmin && (
        <Accounts
          accounts={accounts}
          currentSessionId={session.id}
          refreshAccounts={refreshAccounts}
        />
      )}
      {!isAdmin && view !== "scan" && (
        <div className="card">
          <p className="title">Packers only have access to packing.</p>
          <p className="muted">Switch to the packing tab to scan and confirm items.</p>
        </div>
      )}
    </Shell>
  );
}

/* ---------------- LOGIN ---------------- */

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const result = await onLogin(username, password);
    setSubmitting(false);
    setError(result.ok ? "" : result.error);
  }

  return (
    <div style={styles.loginWrap}>
      <style>{baseCss}</style>
      <form className="card" style={styles.loginCard} onSubmit={submit}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={styles.logoMark} />
          <div>
            <p className="title" style={{ margin: 0 }}>Packing system</p>
            <p className="muted" style={{ margin: 0 }}>Sign in to continue</p>
          </div>
        </div>

        <label className="field-label">Username</label>
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="admin"
        />

        <label className="field-label">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />

        {error && <p className="error-text">{error}</p>}

        <button
          type="submit"
          className="btn-primary"
          style={{ width: "100%", marginTop: 8 }}
          disabled={submitting}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/* ---------------- SHELL ---------------- */

function Shell({ session, isAdmin, view, setView, onLogout, children }) {
  const navItems = isAdmin
    ? [
        { id: "dash", label: "Dashboard", icon: "▦" },
        { id: "upload", label: "Gate upload", icon: "⇪" },
        { id: "scan", label: "Packing", icon: "▣" },
        { id: "logs", label: "Logs", icon: "≡" },
        { id: "accounts", label: "Accounts", icon: "◔" },
      ]
    : [{ id: "scan", label: "Packing", icon: "▣" }];

  return (
    <div className="app">
      <style>{baseCss}</style>
      <header className="app-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={styles.logoMark} />
          <strong>Packing system</strong>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="muted">
            {session.username} · <span className={isAdmin ? "tag-admin" : "tag-packer"}>{session.role}</span>
          </span>
          <button className="btn-ghost" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <div className="app-body">
        <nav className="app-nav">
          {navItems.map((n) => (
            <button
              key={n.id}
              className={classNames("nav-btn", view === n.id && "nav-btn-active")}
              onClick={() => setView(n.id)}
            >
              <span className="nav-btn-icon">{n.icon}</span>
              <span className="nav-btn-label">{n.label}</span>
            </button>
          ))}
        </nav>
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}

/* ---------------- DASHBOARD ---------------- */

function Dashboard() {
  // Scoped to today only, so the dashboard resets each day instead of
  // accumulating forever. A gate keeps its original creation date even
  // if the same tracking number gets re-uploaded later (gates.tracking
  // is unique — re-importing merges into the existing row rather than
  // creating a new one), so re-uploading never inflates today's count.
  const { stats, loading } = useTodayStats();
  const pending = stats.total - stats.completed;

  return (
    <div>
      <p className="title">Dashboard</p>
      <p className="muted" style={{ marginTop: -8, marginBottom: 14 }}>
        Today's activity — resets each day
      </p>
      <div className="stats-grid">
        <Stat label="Total gates" value={stats.total} />
        <Stat label="Completed" value={stats.completed} />
        <Stat label="Pending" value={pending} />
        <Stat label="Log entries" value={stats.packed} />
      </div>

      {loading && (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted">Loading…</p>
        </div>
      )}

      {!loading && stats.total === 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted">No gates uploaded today yet.</p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
    </div>
  );
}

/* ---------------- GATE UPLOAD (admin only) ---------------- */

function GateUpload() {
  const [text, setText] = useState("");
  const [message, setMessage] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleImport() {
    // Split on line breaks only — don't trim the whole block, since a
    // trailing tab on the last row (an intentionally empty last column,
    // e.g. no barcode) is meaningful and trim() would silently eat it,
    // turning a valid row into a "malformed" one.
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      setMessage({ type: "error", text: "Paste some tab-separated rows first." });
      return;
    }

    const rows = [];
    let skippedRows = 0;

    lines.forEach((line) => {
      const c = line.split("\t");
      if (c.length < 8) {
        skippedRows++;
        return;
      }
      const tracking = (c[0] || "").trim();
      if (!tracking) {
        skippedRows++;
        return;
      }
      rows.push({
        tracking,
        sku: (c[1] || "").trim(),
        name: (c[2] || "").trim(),
        qty: Number(c[3]) || 0,
        image: (c[6] || "").trim(),
        barcode: (c[7] || "").trim(),
      });
    });

    if (rows.length === 0) {
      setMessage({ type: "error", text: "No valid rows found." });
      return;
    }

    // Send in chunks: a single RPC call with thousands of rows can hit
    // the database's statement timeout, and each RPC is transactional —
    // so chunking means a failure partway loses only that chunk, and we
    // can tell the admin exactly which rows still need re-pasting.
    const CHUNK = 500;
    setSubmitting(true);

    let importedRows = 0;
    let mergedSkipped = 0;

    for (let offset = 0; offset < rows.length; offset += CHUNK) {
      const chunk = rows.slice(offset, offset + CHUNK);
      setMessage({ type: "success", text: `Importing… ${offset}/${rows.length}` });

      const { data, error } = await supabase.rpc("import_gate_rows", { p_rows: chunk });

      if (error) {
        setSubmitting(false);
        setMessage({
          type: "error",
          text:
            `Import failed after ${importedRows} of ${rows.length} rows ` +
            `(${error.message || "unknown error"}). The first ${importedRows} rows were saved — ` +
            `re-paste only the remaining rows to finish, or you'll double-count quantities.`,
        });
        return;
      }

      const result = data?.[0] || {};
      importedRows += result.imported ?? chunk.length;
      mergedSkipped += result.skipped ?? 0;
    }

    setSubmitting(false);

    const totalSkipped = skippedRows + mergedSkipped;
    setMessage({
      type: "success",
      text: `Imported ${importedRows} row${importedRows === 1 ? "" : "s"}.${
        totalSkipped ? ` Skipped ${totalSkipped} malformed row${totalSkipped === 1 ? "" : "s"}.` : ""
      }`,
    });

    setText("");
  }

  return (
    <div>
      <p className="title">Gate upload</p>
      <p className="muted" style={{ marginBottom: 12 }}>
        Paste tab-separated rows: tracking, sku, name, qty, col5, col6, image url, barcode.
      </p>
      <div className="card">
        <textarea
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"GATE001\\tSKU-1\\tBlue Jacket\\t4\\t-\\t-\\thttps://...\\tBARCODE123"}
        />
        <button className="btn-primary" style={{ marginTop: 10 }} onClick={handleImport} disabled={submitting}>
          {submitting ? "Importing…" : "Import"}
        </button>
        {message && (
          <p className={message.type === "error" ? "error-text" : "success-text"}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------- PACKING MODE (everyone) ---------------- */

function PackingMode({ currentUser }) {
  const [track, setTrack] = useState("");
  const [gate, setGate] = useState(null); // { tracking, closedAt, items } — fetched on demand
  const [statusMsg, setStatusMsg] = useState(null); // { type: 'error'|'info', text }
  const [loadingGate, setLoadingGate] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);

  // Fetch just this gate's unpacked items. The warehouse holds far more
  // gates than Supabase's 1000-row select cap (and than a phone should
  // download), so gates are looked up individually by tracking number
  // rather than kept in one big in-memory map.
  async function fetchGateItems(tracking) {
    const { data, error } = await supabase
      .from("items")
      .select("*")
      .eq("gate_tracking", tracking)
      .is("packed_at", null)
      .order("created_at");
    if (error) throw error;
    return (data || []).map((it) => ({
      id: it.id,
      sku: it.sku,
      name: it.name,
      qty: it.qty,
      image: it.image,
      barcode: it.barcode,
    }));
  }

  async function tryLoadGate(rawValue) {
    const t = (rawValue ?? track).trim();
    if (!t || loadingGate) return;

    setLoadingGate(true);
    try {
      const { data: g, error } = await supabase
        .from("gates")
        .select("*")
        .eq("tracking", t)
        .maybeSingle();
      if (error) throw error;

      if (!g) {
        setStatusMsg({ type: "error", text: `No gate found for waybill "${t}".` });
        setGate(null);
        return;
      }

      if (g.closed_at) {
        setStatusMsg({
          type: "error",
          text: `Waybill "${t}" was already packed and confirmed on ${new Date(g.closed_at).toLocaleString()}. Duplicate scans aren't allowed.`,
        });
        setGate(null);
        return;
      }

      const items = await fetchGateItems(t);
      setStatusMsg(null);
      setGate({ tracking: t, closedAt: g.closed_at, items });
      setTrack(t);
    } catch {
      setStatusMsg({ type: "error", text: "Couldn't load that gate — check your connection and try again." });
      setGate(null);
    } finally {
      setLoadingGate(false);
    }
  }

  async function confirmItem(itemId) {
    if (!gate) return;

    // `.is("packed_at", null)` guards against confirming the same item
    // twice under a race (e.g. a double click, or two devices touching
    // the same item) — only the first update actually matches a row.
    const { error } = await supabase
      .from("items")
      .update({ packed_at: new Date().toISOString(), packed_by: currentUser })
      .eq("id", itemId)
      .is("packed_at", null);

    if (error) {
      setStatusMsg({ type: "error", text: "Couldn't confirm that item — check your connection and try again." });
      return;
    }

    // Refetch from the server rather than filtering locally, so a
    // concurrent change from another device is reflected too.
    try {
      const items = await fetchGateItems(gate.tracking);
      setGate((prev) => (prev ? { ...prev, items } : prev));
    } catch {
      setGate((prev) =>
        prev ? { ...prev, items: prev.items.filter((i) => i.id !== itemId) } : prev
      );
    }
  }

  return (
    <div>
      <p className="title">Packing mode</p>
      <div className="card load-gate-bar">
        <input
          style={{ margin: 0 }}
          value={track}
          onChange={(e) => setTrack(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && tryLoadGate()}
          placeholder="Enter or scan waybill / tracking number"
        />
        <div className="load-gate-actions">
          <button className="btn-primary" style={{ flex: 1 }} onClick={() => tryLoadGate()} disabled={loadingGate}>
            {loadingGate ? "Loading…" : "Load gate"}
          </button>
          <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setScannerOpen(true)}>
            📷 Scan
          </button>
        </div>
      </div>

      {scannerOpen && (
        <BarcodeScanner
          onDetected={(value) => {
            setScannerOpen(false);
            tryLoadGate(value);
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}

      {statusMsg && (
        <div className="card">
          <p
            className={statusMsg.type === "error" ? "error-text" : "success-text"}
            style={{ margin: 0 }}
          >
            {statusMsg.text}
          </p>
        </div>
      )}

      {gate && (
        <div style={{ marginTop: 12 }}>
          <div className="card gate-header-bar">
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>Gate: {gate.tracking}</p>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                {gate.items.length} item{gate.items.length === 1 ? "" : "s"} remaining
              </p>
            </div>
          </div>

          {gate.items.length === 0 && (
            <div className="card">
              <p className="success-text" style={{ margin: 0 }}>All items packed for this gate.</p>
            </div>
          )}

          {gate.items.map((i) => (
            <div key={i.id} className="card item-row">
              {i.image ? (
                <img
                  src={i.image}
                  alt={i.name}
                  onClick={() => setPreviewImage(i.image)}
                  style={{ cursor: "zoom-in" }}
                />
              ) : (
                <div className="item-img-fallback">No image</div>
              )}
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontWeight: 600 }}>{i.name || "Unnamed item"}</p>
                <p className="muted" style={{ margin: "2px 0" }}>{i.sku}</p>
                <p className="muted" style={{ margin: "2px 0" }}>Barcode: {i.barcode || "—"}</p>
                <p className="item-qty">Qty: {i.qty}</p>
              </div>
              <button className="btn-primary" onClick={() => confirmItem(i.id)}>
                Confirm
              </button>
            </div>
          ))}
        </div>
      )}

      {previewImage && (
        <div className="image-lightbox" onClick={() => setPreviewImage(null)}>
          <img src={previewImage} alt="" />
        </div>
      )}
    </div>
  );
}

/* ---------------- CAMERA BARCODE SCANNER ---------------- */
// Uses the device camera + the bundled ZXing library to scan a waybill
// barcode/QR code and feed the decoded text straight into tryLoadGate,
// as if it were typed in.

function BarcodeScanner({ onDetected, onClose }) {
  const videoRef = React.useRef(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const controlsRef = React.useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const reader = new BrowserMultiFormatReader();

        const controls = await reader.decodeFromVideoDevice(
          undefined, // let the browser pick the back/default camera
          videoRef.current,
          (result, err) => {
            if (result) {
              controls.stop();
              onDetected(result.getText());
            }
          }
        );
        controlsRef.current = controls;
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) {
          setError(
            e?.name === "NotAllowedError"
              ? "Camera access was blocked. Allow camera permission and try again."
              : "Couldn't start the camera. Check your device has one and try again."
          );
        }
      }
    }

    start();

    return () => {
      cancelled = true;
      if (controlsRef.current) controlsRef.current.stop();
    };
  }, []);

  return (
    <div className="card scanner-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <p style={{ margin: 0, fontWeight: 600 }}>Scan waybill</p>
        <button className="btn-ghost" onClick={onClose}>Close</button>
      </div>

      {error ? (
        <p className="error-text">{error}</p>
      ) : (
        <>
          <div className="scanner-frame">
            <video ref={videoRef} className="scanner-video" muted playsInline />
            <div className="scanner-reticle">
              <div className="scanner-line" />
            </div>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            {ready ? "Point the camera at the waybill barcode." : "Starting camera…"}
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------- LOGS (admin only) ---------------- */

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const LOGS_PAGE_SIZE = 300;

function Logs() {
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Filters run in the database, not the browser: with thousands of
  // packed items per day (and Supabase's 1000-row select cap), the
  // full log history can't be downloaded wholesale.
  const buildQuery = useCallback(() => {
    let q = supabase
      .from("items")
      .select("*")
      .not("packed_at", "is", null)
      .order("packed_at", { ascending: false });

    if (dateFilter) {
      const [y, m, d] = dateFilter.split("-").map(Number);
      const start = new Date(y, m - 1, d);
      const end = new Date(y, m - 1, d + 1);
      q = q.gte("packed_at", start.toISOString()).lt("packed_at", end.toISOString());
    }

    const term = search.trim().replace(/[,()]/g, "");
    if (term) {
      q = q.or(
        `gate_tracking.ilike.%${term}%,name.ilike.%${term}%,sku.ilike.%${term}%,packed_by.ilike.%${term}%`
      );
    }

    return q;
  }, [search, dateFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Small debounce so typing in the search box doesn't fire a query
    // per keystroke.
    const timer = setTimeout(async () => {
      const { data } = await buildQuery().limit(LOGS_PAGE_SIZE);
      if (!cancelled) {
        setRows(data || []);
        setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [buildQuery]);

  const filtered = rows.map((it) => ({
    id: it.id,
    gate: it.gate_tracking,
    item: it.name,
    sku: it.sku,
    user: it.packed_by,
    time: new Date(it.packed_at).toLocaleString(),
  }));

  async function exportCsv() {
    setExporting(true);
    try {
      // Page through everything matching the current filters — the
      // on-screen list is capped, but the export must be complete.
      const all = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await buildQuery().range(from, from + PAGE - 1);
        if (error) throw error;
        all.push(...(data || []));
        if (!data || data.length < PAGE) break;
      }

      const header = ["Gate", "Item", "SKU", "User", "Time"];
      const csvRows = all.map((it) => [
        it.gate_tracking,
        it.name,
        it.sku,
        it.packed_by,
        new Date(it.packed_at).toLocaleString(),
      ]);
      const csv = [header, ...csvRows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `packing-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // leave the current view untouched; the button re-enables
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <p className="title">Packing logs</p>

      <div className="card" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          style={{ flex: "2 1 200px", margin: 0 }}
          placeholder="Search gate, item, SKU, or user"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn-ghost" onClick={() => setScannerOpen(true)}>📷 Scan</button>
        <input
          type="date"
          style={{ flex: "1 1 150px", margin: 0 }}
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
        />
        {dateFilter && (
          <button className="btn-ghost" onClick={() => setDateFilter("")}>Clear date</button>
        )}
        <button className="btn-primary" onClick={exportCsv} disabled={exporting || filtered.length === 0}>
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      {scannerOpen && (
        <BarcodeScanner
          onDetected={(value) => {
            setScannerOpen(false);
            setSearch(value.trim());
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}

      {loading && (
        <div className="card"><p className="muted">Loading…</p></div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="card"><p className="muted">No matching log entries.</p></div>
      )}
      {!loading && rows.length === LOGS_PAGE_SIZE && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Showing the latest {LOGS_PAGE_SIZE} matching entries. Narrow the search or date
            filter, or use Export CSV to get the complete list.
          </p>
        </div>
      )}
      {filtered.map((l) => (
        <div key={l.id} className="card" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{l.gate} · {l.item} <span className="muted">({l.sku})</span></span>
          <span className="muted">{l.user} · {l.time}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- ACCOUNTS (admin only) ---------------- */

function Accounts({ accounts, currentSessionId, refreshAccounts }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("packer");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function addAccount() {
    const u = username.trim();
    if (!u || !password.trim()) {
      setError("Username and password are required.");
      return;
    }
    if (accounts.some((a) => a.username.toLowerCase() === u.toLowerCase())) {
      setError("That username is already taken.");
      return;
    }

    setSubmitting(true);
    const { error: rpcError } = await supabase.rpc("create_account", {
      p_username: u,
      p_password: password,
      p_role: role,
    });
    setSubmitting(false);

    if (rpcError) {
      setError(
        rpcError.message?.includes("duplicate")
          ? "That username is already taken."
          : "Couldn't create account — check your connection and try again."
      );
      return;
    }

    setUsername("");
    setPassword("");
    setRole("packer");
    setError("");
    refreshAccounts();
  }

  async function removeAccount(id) {
    if (id === currentSessionId) return; // can't delete the account you're logged in as
    await supabase.rpc("remove_account", { p_id: id });
    refreshAccounts();
  }

  async function changeRole(id, newRole) {
    await supabase.rpc("set_account_role", { p_id: id, p_role: newRole });
    refreshAccounts();
  }

  return (
    <div>
      <p className="title">Accounts</p>

      <div className="card">
        <p style={{ marginTop: 0, fontWeight: 600 }}>Add account</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            style={{ flex: 1, minWidth: 160, margin: 0 }}
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            style={{ flex: 1, minWidth: 160, margin: 0 }}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            style={styles.select}
          >
            <option value="packer">Packer</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn-primary" onClick={addAccount} disabled={submitting}>
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>

      {accounts.map((a) => (
        <div key={a.id} className="card" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>
              {a.username} {a.id === currentSessionId && <span className="muted">(you)</span>}
            </p>
          </div>
          <select
            value={a.role}
            onChange={(e) => changeRole(a.id, e.target.value)}
            style={styles.select}
          >
            <option value="packer">Packer</option>
            <option value="admin">Admin</option>
          </select>
          <button
            className="btn-ghost"
            onClick={() => removeAccount(a.id)}
            disabled={a.id === currentSessionId}
            title={a.id === currentSessionId ? "You can't remove the account you're using" : "Remove account"}
          >
            Remove
          </button>
        </div>
      ))}

      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Data is stored in Supabase and synced live across every device signed in to this workspace.
        </p>
      </div>
    </div>
  );
}

/* ---------------- STYLES ---------------- */

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const styles = {
  loginWrap: {
    minHeight: "100vh",
    background: "#f1f5f9",
    color: "#0f172a",
    fontFamily: FONT_STACK,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    boxSizing: "border-box",
  },
  loginCard: { width: "100%", maxWidth: 360 },
  logoMark: {
    width: 28,
    height: 28,
    borderRadius: 8,
    background: "#2563eb",
  },
  select: {
    background: "#ffffff",
    color: "#0f172a",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    padding: "8px 10px",
  },
};

const baseCss = `
* { -webkit-tap-highlight-color: transparent; }
.app {
  min-height: 100vh;
  background: #f1f5f9;
  color: #0f172a;
  font-family: ${FONT_STACK};
}
.app-header {
  background: #ffffff;
  padding: 12px 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #e2e8f0;
  position: sticky;
  top: 0;
  z-index: 10;
}
.app-body { display: flex; min-height: calc(100vh - 49px); }
.app-nav {
  width: 220px;
  flex-shrink: 0;
  background: #ffffff;
  border-right: 1px solid #e2e8f0;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.app-main { flex: 1; min-width: 0; padding: 20px; overflow: auto; }
.nav-btn-icon { margin-right: 8px; }
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.load-gate-bar { display: flex; flex-direction: column; gap: 10px; }
.load-gate-actions { display: flex; gap: 10px; }
.gate-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
@media (max-width: 768px) {
  .app-body { flex-direction: column; min-height: 0; }
  .app-main { padding: 14px; padding-bottom: 84px; }
  .app-nav {
    width: 100%;
    flex-direction: row;
    justify-content: space-around;
    gap: 0;
    padding: 6px;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    border-top: 1px solid #e2e8f0;
    border-right: none;
    z-index: 10;
  }
  .nav-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 8px 4px;
    text-align: center;
    font-size: 11px;
  }
  .nav-btn-icon { margin-right: 0; font-size: 18px; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .load-gate-actions { flex-direction: column; }
  .gate-header-bar { flex-direction: column; align-items: stretch; }
  .item-row { flex-wrap: wrap; }
  button { min-height: 44px; }
}

.card {
  background: #ffffff;
  padding: 14px;
  margin: 10px 0;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.title { font-size: 20px; font-weight: 700; margin: 0 0 10px; color: #0f172a; }
.muted { font-size: 13px; color: #64748b; }
.field-label { font-size: 12px; color: #64748b; margin-top: 8px; display: block; }
input, textarea {
  width: 100%;
  padding: 10px;
  margin: 5px 0;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  color: #0f172a;
  border-radius: 6px;
  box-sizing: border-box;
  font-family: inherit;
}
input::placeholder, textarea::placeholder { color: #94a3b8; }
input:focus, textarea:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
button {
  padding: 10px 16px;
  border: none;
  cursor: pointer;
  font-weight: 600;
  border-radius: 6px;
}
.btn-primary { background: #2563eb; color: #ffffff; }
.btn-primary:hover { background: #1d4ed8; }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-ghost {
  background: #ffffff;
  color: #334155;
  border: 1px solid #cbd5e1;
}
.btn-ghost:hover { background: #f1f5f9; }
.btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.nav-btn {
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  background: transparent;
  color: #334155;
  border: none;
  border-radius: 6px;
  font-weight: 500;
}
.nav-btn:hover { background: #f1f5f9; }
.nav-btn-active { background: #2563eb; color: #ffffff; }
.stat-card {
  background: #ffffff;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.stat-label { font-size: 12px; color: #64748b; margin: 0; }
.stat-value { font-size: 24px; color: #2563eb; margin: 6px 0 0; font-weight: 700; }
.item-row { display: flex; gap: 12px; align-items: center; }
.item-row img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; flex-shrink: 0; border: 1px solid #e2e8f0; }
.item-img-fallback {
  width: 64px; height: 64px; border-radius: 8px; flex-shrink: 0;
  background: #f1f5f9; display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: #94a3b8; text-align: center; border: 1px solid #e2e8f0;
}
.item-qty { margin: 4px 0 0; font-size: 20px; font-weight: 700; color: #0f172a; }
.image-lightbox {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 100;
  cursor: zoom-out;
}
.image-lightbox img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 10px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
}
.error-text { color: #dc2626; font-size: 13px; margin: 8px 0 0; }
.success-text { color: #16a34a; font-size: 13px; margin: 8px 0 0; }
.tag-admin { color: #2563eb; font-weight: 600; }
.tag-packer { color: #d97706; font-weight: 600; }
.scanner-card { display: flex; flex-direction: column; }
.scanner-frame {
  position: relative;
  width: 100%;
  max-width: 280px;
  aspect-ratio: 5 / 2;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
  margin: 10px auto 0;
}
.scanner-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.scanner-reticle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 88%;
  height: 62%;
  transform: translate(-50%, -50%);
  border: 2px solid #2563eb;
  border-radius: 6px;
  box-shadow: 0 0 0 2000px rgba(0,0,0,0.25);
  display: flex;
  align-items: center;
}
.scanner-line {
  width: 100%;
  height: 2px;
  background: #ef4444;
  box-shadow: 0 0 4px rgba(239, 68, 68, 0.9);
}
`;
